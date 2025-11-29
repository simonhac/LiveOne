/**
 * Tesla vehicle data types based on teslapy library / Tesla API
 */

export interface TeslaCredentials {
  accessToken: string;
  refreshToken: string;
  vehicleId?: string; // Optional: specific vehicle ID if multiple vehicles
}

export interface TeslaVehicle {
  id: string;
  vehicle_id: number;
  vin: string;
  display_name: string;
  state: "online" | "asleep" | "offline";
}

export interface TeslaChargeState {
  battery_level: number; // 0-100%
  battery_range: number; // miles
  charge_limit_soc: number; // 50-100%
  charging_state:
    | "Charging"
    | "Complete"
    | "Disconnected"
    | "Stopped"
    | "NoPower";
  charge_rate: number; // miles/hour
  charge_amps: number; // Amps
  charge_current_request: number; // Requested amps
  charger_voltage: number; // Volts
  charger_power: number; // kW
  time_to_full_charge: number; // hours
  charge_port_door_open: boolean;
  charge_port_latch: "Engaged" | "Disengaged" | "Blocking";
  scheduled_charging_pending: boolean;
  scheduled_charging_start_time: number | null; // Unix timestamp
  usable_battery_level: number; // Usable SoC (may differ from battery_level in cold)
}

export interface TeslaDriveState {
  speed: number | null; // mph (null if stationary)
  heading: number; // 0-359 degrees
  latitude: number;
  longitude: number;
  timestamp: number; // Unix timestamp ms
  gps_as_of: number; // Unix timestamp when GPS was updated
}

export interface TeslaVehicleState {
  odometer: number; // miles (decimal)
  locked: boolean;
  car_version: string;
  sentry_mode: boolean;
  sentry_mode_available: boolean;
  valet_mode: boolean;
  df: number; // Driver front door (0 = closed)
  dr: number; // Driver rear
  pf: number; // Passenger front
  pr: number; // Passenger rear
  ft: number; // Front trunk
  rt: number; // Rear trunk
  is_user_present: boolean;
}

export interface TeslaClimateState {
  inside_temp: number | null; // Celsius
  outside_temp: number | null; // Celsius
  driver_temp_setting: number;
  passenger_temp_setting: number;
  is_climate_on: boolean;
  is_preconditioning: boolean;
  battery_heater: boolean;
  battery_heater_no_power: boolean | null;
  seat_heater_left: number; // 0-3
  seat_heater_right: number;
}

export interface TeslaVehicleConfig {
  car_type: string; // e.g., "modely", "model3", "models", "modelx"
  exterior_color: string;
  wheel_type: string;
  has_air_suspension: boolean;
  motorized_charge_port: boolean;
  plg: boolean; // Plus package
  rhd: boolean; // Right-hand drive
  rear_seat_heaters: number;
}

/**
 * Complete vehicle data response
 */
export interface TeslaVehicleData {
  id: string;
  vehicle_id: number;
  vin: string;
  display_name: string;
  state: string;
  charge_state: TeslaChargeState;
  drive_state: TeslaDriveState;
  vehicle_state: TeslaVehicleState;
  climate_state: TeslaClimateState;
  vehicle_config: TeslaVehicleConfig;
}

/**
 * Simplified location data for home detection
 */
export interface TeslaLocation {
  latitude: number;
  longitude: number;
  heading: number;
  timestamp: number;
}

/**
 * Token response from Tesla OAuth
 */
export interface TeslaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Point metadata definitions for Tesla data points
 */
export const TESLA_POINTS = {
  // Battery/Charging
  battery_soc: {
    physicalPathTail: "battery_soc",
    logicalPathStem: "vehicle.battery",
    metricType: "soc",
    metricUnit: "%",
    defaultName: "Battery SoC",
  },
  usable_battery_soc: {
    physicalPathTail: "usable_battery_soc",
    logicalPathStem: "vehicle.battery.usable",
    metricType: "soc",
    metricUnit: "%",
    defaultName: "Usable Battery SoC",
  },
  battery_range: {
    physicalPathTail: "battery_range",
    logicalPathStem: "vehicle.battery.range",
    metricType: "distance",
    metricUnit: "mi",
    defaultName: "Battery Range",
  },
  charge_limit: {
    physicalPathTail: "charge_limit",
    logicalPathStem: "vehicle.charge.limit",
    metricType: "soc",
    metricUnit: "%",
    defaultName: "Charge Limit",
  },
  charging_state: {
    physicalPathTail: "charging_state",
    logicalPathStem: "vehicle.charge.state",
    metricType: "state",
    metricUnit: "text",
    defaultName: "Charging State",
  },
  charge_amps: {
    physicalPathTail: "charge_amps",
    logicalPathStem: "vehicle.charge.current",
    metricType: "current",
    metricUnit: "A",
    defaultName: "Charge Current",
  },
  charger_voltage: {
    physicalPathTail: "charger_voltage",
    logicalPathStem: "vehicle.charge.voltage",
    metricType: "voltage",
    metricUnit: "V",
    defaultName: "Charger Voltage",
  },
  charger_power: {
    physicalPathTail: "charger_power",
    logicalPathStem: "vehicle.charge.power",
    metricType: "power",
    metricUnit: "kW",
    defaultName: "Charger Power",
  },
  charge_rate: {
    physicalPathTail: "charge_rate",
    logicalPathStem: "vehicle.charge.rate",
    metricType: "rate",
    metricUnit: "mi/h",
    defaultName: "Charge Rate",
  },
  time_to_full_charge: {
    physicalPathTail: "time_to_full_charge",
    logicalPathStem: "vehicle.charge.time_remaining",
    metricType: "duration",
    metricUnit: "h",
    defaultName: "Time to Full Charge",
  },
  plugged_in: {
    physicalPathTail: "plugged_in",
    logicalPathStem: "vehicle.charge.plugged_in",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Plugged In",
  },

  // Location/Drive
  latitude: {
    physicalPathTail: "latitude",
    logicalPathStem: "vehicle.location.lat",
    metricType: "coordinate",
    metricUnit: "deg",
    defaultName: "Latitude",
  },
  longitude: {
    physicalPathTail: "longitude",
    logicalPathStem: "vehicle.location.lon",
    metricType: "coordinate",
    metricUnit: "deg",
    defaultName: "Longitude",
  },
  heading: {
    physicalPathTail: "heading",
    logicalPathStem: "vehicle.location.heading",
    metricType: "angle",
    metricUnit: "deg",
    defaultName: "Heading",
  },
  speed: {
    physicalPathTail: "speed",
    logicalPathStem: "vehicle.drive.speed",
    metricType: "speed",
    metricUnit: "mph",
    defaultName: "Speed",
  },

  // Odometer
  odometer: {
    physicalPathTail: "odometer",
    logicalPathStem: "vehicle.odometer",
    metricType: "distance",
    metricUnit: "mi",
    defaultName: "Odometer",
  },

  // Climate
  inside_temp: {
    physicalPathTail: "inside_temp",
    logicalPathStem: "vehicle.climate.inside_temp",
    metricType: "temperature",
    metricUnit: "C",
    defaultName: "Inside Temperature",
  },
  outside_temp: {
    physicalPathTail: "outside_temp",
    logicalPathStem: "vehicle.climate.outside_temp",
    metricType: "temperature",
    metricUnit: "C",
    defaultName: "Outside Temperature",
  },
  climate_on: {
    physicalPathTail: "climate_on",
    logicalPathStem: "vehicle.climate.active",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Climate On",
  },

  // Vehicle state
  locked: {
    physicalPathTail: "locked",
    logicalPathStem: "vehicle.security.locked",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Locked",
  },
  sentry_mode: {
    physicalPathTail: "sentry_mode",
    logicalPathStem: "vehicle.security.sentry",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Sentry Mode",
  },
  car_version: {
    physicalPathTail: "car_version",
    logicalPathStem: "vehicle.software.version",
    metricType: "state",
    metricUnit: "text",
    defaultName: "Software Version",
  },
} as const;

export type TeslaPointKey = keyof typeof TESLA_POINTS;
