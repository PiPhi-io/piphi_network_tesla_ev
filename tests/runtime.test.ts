import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { buildRuntimeHeaders } from "piphi-runtime-testkit-node";

import {
  buildTelemetryMetrics,
  getVehicleData,
  getVehicleSummary,
  listVehicles,
  normalizeVehicleDataState,
  normalizeVehicleSummaryState,
  resolveFleetApiBaseUrl,
  wakeVehicle,
} from "../src/lib/tesla.js";
import { registry, starter } from "../src/lib/runtime.js";
import type { TeslaVehicleConfig } from "../src/lib/types.js";
import {
  FakeTeslaServer,
  defaultVehicleData,
  defaultVehicleSummary,
  startHttpServer,
  startRuntimeAndCore,
} from "./test-helpers.js";

function resetRuntimeState(): void {
  registry.entries.clear();
  registry.stateSnapshots.clear();
  registry.recentEvents.length = 0;
  starter.runtime.auth.update({
    containerId: null,
    internalToken: null,
  });
  starter.runtime.processState.coreBaseUrl = "http://127.0.0.1:1";
}

function buildHeaders() {
  return buildRuntimeHeaders({
    containerId: "container-1",
    internalToken: "internal-token",
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("normalizeVehicleSummaryState keeps a discovery-only view for sleeping cars", () => {
  resetRuntimeState();
  const config: TeslaVehicleConfig = {
    id: "cfg-1",
    configId: "cfg-1",
    vin: "5YJ3E1EA7LF000000",
    access_token: "test-token",
    region: "na",
  };

  const state = normalizeVehicleSummaryState(config, {
    vin: config.vin,
    display_name: "Model 3",
    state: "asleep",
    in_service: false,
  });

  assert.equal(state.vehicleState, "asleep");
  assert.equal(state.online, false);
  assert.equal(state.batteryLevel, null);
  assert.equal(state.source, "summary");
});

test("normalizeVehicleDataState maps charge, climate, lock, and location fields", () => {
  resetRuntimeState();
  const config: TeslaVehicleConfig = {
    id: "cfg-2",
    configId: "cfg-2",
    vin: "5YJ3E1EA7LF000000",
    access_token: "test-token",
    region: "na",
    include_location: true,
  };

  const summary = {
    vin: config.vin,
    display_name: "Model 3",
    state: "online",
    in_service: false,
  };

  const state = normalizeVehicleDataState(config, summary, {
    state: "online",
    charge_state: {
      battery_level: 81,
      usable_battery_level: 80,
      charging_state: "Charging",
      charge_limit_soc: 90,
      time_to_full_charge: 1.5,
      charger_power: 11,
    },
    climate_state: {
      inside_temp: 20.5,
      outside_temp: 14.2,
      is_climate_on: true,
    },
    drive_state: {
      latitude: 1.2,
      longitude: 3.4,
      heading: 225,
      speed: 45,
      shift_state: "D",
    },
    vehicle_state: {
      locked: false,
      odometer: 4567.8,
    },
  });

  assert.equal(state.online, true);
  assert.equal(state.batteryLevel, 81);
  assert.equal(state.chargingState, "Charging");
  assert.equal(state.climateOn, true);
  assert.equal(state.isLocked, false);
  assert.equal(state.latitude, 1.2);
  assert.equal(state.odometerMiles, 4567.8);
  assert.equal(state.source, "vehicle_data");
});

test("normalizeVehicleDataState respects disabled location and configured display names", () => {
  resetRuntimeState();
  const config: TeslaVehicleConfig = {
    id: "cfg-3",
    configId: "cfg-3",
    vin: "5YJ3E1EA7LF000000",
    access_token: "test-token",
    region: "eu",
    vehicle_name: "Garage Tesla",
    include_location: false,
    base_url: "https://custom.example///",
  };

  const state = normalizeVehicleDataState(
    config,
    {
      vin: config.vin,
      display_name: "Model 3",
      state: "online",
      in_service: false,
    },
    {
      state: "online",
      drive_state: {
        latitude: 10,
        longitude: 20,
        heading: 30,
      },
      vehicle_state: {
        odometer: 10,
        locked: true,
      },
    },
  );

  assert.equal(state.displayName, "Garage Tesla");
  assert.equal(state.baseUrl, "https://custom.example");
  assert.equal(state.latitude, null);
  assert.equal(state.longitude, null);
  assert.equal(state.headingDegrees, null);
});

test("buildTelemetryMetrics omits latitude and longitude when location is disabled", () => {
  resetRuntimeState();
  const state = normalizeVehicleSummaryState(
    {
      id: "cfg-4",
      configId: "cfg-4",
      vin: "5YJ3E1EA7LF000000",
      access_token: "test-token",
      include_location: false,
      region: "na",
    },
    {
      vin: "5YJ3E1EA7LF000000",
      display_name: "Model 3",
      state: "online",
      in_service: false,
    },
  );

  const telemetry = buildTelemetryMetrics(state);
  assert.equal("latitude" in telemetry.metrics, false);
  assert.equal("longitude" in telemetry.metrics, false);
  assert.equal("latitude" in telemetry.units, false);
  assert.equal("longitude" in telemetry.units, false);
});

test("resolveFleetApiBaseUrl trims overrides and uses regional defaults", () => {
  resetRuntimeState();
  assert.equal(resolveFleetApiBaseUrl("na", "https://fleet.example///"), "https://fleet.example");
  assert.equal(resolveFleetApiBaseUrl("eu"), "https://fleet-api.prd.eu.vn.cloud.tesla.com");
});

test("resolveFleetApiBaseUrl falls back to the regional default when override is blank", () => {
  resetRuntimeState();
  assert.equal(resolveFleetApiBaseUrl("cn", "   "), "https://fleet-api.prd.cn.vn.cloud.tesla.cn");
});

test("normalizeVehicleSummaryState falls back to VIN and unknown state when Tesla omits fields", () => {
  resetRuntimeState();
  const config: TeslaVehicleConfig = {
    id: "cfg-fallbacks",
    configId: "cfg-fallbacks",
    vin: "5YJ3E1EA7LF000000",
    access_token: "test-token",
    region: "na",
  };

  const state = normalizeVehicleSummaryState(config, {
    vin: config.vin,
  });

  assert.equal(state.displayName, config.vin);
  assert.equal(state.vehicleState, "unknown");
  assert.equal(state.online, false);
});

test("normalizeVehicleDataState tolerates sparse and invalid Tesla payload shapes", () => {
  resetRuntimeState();
  const config: TeslaVehicleConfig = {
    id: "cfg-sparse",
    configId: "cfg-sparse",
    vin: "5YJ3E1EA7LF000000",
    access_token: "test-token",
    region: "na",
    include_location: true,
  };

  const state = normalizeVehicleDataState(
    config,
    {
      vin: config.vin,
      display_name: "Sparse Tesla",
      state: "online",
      in_service: false,
    },
    {
      state: "",
      charge_state: {
        battery_level: "bad",
        charging_state: "Disconnected",
      },
      climate_state: {
        inside_temp: null,
      },
      drive_state: {
        latitude: "bad",
        speed: "bad",
        shift_state: "P",
      },
      vehicle_state: {
        locked: "bad",
        odometer: "bad",
      },
    },
  );

  assert.equal(state.batteryLevel, null);
  assert.equal(state.chargingState, "Disconnected");
  assert.equal(state.insideTempC, null);
  assert.equal(state.latitude, null);
  assert.equal(state.speedMph, null);
  assert.equal(state.isLocked, null);
  assert.equal(state.odometerMiles, null);
  assert.equal(state.shiftState, "P");
  assert.equal(state.vehicleState, "online");
});

test("listVehicles returns an empty list when Tesla responds with a non-array payload", async () => {
  resetRuntimeState();
  const server = http.createServer(
    (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ response: { vehicles: [] } }));
    },
  );
  const started = await startHttpServer(server);

  try {
    const vehicles = await listVehicles({
      accessToken: "test-token",
      baseUrl: started.baseUrl,
      region: "na",
    });
    assert.deepEqual(vehicles, []);
  } finally {
    await new Promise<void>((resolve, reject) =>
      started.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("buildTelemetryMetrics preserves nullable values and command-free summary states", () => {
  resetRuntimeState();
  const state = normalizeVehicleSummaryState(
    {
      id: "cfg-null",
      configId: "cfg-null",
      vin: "5YJ3E1EA7LF000000",
      access_token: "test-token",
      region: "na",
    },
    {
      vin: "5YJ3E1EA7LF000000",
      display_name: "Model 3",
      state: "offline",
      in_service: true,
    },
  );

  const telemetry = buildTelemetryMetrics(state);
  assert.equal(telemetry.metrics.online, false);
  assert.equal(telemetry.metrics.battery_level, null);
  assert.equal(telemetry.metrics.vehicle_state, "offline");
  assert.equal(telemetry.units.speed_mph, "mph");
});

test("tesla client functions parse multi-vehicle lists and direct helper calls", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.vehicles = [
    {
      id: 1,
      vehicle_id: 123,
      vin: "5YJ3E1EA7LF000000",
      display_name: "Model 3",
      state: "online",
      in_service: false,
    },
    {
      id: "two",
      vehicle_id: 456,
      vin: "7SAYGDEE0PF000001",
      display_name: "Model Y",
      state: "asleep",
      in_service: true,
    },
  ];
  fakeTesla.summaryPayload = {
    ...defaultVehicleSummary,
    display_name: "Direct Summary",
    in_service: true,
  };
  fakeTesla.vehicleDataPayload = {
    ...defaultVehicleData,
    charge_state: {
      ...(defaultVehicleData.charge_state as Record<string, unknown>),
      battery_level: 63,
    },
  };
  fakeTesla.wakePayload = {
    ...defaultVehicleSummary,
    display_name: "Direct Wake",
  };
  const { baseUrl } = await fakeTesla.start();

  try {
    const config: TeslaVehicleConfig = {
      id: "cfg-direct",
      configId: "cfg-direct",
      vin: "5YJ3E1EA7LF000000",
      access_token: "test-token",
      region: "na",
      base_url: baseUrl,
    };

    const vehicles = await listVehicles({
      accessToken: "test-token",
      region: "na",
      baseUrl: baseUrl,
    });
    const summary = await getVehicleSummary(config);
    const vehicleData = await getVehicleData(config);
    const wake = await wakeVehicle(config);

    assert.equal(vehicles.length, 2);
    assert.equal(vehicles[1]?.display_name, "Model Y");
    assert.equal(summary.display_name, "Direct Summary");
    assert.equal((vehicleData.charge_state as Record<string, unknown>).battery_level, 63);
    assert.equal(wake.display_name, "Direct Wake");
  } finally {
    await fakeTesla.stop();
  }
});

test("tesla client helper calls throw useful errors for Tesla envelope problems", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl } = await fakeTesla.start();
  const config: TeslaVehicleConfig = {
    id: "cfg-envelope",
    configId: "cfg-envelope",
    vin: "5YJ3E1EA7LF000000",
    access_token: "test-token",
    region: "na",
    base_url: baseUrl,
  };

  try {
    fakeTesla.failList = true;
    await assert.rejects(
      () => listVehicles({ accessToken: "test-token", region: "na", baseUrl: baseUrl }),
      /Tesla Fleet API request failed: vehicle list failed/,
    );

    fakeTesla.failList = false;
    fakeTesla.missingSummaryResponse = true;
    await assert.rejects(
      () => getVehicleSummary(config),
      /Tesla Fleet API response was missing a response payload/,
    );

    fakeTesla.missingSummaryResponse = false;
    fakeTesla.missingVehicleDataResponse = true;
    await assert.rejects(
      () => getVehicleData(config),
      /Tesla Fleet API response was missing a response payload/,
    );

    fakeTesla.missingVehicleDataResponse = false;
    fakeTesla.missingWakeResponse = true;
    await assert.rejects(
      () => wakeVehicle(config),
      /Tesla Fleet API response was missing a response payload/,
    );
  } finally {
    await fakeTesla.stop();
  }
});

test("tesla client helpers reject 200 responses that carry Tesla error bodies", async () => {
  resetRuntimeState();
  const server = http.createServer(
    (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error_description: "vehicle temporarily unavailable" }));
    },
  );
  const started = await startHttpServer(server);

  try {
    await assert.rejects(
      () =>
        getVehicleSummary({
          id: "cfg-200-error",
          configId: "cfg-200-error",
          vin: "5YJ3E1EA7LF000000",
          access_token: "test-token",
          region: "na",
          base_url: started.baseUrl,
        }),
      /Tesla Fleet API request failed: vehicle temporarily unavailable/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      started.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("discovery lists Tesla vehicles through the runtime route", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {
          access_token: "test-token",
          region: "na",
          base_url: teslaBaseUrl,
        },
      }),
    });
    assert.equal(response.status, 200);

    const payload = (await response.json()) as { devices: Array<Record<string, unknown>> };
    assert.equal(payload.devices.length, 1);
    assert.equal(payload.devices[0]?.vin, "5YJ3E1EA7LF000000");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("discovery supports GET queries and /discovery alias", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(
      `${runtimeBaseUrl}/discovery?access_token=test-token&region=na&base_url=${encodeURIComponent(teslaBaseUrl)}`,
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { devices: Array<Record<string, unknown>> };
    assert.equal(payload.devices[0]?.display_name, "Model 3");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("discovery returns 400 when the access token is missing", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/discover`);
    assert.equal(response.status, 400);
    const payload = await readJson(response);
    assert.equal(payload.reason, "Missing access_token for discovery");
  } finally {
    await stop();
  }
});

test("post discovery returns 400 when access_token is omitted from inputs", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {
          region: "na",
        },
      }),
    });
    assert.equal(response.status, 400);
    const payload = await readJson(response);
    assert.equal(payload.reason, "Missing access_token for discovery");
  } finally {
    await stop();
  }
});

test("discovery surfaces Tesla list failures and preserves suggested config data", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.failList = true;
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const failing = await fetch(`${runtimeBaseUrl}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {
          access_token: "test-token",
          region: "na",
          base_url: teslaBaseUrl,
        },
      }),
    });
    assert.equal(failing.status, 500);
    assert.equal((await readJson(failing)).reason, "Tesla Fleet API request failed: vehicle list failed");

    fakeTesla.failList = false;
    const success = await fetch(`${runtimeBaseUrl}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {
          access_token: "test-token",
          region: "na",
          base_url: teslaBaseUrl,
        },
      }),
    });
    const payload = await readJson(success);
    const device = (payload.devices as Array<Record<string, unknown>>)[0];
    assert.deepEqual(device.suggested_config, {
      vin: "5YJ3E1EA7LF000000",
      region: "na",
    });
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("health, ui, and manifest routes expose core runtime metadata", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;

    const health = await fetch(`${runtimeBaseUrl}/health`);
    const ui = await fetch(`${runtimeBaseUrl}/ui`);
    const manifest = await fetch(`${runtimeBaseUrl}/manifest.json`);

    assert.equal(health.status, 200);
    assert.equal(ui.status, 200);
    assert.equal(manifest.status, 200);

    const healthPayload = await readJson(health);
    const uiPayload = await readJson(ui);
    const manifestPayload = await readJson(manifest);

    assert.equal(healthPayload.ok, true);
    assert.equal((healthPayload.metadata as Record<string, unknown>).activeConfigs, 0);
    assert.equal((uiPayload.schema as Record<string, unknown>).title, "Tesla EV Setup");
    assert.equal(manifestPayload.id, "piphi-network-tesla-ev");
  } finally {
    await stop();
  }
});

test("entities, diagnostics, and state routes expose configured vehicle details", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();
    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-routes",
        configId: "cfg-routes",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    const entities = await fetch(`${runtimeBaseUrl}/entities`);
    const diagnostics = await fetch(`${runtimeBaseUrl}/diagnostics`);
    const state = await fetch(`${runtimeBaseUrl}/state`);
    const events = await fetch(`${runtimeBaseUrl}/events`);

    const entitiesPayload = await readJson(entities);
    const diagnosticsPayload = await readJson(diagnostics);
    const statePayload = await readJson(state);
    const eventsPayload = await readJson(events);

    const entity = (entitiesPayload.entities as Array<Record<string, unknown>>)[0];
    assert.equal(entity.deviceClass, "electric_vehicle");
    assert.equal((entity.available_commands as Array<Record<string, unknown>>).length, 2);
    assert.equal((diagnosticsPayload.diagnostics as Record<string, unknown>).recentEventCount, 2);
    assert.equal((statePayload.summary as Record<string, unknown>).activeConfigCount, 1);
    assert.ok((eventsPayload.events as Array<Record<string, unknown>>).length >= 2);
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("entities and telemetry omit location capabilities when include_location is disabled", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();
    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-no-location",
        configId: "cfg-no-location",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        include_location: false,
        base_url: teslaBaseUrl,
      }),
    });

    const entities = await fetch(`${runtimeBaseUrl}/entities`);
    const entitiesPayload = await readJson(entities);
    const entity = (entitiesPayload.entities as Array<Record<string, unknown>>)[0];
    const capabilities = entity.capabilities as string[];
    assert.equal(capabilities.includes("latitude"), false);
    assert.equal(capabilities.includes("longitude"), false);
    assert.equal((entity.metadata as Record<string, unknown>).include_location, false);

    const latestTelemetry = mockCore.telemetryRequests.at(-1);
    assert.equal("latitude" in (latestTelemetry?.body?.metrics ?? {}), false);
    assert.equal("longitude" in (latestTelemetry?.body?.metrics ?? {}), false);
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("config and refresh publish telemetry to PiPhi Core", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();

    const configResponse = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-tesla-1",
        configId: "cfg-tesla-1",
        containerId: "container-1",
        vin: "5YJ3E1EA7LF000000",
        region: "na",
        access_token: "test-token",
        base_url: teslaBaseUrl,
      }),
    });

    assert.equal(configResponse.status, 200);

    const refreshResponse = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "refresh",
        configId: "cfg-tesla-1",
      }),
    });
    assert.equal(refreshResponse.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(mockCore.telemetryRequests.length >= 1);
    const latest = mockCore.telemetryRequests.at(-1);
    assert.equal(latest?.body?.deviceId, "5YJ3E1EA7LF000000");
    assert.equal(latest?.body?.containerId, "container-1");
    assert.equal(latest?.body?.metrics?.battery_level, 78);
    assert.equal(latest?.body?.metrics?.is_locked, true);
    assert.equal(latest?.headers["x-piphi-integration-token"], "internal-token");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("config applies summary-only state for sleeping vehicles and records degraded refresh errors", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.vehicleState = "asleep";
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...buildHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-asleep",
        configId: "cfg-asleep",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    assert.equal(response.status, 200);
    const stateResponse = await fetch(`${runtimeBaseUrl}/state`);
    const statePayload = await readJson(stateResponse);
    const snapshots = statePayload.stateSnapshots as Record<string, Record<string, unknown>>;
    const asleepState = snapshots["cfg-asleep"]?.state as Record<string, unknown> | undefined;
    assert.equal(asleepState?.vehicleState, "asleep");
    assert.equal(asleepState?.source, "summary");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("wake_up command revives a sleeping vehicle and returns updated state", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.vehicleState = "asleep";
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();

    const configResponse = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-sleeping",
        configId: "cfg-sleeping",
        vin: "5YJ3E1EA7LF000000",
        region: "na",
        access_token: "test-token",
        base_url: teslaBaseUrl,
      }),
    });
    assert.equal(configResponse.status, 200);

    const wakeResponse = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "wake_up",
        configId: "cfg-sleeping",
      }),
    });

    assert.equal(wakeResponse.status, 200);
    const payload = await readJson(wakeResponse);
    assert.equal((payload.state as Record<string, unknown>).vehicleState, "online");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("refresh command without configId uses the primary config", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();
    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-primary",
        configId: "cfg-primary",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    const refresh = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: " refresh ",
      }),
    });

    assert.equal(refresh.status, 200);
    const payload = await readJson(refresh);
    assert.equal(payload.command, "refresh");
    assert.equal(payload.configId, "cfg-primary");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("command route accepts automation runtime contract payload", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();
    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-contract",
        configId: "cfg-contract",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    const refresh = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contract_version: "automation.runtime.command.v1",
        command: "refresh_readings",
        target: {
          config_id: "cfg-contract",
          device_id: "5YJ3E1EA7LF000000",
        },
        params: { force: true },
        capability: "device.refresh",
        capability_requirements: ["device.refresh"],
      }),
    });

    assert.equal(refresh.status, 200);
    const payload = await readJson(refresh);
    assert.equal(payload.command, "refresh");
    assert.equal(payload.contract_version, "automation.runtime.command.v1");
    assert.equal(payload.configId, "cfg-contract");
    assert.deepEqual(payload.params, { force: true });
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("command route rejects unsupported automation capability", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();
    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-capability",
        configId: "cfg-capability",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    const response = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "refresh",
        configId: "cfg-capability",
        capability: "switch.power",
      }),
    });

    assert.equal(response.status, 500);
    const payload = await readJson(response);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "runtime_command_failed");
    assert.equal(payload.reason, "Unsupported capability: switch.power");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("command route returns 500 for missing and unsupported commands", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();

    const missing = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 500);
    assert.equal((await readJson(missing)).reason, "No Tesla config is active");

    const unsupported = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "explode",
        configId: "cfg-missing",
      }),
    });
    assert.equal(unsupported.status, 500);
    assert.equal((await readJson(unsupported)).reason, "Unknown Tesla config: cfg-missing");
  } finally {
    await stop();
  }
});

test("command route distinguishes missing command text from unsupported known-config commands", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();
    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-command-shape",
        configId: "cfg-command-shape",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    const missingCommand = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        configId: "cfg-command-shape",
        command: "   ",
      }),
    });
    assert.equal(missingCommand.status, 500);
    assert.equal((await readJson(missingCommand)).reason, "Missing command");

    const unsupported = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        configId: "cfg-command-shape",
        command: "door_lock",
      }),
    });
    assert.equal(unsupported.status, 500);
    assert.equal((await readJson(unsupported)).reason, "Unsupported command: door_lock");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("refresh and wake commands surface Tesla-side vehicle_data and wake failures", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();
    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-command-failures",
        configId: "cfg-command-failures",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    fakeTesla.failVehicleData = true;
    const refresh = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        configId: "cfg-command-failures",
        command: "refresh",
      }),
    });
    assert.equal(refresh.status, 500);
    assert.equal((await readJson(refresh)).reason, "Tesla Fleet API request failed: vehicle data failed");

    fakeTesla.failVehicleData = false;
    fakeTesla.failWake = true;
    const wake = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        configId: "cfg-command-failures",
        command: "wake_up",
      }),
    });
    assert.equal(wake.status, 500);
    assert.equal((await readJson(wake)).reason, "Tesla Fleet API request failed: wake failed");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("config route surfaces Tesla API failures", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.failSummary = true;
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...buildHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-bad",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    assert.equal(response.status, 500);
    const payload = await readJson(response);
    assert.equal(payload.reason, "Tesla Fleet API request failed: vehicle summary failed");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("config route rejects missing vin and missing access token", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();

    const missingVin = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-no-vin",
        access_token: "test-token",
      }),
    });
    assert.equal(missingVin.status, 500);
    assert.equal((await readJson(missingVin)).reason, "Missing required vin");

    const missingToken = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-no-token",
        vin: "5YJ3E1EA7LF000000",
      }),
    });
    assert.equal(missingToken.status, 500);
    assert.equal((await readJson(missingToken)).reason, "Missing required access_token");
  } finally {
    await stop();
  }
});

test("config accepts container_id and integration_id aliases", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...buildHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-aliases",
        config_id: "cfg-aliases",
        container_id: "container-alias",
        integration_id: "integration-alias",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });
    assert.equal(response.status, 200);

    const stateResponse = await fetch(`${runtimeBaseUrl}/state`);
    const statePayload = await readJson(stateResponse);
    const entries = statePayload.entries as Record<string, Record<string, unknown>>;
    assert.equal(entries["cfg-aliases"]?.containerId, "container-alias");
    assert.equal(entries["cfg-aliases"]?.integrationId, "integration-alias");
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("config sync applies configs and deconfigure routes remove them", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();

    const syncResponse = await fetch(`${runtimeBaseUrl}/configs/sync`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        generation: 42,
        configs: [
          {
            id: "cfg-sync-1",
            configId: "cfg-sync-1",
            vin: "5YJ3E1EA7LF000000",
            access_token: "test-token",
            region: "na",
            base_url: teslaBaseUrl,
          },
        ],
      }),
    });

    assert.equal(syncResponse.status, 200);
    const syncPayload = await readJson(syncResponse);
    assert.deepEqual(syncPayload.appliedConfigIds, ["cfg-sync-1"]);
    assert.deepEqual(syncPayload.removedConfigIds, []);
    assert.equal(syncPayload.generation, 42);

    const entitiesResponse = await fetch(`${runtimeBaseUrl}/entities`);
    const entitiesPayload = await readJson(entitiesResponse);
    assert.equal((entitiesPayload.entities as Array<Record<string, unknown>>).length, 1);

    const deconfigureMissing = await fetch(`${runtimeBaseUrl}/deconfigure`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(deconfigureMissing.status, 400);

    const deconfigureResponse = await fetch(`${runtimeBaseUrl}/deconfigure/cfg-sync-1`, {
      method: "POST",
      headers,
    });
    assert.equal(deconfigureResponse.status, 200);
    assert.equal((await readJson(deconfigureResponse)).removed, true);

    const stateResponse = await fetch(`${runtimeBaseUrl}/state`);
    const statePayload = await readJson(stateResponse);
    assert.equal(
      ((statePayload.summary as Record<string, unknown>).activeConfigCount as number),
      0,
    );
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("config sync supports the /config/sync alias", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/config/sync`, {
      method: "POST",
      headers: {
        ...buildHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        generation: 7,
        configs: [
          {
            id: "cfg-sync-alias",
            configId: "cfg-sync-alias",
            vin: "5YJ3E1EA7LF000000",
            access_token: "test-token",
            region: "na",
            base_url: teslaBaseUrl,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.generation, 7);
    assert.deepEqual(payload.appliedConfigIds, ["cfg-sync-alias"]);
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("config sync ignores invalid entries and treats non-array snapshots as empty", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = {
      ...buildHeaders(),
      "Content-Type": "application/json",
    };

    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "cfg-existing",
        configId: "cfg-existing",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    const filteredSync = await fetch(`${runtimeBaseUrl}/configs/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        generation: "bad-generation",
        configs: [
          null,
          7,
          "invalid",
          {
            id: "cfg-valid",
            configId: "cfg-valid",
            vin: "5YJ3E1EA7LF000000",
            access_token: "test-token",
            region: "na",
            base_url: teslaBaseUrl,
          },
        ],
      }),
    });

    assert.equal(filteredSync.status, 200);
    const filteredPayload = await readJson(filteredSync);
    assert.equal(filteredPayload.generation, null);
    assert.deepEqual(filteredPayload.appliedConfigIds, ["cfg-valid"]);
    assert.deepEqual(filteredPayload.removedConfigIds, ["cfg-existing"]);

    const emptySync = await fetch(`${runtimeBaseUrl}/configs/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        generation: 101,
        configs: "not-an-array",
      }),
    });

    assert.equal(emptySync.status, 200);
    const emptyPayload = await readJson(emptySync);
    assert.equal(emptyPayload.generation, 101);
    assert.deepEqual(emptyPayload.appliedConfigIds, []);
    assert.deepEqual(emptyPayload.removedConfigIds, ["cfg-valid"]);
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("deconfigure reports removed false for unknown configs", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/deconfigure/does-not-exist`, {
      method: "POST",
      headers: buildHeaders(),
    });
    assert.equal(response.status, 200);
    assert.equal((await readJson(response)).removed, false);
  } finally {
    await stop();
  }
});

test("config sync removes stale configs when the snapshot is empty", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();

    await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-stale",
        configId: "cfg-stale",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });

    const syncResponse = await fetch(`${runtimeBaseUrl}/config/sync`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        generation: 99,
        configs: [],
      }),
    });

    assert.equal(syncResponse.status, 200);
    const payload = await readJson(syncResponse);
    assert.deepEqual(payload.removedConfigIds, ["cfg-stale"]);
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("telemetry delivery failures are recorded as warning events instead of breaking refresh", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    mockCore.failTelemetryWithStatus(500, { ok: false, error: "core down" });

    const headers = buildHeaders();
    const configResponse = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-fail-telemetry",
        configId: "cfg-fail-telemetry",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });
    assert.equal(configResponse.status, 200);

    const eventsResponse = await fetch(`${runtimeBaseUrl}/events`);
    const eventsPayload = await readJson(eventsResponse);
    const eventTypes = (eventsPayload.events as Array<Record<string, unknown>>).map((event) => event.eventType);
    assert.ok(eventTypes.includes("tesla.telemetry.delivery_failed"));
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("config stores degraded state when initial refresh fails after summary succeeds", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.failVehicleData = true;
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...buildHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "cfg-degraded",
        configId: "cfg-degraded",
        vin: "5YJ3E1EA7LF000000",
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });
    assert.equal(response.status, 200);

    const stateResponse = await fetch(`${runtimeBaseUrl}/state`);
    const statePayload = await readJson(stateResponse);
    const snapshot = (statePayload.stateSnapshots as Record<string, Record<string, unknown>>)["cfg-degraded"];
    const degradedState = snapshot?.state as Record<string, unknown> | undefined;
    assert.equal(degradedState?.lastError, "Tesla Fleet API request failed: vehicle data failed");

    const eventsResponse = await fetch(`${runtimeBaseUrl}/events`);
    const eventsPayload = await readJson(eventsResponse);
    const eventTypes = (eventsPayload.events as Array<Record<string, unknown>>).map((event) => event.eventType);
    assert.ok(eventTypes.includes("tesla.refresh.degraded"));
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("state and diagnostics stay empty and consistent before configuration", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const state = await fetch(`${runtimeBaseUrl}/state`);
    const diagnostics = await fetch(`${runtimeBaseUrl}/diagnostics`);
    const entities = await fetch(`${runtimeBaseUrl}/entities`);

    const statePayload = await readJson(state);
    const diagnosticsPayload = await readJson(diagnostics);
    const entitiesPayload = await readJson(entities);

    assert.equal((statePayload.summary as Record<string, unknown>).activeConfigCount, 0);
    assert.deepEqual((diagnosticsPayload.diagnostics as Record<string, unknown>).activeConfigIds, []);
    assert.deepEqual(entitiesPayload.entities, []);
  } finally {
    await stop();
  }
});

test("unknown routes return 404 JSON payloads", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/not-a-route`);
    assert.equal(response.status, 404);
    const payload = await readJson(response);
    assert.equal(payload.ok, false);
  } finally {
    await stop();
  }
});

test("malformed JSON bodies return JSON 400 errors instead of HTML error pages", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const response = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...buildHeaders(),
        "Content-Type": "application/json",
      },
      body: "{\"vin\":",
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
    const payload = await readJson(response);
    assert.equal(payload.reason, "Malformed JSON body");
  } finally {
    await stop();
  }
});

test("manifest contract stays aligned with runtime route exports and command metadata", async () => {
  resetRuntimeState();
  const { runtimeBaseUrl, stop, mockCore } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const manifestResponse = await fetch(`${runtimeBaseUrl}/manifest.json`);
    const entitiesResponse = await fetch(`${runtimeBaseUrl}/entities`);
    const uiResponse = await fetch(`${runtimeBaseUrl}/ui-config`);

    const manifest = await readJson(manifestResponse);
    const entities = await readJson(entitiesResponse);
    const ui = await readJson(uiResponse);

    const endpoints = (manifest.api as Record<string, unknown>).endpoints as Record<string, unknown>;
    assert.equal(endpoints.health, "/health");
    assert.equal(endpoints.config_sync, "/configs/sync");
    assert.equal((manifest.config as Record<string, unknown>).endpoint, "/ui-config");
    assert.deepEqual(Object.keys((manifest.commands as Record<string, unknown>)).sort(), ["refresh", "wake_up"]);
    assert.deepEqual(Object.keys((entities.commands as Record<string, unknown>)).sort(), ["refresh", "wake_up"]);
    assert.equal(((ui.schema as Record<string, unknown>).required as string[]).includes("access_token"), true);
  } finally {
    await stop();
  }
});
