/**
 * Tesla API Type Definitions
 */

// OAuth token response from Tesla
export interface TeslaTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

// Vehicle from Tesla API
export interface TeslaVehicle {
  id: number;
  vehicle_id: number;
  vin: string;
  display_name: string;
  state: "online" | "asleep" | "offline";
}

// Charge state from vehicle_data
export interface TeslaChargeState {
  battery_level: number; // 0-100
  charging_state:
    | "Disconnected"
    | "NoPower"
    | "Starting"
    | "Charging"
    | "Stopped"
    | "Complete";
  charge_port_latch: "Engaged" | "Disengaged";
  charge_amps: number;
  charger_power: number; // kW
  charge_rate: number; // mi/hr
  time_to_full_charge: number; // hours
  charger_voltage: number;
  charge_limit_soc: number;
}

// Drive state from vehicle_data
export interface TeslaDriveState {
  latitude: number;
  longitude: number;
  speed: number | null; // mph, null when parked
  heading: number;
}

// Vehicle state from vehicle_data
export interface TeslaVehicleState {
  odometer: number;
  locked: boolean;
  car_version: string;
}

// Full vehicle data response
export interface TeslaVehicleData {
  id: number;
  vehicle_id: number;
  vin: string;
  display_name: string;
  state: "online" | "asleep" | "offline";
  charge_state: TeslaChargeState;
  drive_state: TeslaDriveState;
  vehicle_state: TeslaVehicleState;
}

// Credentials stored in Clerk
export interface TeslaCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: Date | string;
  vehicle_id: string; // Tesla vehicle ID (stored as string for consistency)
}
