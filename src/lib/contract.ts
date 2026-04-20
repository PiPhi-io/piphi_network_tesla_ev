export const integrationId = "piphi-network-tesla-ev";
export const integrationName = "PiPhi Network Tesla EV";
export const integrationVersion = "0.1.0";

export const manifestCapabilities = {
  online: { kind: "sensor" },
  battery_level: { kind: "sensor", unit: "%" },
  usable_battery_level: { kind: "sensor", unit: "%" },
  charging_state: { kind: "sensor" },
  charge_limit_soc: { kind: "sensor", unit: "%" },
  time_to_full_charge_hours: { kind: "sensor", unit: "h" },
  charger_power_kw: { kind: "sensor", unit: "kW" },
  inside_temp_c: { kind: "sensor", unit: "C" },
  outside_temp_c: { kind: "sensor", unit: "C" },
  climate_on: { kind: "sensor" },
  is_locked: { kind: "sensor" },
  odometer_miles: { kind: "sensor", unit: "mi" },
  speed_mph: { kind: "sensor", unit: "mph" },
  latitude: { kind: "sensor", unit: "degrees" },
  longitude: { kind: "sensor", unit: "degrees" },
  refresh: { kind: "action" },
  wake_up: { kind: "action" },
} as const;

export const manifestCommands = {
  refresh: {
    description: "Fetch live Tesla vehicle_data and publish the latest telemetry snapshot.",
    timeout_ms: 15000,
  },
  wake_up: {
    description: "Wake a sleeping Tesla before requesting a live vehicle_data refresh.",
    timeout_ms: 30000,
  },
} as const;

export const fleetApiBaseUrls = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  cn: "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
} as const;

export type TeslaRegion = keyof typeof fleetApiBaseUrls;

export const uiConfig = {
  schema: {
    title: "Tesla EV Setup",
    description:
      "Paste a Tesla Fleet API access token, choose the region, and select one vehicle VIN.",
    type: "object",
    required: ["vin", "access_token"],
    properties: {
      vin: {
        type: "string",
        title: "Vehicle VIN",
        description: "Tesla VIN to bind to this PiPhi config.",
      },
      vehicle_name: {
        type: "string",
        title: "Vehicle Name",
        description: "Optional PiPhi label override.",
      },
      region: {
        type: "string",
        title: "Fleet API Region",
        enum: ["na", "eu", "cn"],
        default: "na",
      },
      access_token: {
        type: "string",
        title: "Fleet API Access Token",
        description: "OAuth access token with Tesla vehicle scopes.",
      },
      include_location: {
        type: "boolean",
        title: "Include Location Metrics",
        default: true,
      },
      base_url: {
        type: "string",
        title: "Fleet API Base URL Override",
        description: "Optional testing override for the Tesla base URL.",
      },
    },
  },
  uiSchema: {
    vin: {
      "ui:placeholder": "5YJ3E1EA7LF000000",
    },
    vehicle_name: {
      "ui:placeholder": "Garage Tesla",
    },
    access_token: {
      "ui:widget": "password",
    },
    base_url: {
      "ui:placeholder": "https://fleet-api.prd.na.vn.cloud.tesla.com",
    },
  },
} as const;
