import assert from "node:assert/strict";
import test from "node:test";

import { MockCoreServer } from "piphi-runtime-testkit-node";

import { buildConfigSyncResponse } from "../src/server_helpers.js";
import {
  appendLocalEvent,
  applyTeslaConfig,
  diagnosticsPayload,
  discoverTeslaVehicles,
  entitiesPayload,
  getEventsPayload,
  getStatePayload,
  healthPayload,
  refreshEntry,
  registry,
  removeTeslaConfig,
  runTeslaCommand,
  starter,
} from "../src/lib/runtime.js";
import type { TeslaVehicleConfig } from "../src/lib/types.js";
import { FakeTeslaServer } from "./test-helpers.js";

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

function buildConfig(baseUrl: string, overrides: Partial<TeslaVehicleConfig> = {}): TeslaVehicleConfig {
  return {
    id: "cfg-helper",
    configId: "cfg-helper",
    vin: "5YJ3E1EA7LF000000",
    access_token: "test-token",
    region: "na",
    base_url: baseUrl,
    ...overrides,
  };
}

test("appendLocalEvent defaults severity and stores recent events", () => {
  resetRuntimeState();
  const event = appendLocalEvent({
    eventType: "tesla.test.event",
    deviceId: "vehicle-1",
    configId: "cfg-1",
    payload: { ok: true },
  });

  assert.equal(event.eventType, "tesla.test.event");
  assert.equal(event.severity, "info");
  assert.equal(event.deviceId, "vehicle-1");
  assert.equal(registry.recentEvents.length, 1);
});

test("buildConfigSyncResponse defaults generation to null and empty skipped ids", () => {
  const payload = buildConfigSyncResponse({
    appliedConfigIds: ["cfg-1"],
    removedConfigIds: ["cfg-2"],
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.generation, null);
  assert.deepEqual(payload.skippedConfigIds, []);
});

test("health, diagnostics, state, entities, and events helpers return consistent empty payloads", () => {
  resetRuntimeState();
  const health = healthPayload();
  const diagnostics = diagnosticsPayload();
  const state = getStatePayload();
  const entities = entitiesPayload();
  const events = getEventsPayload();

  assert.equal(health.ok, true);
  assert.equal((health.metadata as Record<string, unknown>).activeConfigs, 0);
  assert.deepEqual((diagnostics.diagnostics as Record<string, unknown>).activeConfigIds, []);
  assert.equal((state.summary as Record<string, unknown>).activeConfigCount, 0);
  assert.deepEqual(entities.entities, []);
  assert.deepEqual(events.events, []);
});

test("entitiesPayload skips stale registry ids that no longer resolve to entries", () => {
  resetRuntimeState();
  const originalIds = registry.ids;
  const originalGet = registry.get;

  registry.ids = (() => ["cfg-stale"]) as typeof registry.ids;
  registry.get = ((_configId: string) => undefined) as typeof registry.get;

  try {
    const entities = entitiesPayload();
    assert.deepEqual(entities.entities, []);
  } finally {
    registry.ids = originalIds;
    registry.get = originalGet;
  }
});

test("discoverTeslaVehicles defaults region and trims empty override inputs", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl } = await fakeTesla.start();

  try {
    const payload = await discoverTeslaVehicles({
      accessToken: "test-token",
      baseUrl,
    });
    const device = payload.devices[0] as Record<string, unknown>;
    assert.equal(device.region, "na");
    assert.deepEqual(device.inputs, {
      access_token: "test-token",
      base_url: baseUrl,
    });
  } finally {
    await fakeTesla.stop();
  }
});

test("applyTeslaConfig stores entries and helper payloads reflect the configured vehicle", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const mockCore = await new MockCoreServer().start();
  const { baseUrl } = await fakeTesla.start();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    starter.runtime.auth.update({
      containerId: "container-helper",
      internalToken: "internal-helper",
    });

    const result = await applyTeslaConfig(buildConfig(baseUrl, {
      containerId: "container-helper",
      integrationId: "integration-helper",
    }));

    assert.equal(result.response.ok, true);
    assert.equal(result.response.containerId, "container-helper");
    assert.equal(result.entry.containerId, "container-helper");
    assert.equal(result.entry.integrationId, "integration-helper");
    assert.equal(registry.ids().length, 1);

    const entities = entitiesPayload();
    const entity = entities.entities[0] as Record<string, unknown>;
    assert.equal(entity.configId, "cfg-helper");
    assert.equal(entity.deviceId, "5YJ3E1EA7LF000000");

    const diagnostics = diagnosticsPayload();
    assert.deepEqual((diagnostics.diagnostics as Record<string, unknown>).configuredVehicles, [
      "5YJ3E1EA7LF000000",
    ]);
  } finally {
    await fakeTesla.stop();
    await mockCore.stop();
  }
});

test("applyTeslaConfig keeps a degraded state snapshot and warning event when refresh falls back", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.failVehicleData = true;
  const mockCore = await new MockCoreServer().start();
  const { baseUrl } = await fakeTesla.start();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const result = await applyTeslaConfig(buildConfig(baseUrl, {
      id: "cfg-helper-degraded",
      configId: "cfg-helper-degraded",
    }));

    assert.equal(result.response.ok, true);
    assert.equal(result.entry.latestState?.lastError, "Tesla Fleet API request failed: vehicle data failed");

    const snapshot = registry.stateSnapshots.get("cfg-helper-degraded");
    assert.equal(
      snapshot?.state?.lastError,
      "Tesla Fleet API request failed: vehicle data failed",
    );

    const events = getEventsPayload().events as Array<Record<string, unknown>>;
    assert.ok(events.some((event) => event.eventType === "tesla.refresh.degraded"));
  } finally {
    await fakeTesla.stop();
    await mockCore.stop();
  }
});

test("refreshEntry keeps summary-only state when Tesla reports a sleeping vehicle", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.vehicleState = "asleep";
  const mockCore = await new MockCoreServer().start();
  const { baseUrl } = await fakeTesla.start();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    await applyTeslaConfig(buildConfig(baseUrl));

    const refreshed = await refreshEntry("cfg-helper");
    assert.equal(refreshed.latestState?.vehicleState, "asleep");
    assert.equal(refreshed.latestState?.source, "summary");
    assert.equal(mockCore.telemetryRequests.length, 2);
    const latest = mockCore.telemetryRequests.at(-1);
    assert.equal(latest?.body?.metrics?.battery_level, null);
  } finally {
    await fakeTesla.stop();
    await mockCore.stop();
  }
});

test("runTeslaCommand wake_up updates lastCommandAt on the stored state", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  fakeTesla.vehicleState = "asleep";
  const mockCore = await new MockCoreServer().start();
  const { baseUrl } = await fakeTesla.start();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    await applyTeslaConfig(buildConfig(baseUrl, { id: "cfg-wake", configId: "cfg-wake" }));

    const result = await runTeslaCommand({
      configId: "cfg-wake",
      command: "wake_up",
    });

    const state = result.state as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(state.vehicleState, "online");
    assert.equal(typeof state.lastCommandAt, "string");
    assert.ok((getEventsPayload().events as Array<Record<string, unknown>>).some((event) => event.eventType === "tesla.vehicle.woken"));
  } finally {
    await fakeTesla.stop();
    await mockCore.stop();
  }
});

test("removeTeslaConfig deletes entries and records removal events", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const mockCore = await new MockCoreServer().start();
  const { baseUrl } = await fakeTesla.start();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    await applyTeslaConfig(buildConfig(baseUrl, { id: "cfg-remove", configId: "cfg-remove" }));
    const removed = await removeTeslaConfig("cfg-remove");
    assert.equal(removed.removed, true);
    assert.equal(registry.get("cfg-remove"), undefined);
    assert.ok((getEventsPayload().events as Array<Record<string, unknown>>).some((event) => event.eventType === "tesla.config.removed"));
  } finally {
    await fakeTesla.stop();
    await mockCore.stop();
  }
});

test("refreshEntry throws for unknown configs", async () => {
  resetRuntimeState();
  await assert.rejects(() => refreshEntry("cfg-missing"), /Unknown Tesla config: cfg-missing/);
});
