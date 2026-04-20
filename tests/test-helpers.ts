import http from "node:http";

import { MockCoreServer } from "piphi-runtime-testkit-node";

import { createTeslaRuntimeServer } from "../src/server.js";

export const defaultVehicleList = [
  {
    id: 1,
    vehicle_id: 123,
    vin: "5YJ3E1EA7LF000000",
    display_name: "Model 3",
    state: "online",
    in_service: false,
  },
];

export const defaultVehicleSummary = {
  id: 1,
  vehicle_id: 123,
  vin: "5YJ3E1EA7LF000000",
  display_name: "Model 3",
  state: "online",
  in_service: false,
};

export const defaultVehicleData = {
  state: "online",
  charge_state: {
    battery_level: 78,
    usable_battery_level: 77,
    charging_state: "Stopped",
    charge_limit_soc: 90,
    time_to_full_charge: 0,
    charger_power: 0,
  },
  climate_state: {
    inside_temp: 21.5,
    outside_temp: 16.0,
    is_climate_on: false,
  },
  drive_state: {
    latitude: 42.3601,
    longitude: -71.0589,
    heading: 180,
    speed: 0,
    shift_state: null,
  },
  vehicle_state: {
    locked: true,
    odometer: 12345.6,
  },
};

export const defaultWakeSummary = {
  id: 1,
  vehicle_id: 123,
  vin: "5YJ3E1EA7LF000000",
  display_name: "Model 3",
  state: "online",
  in_service: false,
};

export async function startHttpServer(server: http.Server): Promise<{ server: http.Server; baseUrl: string }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not expose a numeric port");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

export class FakeTeslaServer {
  readonly server = http.createServer((req, res) => {
    void this.handle(req, res);
  });

  vehicleState = "online";
  vehicles: Array<Record<string, unknown>> = structuredClone(defaultVehicleList) as Array<Record<string, unknown>>;
  summaryPayload: Record<string, unknown> = structuredClone(defaultVehicleSummary) as Record<string, unknown>;
  vehicleDataPayload: Record<string, unknown> = structuredClone(defaultVehicleData) as Record<string, unknown>;
  wakePayload: Record<string, unknown> = structuredClone(defaultWakeSummary) as Record<string, unknown>;
  failList = false;
  failSummary = false;
  failVehicleData = false;
  failWake = false;
  missingListResponse = false;
  missingSummaryResponse = false;
  missingVehicleDataResponse = false;
  missingWakeResponse = false;

  async start(): Promise<{ baseUrl: string }> {
    const started = await startHttpServer(this.server);
    return { baseUrl: started.baseUrl };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  private vehicleForVin(vin: string): Record<string, unknown> {
    return this.vehicles.find((vehicle) => vehicle.vin === vin) ?? {
      ...defaultVehicleSummary,
      vin,
      display_name: vin,
      state: this.vehicleState,
      in_service: false,
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const summaryMatch = pathname.match(/^\/api\/1\/vehicles\/([^/]+)$/);
    const vehicleDataMatch = pathname.match(/^\/api\/1\/vehicles\/([^/]+)\/vehicle_data$/);
    const wakeMatch = pathname.match(/^\/api\/1\/vehicles\/([^/]+)\/wake_up$/);

    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (pathname === "/api/1/vehicles" && req.method === "GET") {
      if (this.failList) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error_description: "vehicle list failed" }));
        return;
      }
      if (this.missingListResponse) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(
        JSON.stringify({
          response: this.vehicles.map((vehicle) => ({
            ...vehicle,
            state: vehicle.vin === "5YJ3E1EA7LF000000" ? this.vehicleState : vehicle.state,
          })),
        }),
      );
      return;
    }

    if (summaryMatch && req.method === "GET") {
      const vin = decodeURIComponent(summaryMatch[1] ?? "");
      if (this.failSummary) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error_description: "vehicle summary failed" }));
        return;
      }
      if (this.missingSummaryResponse) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const vehicle = this.vehicleForVin(vin);
      res.end(
        JSON.stringify({
          response: {
            ...vehicle,
            ...this.summaryPayload,
            vin,
            state: vin === "5YJ3E1EA7LF000000" ? this.vehicleState : (vehicle.state ?? "online"),
          },
        }),
      );
      return;
    }

    if (vehicleDataMatch && req.method === "GET") {
      const vin = decodeURIComponent(vehicleDataMatch[1] ?? "");
      if (this.failVehicleData) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error_description: "vehicle data failed" }));
        return;
      }
      if (this.missingVehicleDataResponse) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const vehicle = this.vehicleForVin(vin);
      const effectiveState =
        vin === "5YJ3E1EA7LF000000" ? this.vehicleState : String(vehicle.state ?? "online");
      if (effectiveState !== "online") {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: "vehicle unavailable" }));
        return;
      }
      res.end(
        JSON.stringify({
          response: {
            ...this.vehicleDataPayload,
            state: effectiveState,
          },
        }),
      );
      return;
    }

    if (wakeMatch && req.method === "POST") {
      const vin = decodeURIComponent(wakeMatch[1] ?? "");
      if (this.failWake) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error_description: "wake failed" }));
        return;
      }
      if (this.missingWakeResponse) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (vin === "5YJ3E1EA7LF000000") {
        this.vehicleState = "online";
      }
      const vehicle = this.vehicleForVin(vin);
      res.end(
        JSON.stringify({
          response: {
            ...vehicle,
            ...this.wakePayload,
            vin,
            state: "online",
          },
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }
}

export async function startRuntimeAndCore(): Promise<{
  runtimeBaseUrl: string;
  stop: () => Promise<void>;
  mockCore: MockCoreServer;
}> {
  const runtime = await startHttpServer(createTeslaRuntimeServer());
  const mockCore = await new MockCoreServer().start();
  return {
    runtimeBaseUrl: runtime.baseUrl,
    mockCore,
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        runtime.server.close((error) => (error ? reject(error) : resolve())),
      );
      await mockCore.stop();
    },
  };
}
