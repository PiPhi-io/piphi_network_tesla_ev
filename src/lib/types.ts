import type { RuntimeConfig } from "piphi-runtime-kit-node";

import type { TeslaRegion } from "./contract.js";

export interface TeslaVehicleConfig extends RuntimeConfig {
  vin: string;
  access_token: string;
  region?: TeslaRegion;
  vehicle_name?: string | null;
  include_location?: boolean;
  base_url?: string | null;
}

export interface TeslaVehicleSummary {
  id?: number | string | null;
  vehicle_id?: number | null;
  vin: string;
  display_name?: string | null;
  state?: string | null;
  in_service?: boolean | null;
}

export interface TeslaVehicleState {
  deviceId: string;
  configId: string;
  vin: string;
  displayName: string;
  region: TeslaRegion;
  baseUrl: string;
  online: boolean;
  vehicleState: string;
  inService: boolean;
  includeLocation: boolean;
  batteryLevel: number | null;
  usableBatteryLevel: number | null;
  chargingState: string | null;
  chargeLimitSoc: number | null;
  timeToFullChargeHours: number | null;
  chargerPowerKw: number | null;
  batteryRangeMiles: number | null;
  chargeCurrentAmps: number | null;
  chargeEnergyAddedKwh: number | null;
  pluggedIn: boolean | null;
  insideTempC: number | null;
  outsideTempC: number | null;
  climateOn: boolean | null;
  isLocked: boolean | null;
  odometerMiles: number | null;
  speedMph: number | null;
  latitude: number | null;
  longitude: number | null;
  headingDegrees: number | null;
  shiftState: string | null;
  lastRefreshAt: string | null;
  lastCommandAt: string | null;
  lastError: string | null;
  source: "summary" | "vehicle_data";
  summary: TeslaVehicleSummary;
}

export interface TeslaRuntimeEntry {
  configId: string;
  deviceId: string;
  vin: string;
  displayName: string;
  region: TeslaRegion;
  baseUrl: string;
  containerId?: string | null;
  integrationId?: string | null;
  config: TeslaVehicleConfig;
  latestState?: TeslaVehicleState;
  lastUpdated?: string;
}

export interface TeslaLocalEvent extends Record<string, unknown> {
  eventType: string;
  ts: string;
  severity: "debug" | "info" | "warning" | "error";
  deviceId: string | null;
  configId: string | null;
  payload: Record<string, unknown>;
}

export interface DiscoverVehiclesOptions {
  accessToken: string;
  region?: TeslaRegion;
  baseUrl?: string | null;
}

export interface TeslaCommandPayload {
  command?: string;
  configId?: string | null;
  config_id?: string | null;
  deviceId?: string | null;
  device_id?: string | null;
  contractVersion?: string | null;
  contract_version?: string | null;
  capability?: string | null;
  capabilityRequirements?: string[];
  capability_requirements?: string[];
  target?: Record<string, unknown>;
  params?: Record<string, unknown>;
  args?: Record<string, unknown>;
}
