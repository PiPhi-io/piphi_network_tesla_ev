import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeHeaders } from "piphi-runtime-testkit-node";

import { registry, starter } from "../src/lib/runtime.js";
import { FakeTeslaServer, startRuntimeAndCore } from "./test-helpers.js";

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
    containerId: "core-flow-container",
    internalToken: "core-flow-token",
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("core-like flow can discover configure refresh inspect and deconfigure a Tesla vehicle", async () => {
  resetRuntimeState();
  const fakeTesla = new FakeTeslaServer();
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();

    const health = await fetch(`${runtimeBaseUrl}/health`);
    const ui = await fetch(`${runtimeBaseUrl}/ui-config`);
    assert.equal(health.status, 200);
    assert.equal(ui.status, 200);

    const discovery = await fetch(`${runtimeBaseUrl}/discover`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
      }),
    });
    assert.equal(discovery.status, 200);
    const discoveryPayload = await readJson(discovery);
    const device = (discoveryPayload.devices as Array<Record<string, unknown>>)[0];
    assert.equal(device.vin, "5YJ3E1EA7LF000000");

    const config = await fetch(`${runtimeBaseUrl}/config`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vin: String(device.vin),
        access_token: "test-token",
        region: "na",
        base_url: teslaBaseUrl,
        container_id: "core-flow-container",
      }),
    });
    assert.equal(config.status, 200);
    const configPayload = await readJson(config);
    assert.equal(configPayload.ok, true);
    const configId = String(configPayload.configId);

    const entities = await fetch(`${runtimeBaseUrl}/entities`);
    const state = await fetch(`${runtimeBaseUrl}/state`);
    assert.equal(entities.status, 200);
    assert.equal(state.status, 200);

    const refresh = await fetch(`${runtimeBaseUrl}/command`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "refresh",
      }),
    });
    assert.equal(refresh.status, 200);
    const refreshPayload = await readJson(refresh);
    assert.equal(refreshPayload.configId, configId);

    const events = await fetch(`${runtimeBaseUrl}/events`);
    const diagnostics = await fetch(`${runtimeBaseUrl}/diagnostics`);
    assert.equal(events.status, 200);
    assert.equal(diagnostics.status, 200);

    const eventsPayload = await readJson(events);
    const eventTypes = (eventsPayload.events as Array<Record<string, unknown>>).map((event) => event.eventType);
    assert.ok(eventTypes.includes("tesla.config.applied"));
    assert.ok(eventTypes.includes("tesla.vehicle.refreshed"));

    assert.ok(mockCore.telemetryRequests.length >= 1);
    const latestTelemetry = mockCore.telemetryRequests.at(-1);
    assert.equal(latestTelemetry?.body?.containerId, "core-flow-container");

    const deconfigure = await fetch(`${runtimeBaseUrl}/deconfigure`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config_id: configId,
      }),
    });
    assert.equal(deconfigure.status, 200);
    assert.equal((await readJson(deconfigure)).removed, true);

    const finalState = await fetch(`${runtimeBaseUrl}/state`);
    const finalPayload = await readJson(finalState);
    assert.equal((finalPayload.summary as Record<string, unknown>).activeConfigCount, 0);
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

test("core-like snapshot sync flow can replace active Tesla configs cleanly", async () => {
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
      id: 2,
      vehicle_id: 456,
      vin: "7SAYGDEE0PF000001",
      display_name: "Model Y",
      state: "online",
      in_service: false,
    },
  ];
  const { baseUrl: teslaBaseUrl } = await fakeTesla.start();
  const { runtimeBaseUrl, mockCore, stop } = await startRuntimeAndCore();

  try {
    starter.runtime.processState.coreBaseUrl = mockCore.baseUrl;
    const headers = buildHeaders();

    const firstSync = await fetch(`${runtimeBaseUrl}/configs/sync`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        generation: 1,
        configs: [
          {
            id: "cfg-model-3",
            configId: "cfg-model-3",
            vin: "5YJ3E1EA7LF000000",
            access_token: "test-token",
            region: "na",
            base_url: teslaBaseUrl,
          },
        ],
      }),
    });
    assert.equal(firstSync.status, 200);

    const secondSync = await fetch(`${runtimeBaseUrl}/configs/sync`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        generation: 2,
        configs: [
          {
            id: "cfg-model-y",
            configId: "cfg-model-y",
            vin: "7SAYGDEE0PF000001",
            access_token: "test-token",
            region: "na",
            base_url: teslaBaseUrl,
          },
        ],
      }),
    });
    assert.equal(secondSync.status, 200);
    const secondPayload = await readJson(secondSync);
    assert.deepEqual(secondPayload.appliedConfigIds, ["cfg-model-y"]);
    assert.deepEqual(secondPayload.removedConfigIds, ["cfg-model-3"]);
    assert.equal(secondPayload.generation, 2);

    const state = await fetch(`${runtimeBaseUrl}/state`);
    const statePayload = await readJson(state);
    assert.equal((statePayload.summary as Record<string, unknown>).activeConfigCount, 1);
    const entries = statePayload.entries as Record<string, Record<string, unknown>>;
    assert.equal(entries["cfg-model-y"]?.vin, "7SAYGDEE0PF000001");
    assert.equal(entries["cfg-model-3"], undefined);
  } finally {
    await stop();
    await fakeTesla.stop();
  }
});

