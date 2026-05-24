import {
  buildConfigApplyResponse,
  buildConfigRemoveResponse,
  buildDiscoveryResponse,
  buildEventListResponse,
  buildLocalEventRecord,
  createRuntimeStarter,
  formatConfigApplyLog,
  normalizeDiscoveryInputs,
  scheduleTelemetryDelivery,
  TelemetryClient,
  type RuntimeEntity,
  type RuntimeRegistry,
} from "piphi-runtime-kit-node";

import {
  integrationId,
  integrationName,
  integrationVersion,
  manifestCapabilities,
  manifestCommands,
} from "./contract.js";
import {
  buildTelemetryMetrics,
  getVehicleData,
  getVehicleSummary,
  listVehicles,
  normalizeVehicleDataState,
  normalizeVehicleSummaryState,
  wakeVehicle,
} from "./tesla.js";
import type {
  DiscoverVehiclesOptions,
  TeslaCommandPayload,
  TeslaLocalEvent,
  TeslaRuntimeEntry,
  TeslaVehicleConfig,
  TeslaVehicleState,
} from "./types.js";

export const starter = createRuntimeStarter({
  integrationId,
  integrationName,
  version: integrationVersion,
});

export const registry = starter.registry as unknown as RuntimeRegistry<
  TeslaVehicleState,
  TeslaRuntimeEntry,
  TeslaLocalEvent
>;

function nowIso(): string {
  return new Date().toISOString();
}

function toEntry(config: TeslaVehicleConfig, state: TeslaVehicleState): TeslaRuntimeEntry {
  return {
    configId: config.configId ?? config.id,
    deviceId: state.deviceId,
    vin: config.vin,
    displayName: state.displayName,
    region: state.region,
    baseUrl: state.baseUrl,
    containerId: config.containerId ?? null,
    integrationId: config.integrationId ?? integrationId,
    config,
    latestState: state,
    lastUpdated: nowIso(),
  };
}

export function appendLocalEvent(values: {
  eventType: string;
  severity?: "debug" | "info" | "warning" | "error";
  deviceId?: string | null;
  configId?: string | null;
  payload?: Record<string, unknown>;
}): TeslaLocalEvent {
  return registry.appendEvent(
    buildLocalEventRecord({
      eventType: values.eventType,
      ts: nowIso(),
      severity: values.severity ?? "info",
      deviceId: values.deviceId ?? null,
      configId: values.configId ?? null,
      payload: values.payload ?? {},
    }),
  );
}

async function deliverTelemetry(state: TeslaVehicleState, containerId?: string | null): Promise<void> {
  const { metrics, units } = buildTelemetryMetrics(state);
  await scheduleTelemetryDelivery({
    processState: starter.runtime.processState,
    telemetryClient: new TelemetryClient({
      processState: starter.runtime.processState,
    }),
    authContext: starter.runtime.auth,
    deviceId: state.deviceId,
    containerId,
    metrics,
    units,
  });
}

export async function refreshEntry(configId: string): Promise<TeslaRuntimeEntry> {
  const entry = registry.get(configId);
  if (!entry) {
    throw new Error(`Unknown Tesla config: ${configId}`);
  }

  const summary = await getVehicleSummary(entry.config);
  const freshState = normalizeVehicleSummaryState(entry.config, summary);
  let nextState = freshState;

  if (summary.state === "online") {
    const vehicleData = await getVehicleData(entry.config);
    nextState = normalizeVehicleDataState(entry.config, summary, vehicleData);
  }

  registry.set(configId, {
    ...entry,
    displayName: nextState.displayName,
    latestState: nextState,
    lastUpdated: nowIso(),
  });
  registry.updateState(configId, nextState, nextState.deviceId);

  appendLocalEvent({
    eventType: "tesla.vehicle.refreshed",
    deviceId: nextState.deviceId,
    configId,
    payload: {
      vin: nextState.vin,
      vehicle_state: nextState.vehicleState,
      source: nextState.source,
    },
  });

  try {
    await deliverTelemetry(nextState, entry.containerId ?? null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const degradedState: TeslaVehicleState = {
      ...nextState,
      lastError: message,
    };
    registry.set(configId, {
      ...entry,
      displayName: degradedState.displayName,
      latestState: degradedState,
      lastUpdated: nowIso(),
    });
    registry.updateState(configId, degradedState, degradedState.deviceId);
    appendLocalEvent({
      eventType: "tesla.telemetry.delivery_failed",
      severity: "warning",
      deviceId: degradedState.deviceId,
      configId,
      payload: {
        message,
      },
    });
  }
  return registry.get(configId) ?? toEntry(entry.config, nextState);
}

export async function applyTeslaConfig(config: TeslaVehicleConfig): Promise<{
  response: ReturnType<typeof buildConfigApplyResponse>;
  entry: TeslaRuntimeEntry;
}> {
  if (!config.vin?.trim()) {
    throw new Error("Missing required vin");
  }
  if (!config.access_token?.trim()) {
    throw new Error("Missing required access_token");
  }

  console.info(formatConfigApplyLog({ ...config }));
  const summary = await getVehicleSummary(config);
  const state = normalizeVehicleSummaryState(config, summary);
  const entry = toEntry(config, state);

  registry.set(config.configId ?? config.id, entry);
  registry.updateState(config.configId ?? config.id, state, state.deviceId);

  appendLocalEvent({
    eventType: "tesla.config.applied",
    deviceId: state.deviceId,
    configId: entry.configId,
    payload: {
      vin: state.vin,
      vehicle_name: state.displayName,
      region: state.region,
    },
  });

  try {
    await refreshEntry(entry.configId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const degradedState: TeslaVehicleState = {
      ...state,
      lastError: message,
    };
    registry.set(entry.configId, {
      ...entry,
      latestState: degradedState,
      lastUpdated: nowIso(),
    });
    registry.updateState(entry.configId, degradedState, degradedState.deviceId);
    appendLocalEvent({
      eventType: "tesla.refresh.degraded",
      severity: "warning",
      deviceId: state.deviceId,
      configId: entry.configId,
      payload: { message },
    });
  }

  const storedEntry = registry.get(entry.configId) ?? entry;
  return {
    response: buildConfigApplyResponse({
      configId: storedEntry.configId,
      containerId: storedEntry.containerId ?? null,
      metadata: {
        vin: storedEntry.vin,
        vehicle_name: storedEntry.displayName,
        region: storedEntry.region,
        base_url: storedEntry.baseUrl,
      },
    }),
    entry: storedEntry,
  };
}

export async function removeTeslaConfig(configId: string): Promise<ReturnType<typeof buildConfigRemoveResponse>> {
  const removed = registry.remove(configId);
  if (removed) {
    appendLocalEvent({
      eventType: "tesla.config.removed",
      deviceId: removed.deviceId,
      configId,
      payload: {
        vin: removed.vin,
      },
    });
  }
  return buildConfigRemoveResponse({
    configId,
    removed: Boolean(removed),
  });
}

export async function discoverTeslaVehicles(
  options: DiscoverVehiclesOptions,
): Promise<ReturnType<typeof buildDiscoveryResponse<Record<string, unknown>>>> {
  const inputs = normalizeDiscoveryInputs({
    access_token: options.accessToken,
    region: options.region,
    base_url: options.baseUrl ?? undefined,
  });
  const vehicles = await listVehicles(options);

  return buildDiscoveryResponse(
    vehicles.map((vehicle) => ({
      id: vehicle.vin,
      deviceId: vehicle.vin,
      vin: vehicle.vin,
      display_name: vehicle.display_name ?? vehicle.vin,
      state: vehicle.state ?? "unknown",
      region: options.region ?? "na",
      inputs,
      suggested_config: {
        vin: vehicle.vin,
        region: options.region ?? "na",
      },
    })),
  );
}

export function getEntities(): RuntimeEntity[] {
  return registry.ids().flatMap((configId) => {
    const entry = registry.get(configId);
    if (!entry) {
      return [];
    }

    const includeLocation = entry.latestState?.includeLocation ?? entry.config.include_location !== false;
    const capabilities = [
      "online",
      "battery_level",
      "usable_battery_level",
      "charging_state",
      "charge_limit_soc",
      "time_to_full_charge_hours",
      "charger_power_kw",
      "battery_range_miles",
      "charge_current_amps",
      "charge_energy_added_kwh",
      "plugged_in",
      "inside_temp_c",
      "outside_temp_c",
      "climate_on",
      "is_locked",
      "odometer_miles",
      "speed_mph",
      "vehicle_state",
      "shift_state",
      "last_refresh_at",
    ];
    if (includeLocation) {
      capabilities.push("latitude", "longitude", "heading_degrees");
    }

    return [
      {
        id: entry.deviceId,
        name: entry.displayName,
        configId: entry.configId,
        deviceId: entry.deviceId,
        deviceType: "vehicle",
        deviceClass: "electric_vehicle",
        entityType: "sensor",
        capabilities,
        dashboard: {
          allowedWidgets: ["tile", "stat", "sensor-card", "status-list"],
          defaultWidget: "tile",
          recommendedWidgets: ["tile", "stat", "sensor-card"],
        },
        metadata: {
          vin: entry.vin,
          region: entry.region,
          vehicle_state: entry.latestState?.vehicleState ?? "unknown",
          include_location: includeLocation,
        },
        available_commands: [
          { id: "refresh", label: "Refresh" },
          { id: "wake_up", label: "Wake Up" },
        ],
      },
    ];
  });
}

export function getStatePayload(): Record<string, unknown> {
  return {
    summary: {
      activeConfigCount: registry.ids().length,
      recentEventCount: registry.recentEvents.length,
    },
    entries: Object.fromEntries(registry.entries),
    stateSnapshots: Object.fromEntries(registry.stateSnapshots),
  };
}

export function getEventsPayload(): ReturnType<typeof buildEventListResponse<TeslaLocalEvent>> {
  return buildEventListResponse(registry.recentEvents);
}

export async function runTeslaCommand(payload: TeslaCommandPayload): Promise<Record<string, unknown>> {
  const target = payload.target ?? {};
  const targetConfigId = typeof target.config_id === "string" ? target.config_id : null;
  const configId = payload.configId ?? payload.config_id ?? targetConfigId ?? registry.primaryEntry()?.configId ?? null;
  if (!configId) {
    throw new Error("No Tesla config is active");
  }

  const entry = registry.get(configId);
  if (!entry) {
    throw new Error(`Unknown Tesla config: ${configId}`);
  }

  const rawCommand = payload.command?.trim();
  const command = rawCommand === "tesla.refresh" || rawCommand === "refresh_readings" ? "refresh" : rawCommand;
  if (!command) {
    throw new Error("Missing command");
  }

  const requirements = [
    payload.capability,
    ...(payload.capabilityRequirements ?? []),
    ...(payload.capability_requirements ?? []),
  ].filter((value): value is string => Boolean(value && value.trim()));
  const supportedCapabilities = new Set([
    "action.refresh",
    "action.wake_up",
    "device.refresh",
    "tesla.refresh",
    "tesla.vehicle_state",
    "tesla.wake",
  ]);
  const unsupportedCapability = requirements.find((capability) => !supportedCapabilities.has(capability));
  if (unsupportedCapability) {
    throw new Error(`Unsupported capability: ${unsupportedCapability}`);
  }

  if (command === "refresh") {
    const refreshed = await refreshEntry(configId);
    return {
      ok: true,
      command,
      contract_version: payload.contractVersion ?? payload.contract_version ?? null,
      configId,
      target,
      params: payload.params ?? payload.args ?? {},
      state: refreshed.latestState,
    };
  }

  if (command === "wake_up") {
    const summary = await wakeVehicle(entry.config);
    const wakeState = normalizeVehicleSummaryState(entry.config, summary);
    const updatedEntry: TeslaRuntimeEntry = {
      ...entry,
      latestState: {
        ...wakeState,
        lastCommandAt: nowIso(),
      },
      lastUpdated: nowIso(),
    };
    registry.set(configId, updatedEntry);
    const latestState = updatedEntry.latestState ?? wakeState;
    registry.updateState(configId, latestState, updatedEntry.deviceId);
    appendLocalEvent({
      eventType: "tesla.vehicle.woken",
      deviceId: updatedEntry.deviceId,
      configId,
      payload: {
        vin: updatedEntry.vin,
        vehicle_state: latestState.vehicleState,
      },
    });
    return {
      ok: true,
      command,
      contract_version: payload.contractVersion ?? payload.contract_version ?? null,
      configId,
      target,
      params: payload.params ?? payload.args ?? {},
      state: latestState,
    };
  }

  throw new Error(`Unsupported command: ${command}`);
}

export function healthPayload() {
  return starter.healthResponse({ activeConfigs: registry.ids().length });
}

export function diagnosticsPayload() {
  return starter.diagnosticsResponse({
    activeConfigIds: registry.ids(),
    recentEventCount: registry.recentEvents.length,
    configuredVehicles: registry.ids().map((configId) => registry.get(configId)?.vin).filter(Boolean),
  });
}

export function entitiesPayload() {
  return starter.entitiesResponse(getEntities(), {
    capabilities: manifestCapabilities,
    commands: manifestCommands,
  });
}
