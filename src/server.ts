import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";

import { buildConfigSyncResponse } from "./server_helpers.js";
import { uiConfig } from "./lib/contract.js";
import {
  applyTeslaConfig,
  diagnosticsPayload,
  discoverTeslaVehicles,
  entitiesPayload,
  getEventsPayload,
  getStatePayload,
  healthPayload,
  registry,
  removeTeslaConfig,
  runTeslaCommand,
  starter,
} from "./lib/runtime.js";
import type { TeslaRegion } from "./lib/contract.js";
import type { TeslaVehicleConfig } from "./lib/types.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPaths = [
  path.join(currentDir, "manifest.json"),
  path.resolve(currentDir, "../../src/manifest.json"),
];
const app = express();
app.use(express.json());

async function loadManifest(): Promise<Record<string, unknown>> {
  for (const manifestPath of manifestPaths) {
    try {
      return JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  throw new Error("manifest.json could not be found from either the source or built runtime paths");
}

function normalizeHeaders(headers: Request["headers"]): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key] = value.join(", ");
      continue;
    }
    normalized[key] = typeof value === "string" ? value : undefined;
  }
  return normalized;
}

function writeJson(res: Response, statusCode: number, payload: unknown): void {
  res.status(statusCode).json(payload);
}

function getRequestPayload(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function syncRuntimeAuth(req: Request, payload?: Record<string, unknown>): void {
  starter.runtime.auth.syncFromHeaders(
    normalizeHeaders(req.headers),
    typeof payload?.containerId === "string"
      ? payload.containerId
      : typeof payload?.container_id === "string"
        ? payload.container_id
        : null,
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown, fallback = true): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isTeslaRegion(value: string | null): value is TeslaRegion {
  return value === "na" || value === "eu" || value === "cn";
}

function toTeslaConfig(payload: Record<string, unknown>): TeslaVehicleConfig {
  const region = isTeslaRegion(asString(payload.region)) ? (payload.region as TeslaRegion) : "na";
  const configId =
    asString(payload.configId) ??
    asString(payload.config_id) ??
    asString(payload.id) ??
    asString(payload.vin) ??
    "";

  return {
    id: configId,
    configId,
    containerId: asString(payload.containerId) ?? asString(payload.container_id),
    integrationId: asString(payload.integrationId) ?? asString(payload.integration_id),
    vin: asString(payload.vin) ?? "",
    access_token: asString(payload.access_token) ?? "",
    region,
    vehicle_name: asString(payload.vehicle_name),
    include_location: asBoolean(payload.include_location, true),
    base_url: asString(payload.base_url),
  };
}

function wrapAsync(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };
}

app.get("/health", (_req: Request, res: Response) => {
  writeJson(res, 200, healthPayload());
});

app.get("/diagnostics", (_req: Request, res: Response) => {
  writeJson(res, 200, diagnosticsPayload());
});

app.get(["/ui-config", "/ui"], (_req: Request, res: Response) => {
  writeJson(res, 200, uiConfig);
});

app.get("/entities", (_req: Request, res: Response) => {
  writeJson(res, 200, entitiesPayload());
});

app.get("/state", (_req: Request, res: Response) => {
  writeJson(res, 200, getStatePayload());
});

app.get("/events", (_req: Request, res: Response) => {
  writeJson(res, 200, getEventsPayload());
});

app.post(
  ["/discover", "/discovery"],
  wrapAsync(async (req, res) => {
    const body = getRequestPayload(req);
    syncRuntimeAuth(req, body);
    const inputs =
      body.inputs && typeof body.inputs === "object"
        ? (body.inputs as Record<string, unknown>)
        : body;

    const accessToken = asString(inputs.access_token);
    if (!accessToken) {
      writeJson(res, 400, { ok: false, reason: "Missing access_token for discovery" });
      return;
    }

    const region = isTeslaRegion(asString(inputs.region)) ? (inputs.region as TeslaRegion) : "na";
    const payload = await discoverTeslaVehicles({
      accessToken,
      region,
      baseUrl: asString(inputs.base_url),
    });
    writeJson(res, 200, payload);
  }),
);

app.get(
  ["/discover", "/discovery"],
  wrapAsync(async (req, res) => {
    const accessToken = asString(req.query.access_token);
    if (!accessToken) {
      writeJson(res, 400, { ok: false, reason: "Missing access_token for discovery" });
      return;
    }

    const region = isTeslaRegion(asString(req.query.region)) ? (req.query.region as TeslaRegion) : "na";
    const payload = await discoverTeslaVehicles({
      accessToken,
      region,
      baseUrl: asString(req.query.base_url),
    });
    writeJson(res, 200, payload);
  }),
);

app.post(
  "/config",
  wrapAsync(async (req, res) => {
    const body = getRequestPayload(req);
    syncRuntimeAuth(req, body);
    const config = toTeslaConfig(body);
    const result = await applyTeslaConfig(config);
    writeJson(res, 200, result.response);
  }),
);

app.post(
  ["/configs/sync", "/config/sync"],
  wrapAsync(async (req, res) => {
    const body = getRequestPayload(req);
    syncRuntimeAuth(req, body);

    const configs = Array.isArray(body.configs)
      ? body.configs
          .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
          .map((config) => toTeslaConfig(config))
      : [];

    const activeIds = new Set(registry.ids());
    const appliedConfigIds: string[] = [];
    const removedConfigIds: string[] = [];

    for (const config of configs) {
      await applyTeslaConfig(config);
      appliedConfigIds.push(config.configId ?? config.id);
      activeIds.delete(config.configId ?? config.id);
    }

    for (const configId of activeIds) {
      const result = await removeTeslaConfig(configId);
      if (result.removed) {
        removedConfigIds.push(configId);
      }
    }

    writeJson(
      res,
      200,
      buildConfigSyncResponse({
        generation: typeof body.generation === "number" ? body.generation : null,
        appliedConfigIds,
        removedConfigIds,
      }),
    );
  }),
);

app.post(
  "/deconfigure",
  wrapAsync(async (req, res) => {
    const body = getRequestPayload(req);
    syncRuntimeAuth(req, body);
    const configId = asString(body.configId) ?? asString(body.config_id);
    if (!configId) {
      writeJson(res, 400, { ok: false, reason: "Missing configId" });
      return;
    }

    writeJson(res, 200, await removeTeslaConfig(configId));
  }),
);

app.post(
  "/deconfigure/:configId",
  wrapAsync(async (req, res) => {
    const configId = Array.isArray(req.params.configId) ? req.params.configId[0] : req.params.configId;
    writeJson(res, 200, await removeTeslaConfig(configId));
  }),
);

app.post(
  "/command",
  wrapAsync(async (req, res) => {
    const body = getRequestPayload(req);
    syncRuntimeAuth(req, body);
    const target = body.target && typeof body.target === "object" ? body.target as Record<string, unknown> : {};
    const result = await runTeslaCommand({
      command: asString(body.command) ?? undefined,
      configId: asString(body.configId) ?? asString(body.config_id) ?? asString(target.config_id),
      deviceId: asString(body.deviceId) ?? asString(body.device_id) ?? asString(target.device_id),
      contractVersion: asString(body.contractVersion) ?? asString(body.contract_version),
      capability: asString(body.capability),
      capabilityRequirements: Array.isArray(body.capability_requirements)
        ? body.capability_requirements.map((item) => String(item))
        : undefined,
      target,
      params: body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : undefined,
      args: body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : undefined,
    });
    writeJson(res, 200, result);
  }),
);

app.get(
  "/manifest.json",
  wrapAsync(async (_req, res) => {
    const manifest = await loadManifest();
    writeJson(res, 200, manifest);
  }),
);

app.use((req: Request, res: Response) => {
  writeJson(res, 404, { ok: false, reason: `Unknown route ${req.method} ${req.path}` });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (
    error instanceof SyntaxError &&
    "status" in error &&
    (error as SyntaxError & { status?: number }).status === 400
  ) {
    writeJson(res, 400, { ok: false, reason: "Malformed JSON body" });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (res.headersSent) {
    return;
  }
  writeJson(res, 500, { ok: false, error: "runtime_command_failed", reason: message, message });
});

export function createTeslaRuntimeServer(): http.Server {
  return http.createServer(app);
}

export { app };
