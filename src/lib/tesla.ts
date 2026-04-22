import { fleetApiBaseUrls, type TeslaRegion } from "./contract.js";
import type {
  DiscoverVehiclesOptions,
  TeslaVehicleConfig,
  TeslaVehicleState,
  TeslaVehicleSummary,
} from "./types.js";

interface TeslaEnvelope<T> {
  response?: T;
  error?: string;
  error_description?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function inferPluggedIn(
  chargeState: Record<string, unknown>,
  chargingState: string | null,
): boolean | null {
  const cableType = asString(chargeState.conn_charge_cable) ?? asString(chargeState.charging_cable_type);
  if (cableType) {
    const normalized = cableType.trim().toLowerCase();
    if (normalized === "<invalid>" || normalized === "invalid" || normalized === "none") {
      return false;
    }
    if (normalized.includes("no") && normalized.includes("cable")) {
      return false;
    }
    return true;
  }

  const chargePortDoorOpen = asBoolean(chargeState.charge_port_door_open);
  if (chargePortDoorOpen === true) {
    return true;
  }

  if (chargingState) {
    const normalized = chargingState.trim().toLowerCase();
    if (normalized === "disconnected") {
      return false;
    }
    if (["charging", "complete", "starting", "stopped", "pending", "nopower"].includes(normalized)) {
      return true;
    }
  }

  return null;
}

export function resolveFleetApiBaseUrl(
  region: TeslaRegion = "na",
  override?: string | null,
): string {
  if (override && override.trim()) {
    return override.replace(/\/+$/, "");
  }
  return fleetApiBaseUrls[region];
}

async function teslaRequest<T>({
  accessToken,
  baseUrl,
  path,
  method = "GET",
  body,
}: {
  accessToken: string;
  baseUrl: string;
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => ({}))) as TeslaEnvelope<T>;
  if (!response.ok) {
    const detail = payload.error_description || payload.error || `${response.status} ${response.statusText}`;
    throw new Error(`Tesla Fleet API request failed: ${detail}`);
  }
  if (payload.error || payload.error_description) {
    throw new Error(`Tesla Fleet API request failed: ${payload.error_description || payload.error}`);
  }
  if (payload.response === undefined) {
    throw new Error("Tesla Fleet API response was missing a response payload");
  }
  return payload.response;
}

export async function listVehicles(options: DiscoverVehiclesOptions): Promise<TeslaVehicleSummary[]> {
  const region = options.region ?? "na";
  const baseUrl = resolveFleetApiBaseUrl(region, options.baseUrl);
  const response = await teslaRequest<unknown[]>({
    accessToken: options.accessToken,
    baseUrl,
    path: "/api/1/vehicles",
  });

  return asArray<Record<string, unknown>>(response).map((vehicle) => ({
    id: typeof vehicle.id === "number" || typeof vehicle.id === "string" ? vehicle.id : null,
    vehicle_id: asNumber(vehicle.vehicle_id),
    vin: String(vehicle.vin ?? ""),
    display_name: asString(vehicle.display_name),
    state: asString(vehicle.state),
    in_service: asBoolean(vehicle.in_service),
  }));
}

export async function getVehicleSummary(config: TeslaVehicleConfig): Promise<TeslaVehicleSummary> {
  const region = config.region ?? "na";
  const baseUrl = resolveFleetApiBaseUrl(region, config.base_url ?? null);
  const response = await teslaRequest<Record<string, unknown>>({
    accessToken: config.access_token,
    baseUrl,
    path: `/api/1/vehicles/${config.vin}`,
  });

  return {
    id: typeof response.id === "number" || typeof response.id === "string" ? response.id : null,
    vehicle_id: asNumber(response.vehicle_id),
    vin: String(response.vin ?? config.vin),
    display_name: asString(response.display_name),
    state: asString(response.state),
    in_service: asBoolean(response.in_service),
  };
}

export async function getVehicleData(config: TeslaVehicleConfig): Promise<Record<string, unknown>> {
  const region = config.region ?? "na";
  const baseUrl = resolveFleetApiBaseUrl(region, config.base_url ?? null);
  return teslaRequest<Record<string, unknown>>({
    accessToken: config.access_token,
    baseUrl,
    path: `/api/1/vehicles/${config.vin}/vehicle_data`,
  });
}

export async function wakeVehicle(config: TeslaVehicleConfig): Promise<TeslaVehicleSummary> {
  const region = config.region ?? "na";
  const baseUrl = resolveFleetApiBaseUrl(region, config.base_url ?? null);
  const response = await teslaRequest<Record<string, unknown>>({
    accessToken: config.access_token,
    baseUrl,
    path: `/api/1/vehicles/${config.vin}/wake_up`,
    method: "POST",
  });

  return {
    id: typeof response.id === "number" || typeof response.id === "string" ? response.id : null,
    vehicle_id: asNumber(response.vehicle_id),
    vin: String(response.vin ?? config.vin),
    display_name: asString(response.display_name),
    state: asString(response.state),
    in_service: asBoolean(response.in_service),
  };
}

export function normalizeVehicleSummaryState(config: TeslaVehicleConfig, summary: TeslaVehicleSummary): TeslaVehicleState {
  const region = config.region ?? "na";
  const baseUrl = resolveFleetApiBaseUrl(region, config.base_url ?? null);
  const displayName = config.vehicle_name?.trim() || summary.display_name?.trim() || summary.vin;
  const vehicleState = summary.state ?? "unknown";

  return {
    deviceId: summary.vin,
    configId: config.configId ?? config.id,
    vin: summary.vin,
    displayName,
    region,
    baseUrl,
    online: vehicleState === "online",
    vehicleState,
    inService: Boolean(summary.in_service),
    includeLocation: config.include_location !== false,
    batteryLevel: null,
    usableBatteryLevel: null,
    chargingState: null,
    chargeLimitSoc: null,
    timeToFullChargeHours: null,
    chargerPowerKw: null,
    batteryRangeMiles: null,
    chargeCurrentAmps: null,
    chargeEnergyAddedKwh: null,
    pluggedIn: null,
    insideTempC: null,
    outsideTempC: null,
    climateOn: null,
    isLocked: null,
    odometerMiles: null,
    speedMph: null,
    latitude: null,
    longitude: null,
    headingDegrees: null,
    shiftState: null,
    lastRefreshAt: null,
    lastCommandAt: null,
    lastError: null,
    source: "summary",
    summary,
  };
}

export function normalizeVehicleDataState(
  config: TeslaVehicleConfig,
  summary: TeslaVehicleSummary,
  vehicleData: Record<string, unknown>,
): TeslaVehicleState {
  const state = normalizeVehicleSummaryState(config, summary);
  const chargeState = asObject(vehicleData.charge_state);
  const climateState = asObject(vehicleData.climate_state);
  const driveState = asObject(vehicleData.drive_state);
  const vehicleState = asObject(vehicleData.vehicle_state);

  const includeLocation = config.include_location !== false;
  const chargingState = asString(chargeState.charging_state);
  const chargerPowerKwValue = asNumber(chargeState.charger_power);
  const batteryRangeMilesValue =
    asNumber(chargeState.battery_range) ??
    asNumber(chargeState.est_battery_range) ??
    asNumber(chargeState.ideal_battery_range);
  const chargeCurrentAmpsValue =
    asNumber(chargeState.charger_actual_current) ??
    asNumber(chargeState.charge_current_request) ??
    asNumber(chargeState.charge_current_request_max);
  const chargeEnergyAddedKwhValue = asNumber(chargeState.charge_energy_added);
  const refreshedAt = new Date().toISOString();

  return {
    ...state,
    online: true,
    vehicleState: asString(vehicleData.state) ?? state.vehicleState,
    batteryLevel: asNumber(chargeState.battery_level),
    usableBatteryLevel: asNumber(chargeState.usable_battery_level),
    chargingState,
    chargeLimitSoc: asNumber(chargeState.charge_limit_soc),
    timeToFullChargeHours: asNumber(chargeState.time_to_full_charge),
    chargerPowerKw: chargerPowerKwValue,
    batteryRangeMiles: batteryRangeMilesValue,
    chargeCurrentAmps: chargeCurrentAmpsValue,
    chargeEnergyAddedKwh: chargeEnergyAddedKwhValue,
    pluggedIn: inferPluggedIn(chargeState, chargingState),
    insideTempC: asNumber(climateState.inside_temp),
    outsideTempC: asNumber(climateState.outside_temp),
    climateOn: asBoolean(climateState.is_climate_on),
    isLocked: asBoolean(vehicleState.locked),
    odometerMiles: asNumber(vehicleState.odometer),
    speedMph: asNumber(driveState.speed),
    latitude: includeLocation ? asNumber(driveState.latitude) : null,
    longitude: includeLocation ? asNumber(driveState.longitude) : null,
    headingDegrees: includeLocation ? asNumber(driveState.heading) : null,
    shiftState: asString(driveState.shift_state),
    lastRefreshAt: refreshedAt,
    source: "vehicle_data",
    summary: {
      ...summary,
      state: asString(vehicleData.state) ?? summary.state ?? "online",
    },
  };
}

export function buildTelemetryMetrics(state: TeslaVehicleState): {
  metrics: Record<string, unknown>;
  units: Record<string, string>;
} {
  const metrics: Record<string, unknown> = {
    online: state.online,
    battery_level: state.batteryLevel,
    usable_battery_level: state.usableBatteryLevel,
    charging_state: state.chargingState,
    charge_limit_soc: state.chargeLimitSoc,
    time_to_full_charge_hours: state.timeToFullChargeHours,
    charger_power_kw: state.chargerPowerKw,
    battery_range_miles: state.batteryRangeMiles,
    charge_current_amps: state.chargeCurrentAmps,
    charge_energy_added_kwh: state.chargeEnergyAddedKwh,
    plugged_in: state.pluggedIn,
    inside_temp_c: state.insideTempC,
    outside_temp_c: state.outsideTempC,
    climate_on: state.climateOn,
    is_locked: state.isLocked,
    odometer_miles: state.odometerMiles,
    speed_mph: state.speedMph,
    vehicle_state: state.vehicleState,
    heading_degrees: state.headingDegrees,
    shift_state: state.shiftState,
    last_refresh_at: state.lastRefreshAt,
  };

  if (state.includeLocation) {
    metrics.latitude = state.latitude;
    metrics.longitude = state.longitude;
  }

  const units: Record<string, string> = {
    battery_level: "%",
    usable_battery_level: "%",
    charge_limit_soc: "%",
    time_to_full_charge_hours: "h",
    charger_power_kw: "kW",
    battery_range_miles: "mi",
    charge_current_amps: "A",
    charge_energy_added_kwh: "kWh",
    inside_temp_c: "C",
    outside_temp_c: "C",
    odometer_miles: "mi",
    speed_mph: "mph",
    heading_degrees: "degrees",
  };

  if (state.includeLocation) {
    units.latitude = "degrees";
    units.longitude = "degrees";
  }

  return { metrics, units };
}
