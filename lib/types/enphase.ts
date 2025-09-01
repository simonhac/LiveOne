// Enphase API Types

export interface EnphaseTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  enl_uid?: string;
  enl_cid?: string;
}

export interface EnphaseCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  enphase_system_id: string;
  enphase_user_id?: string;
  created_at?: number;  // Unix timestamp when credentials were stored
}

export interface EnphaseTelemetryResponse {
  system_id?: string;
  production_power?: number | null;        // Watts
  consumption_power?: number | null;       // Watts  
  storage_power?: number | null;          // Watts (negative = charging)
  grid_power?: number | null;             // Watts
  storage_energy_charged?: number | null; // Wh
  storage_energy_discharged?: number | null; // Wh
  production_energy_lifetime?: number | null; // Wh
  consumption_energy_lifetime?: number | null; // Wh
  storage_soc?: number | null;            // Percentage
  last_report_at?: number | null;         // Unix timestamp
  // Additional fields from summary endpoint
  energy_today?: number | null;           // Wh for today
  energy_lifetime?: number | null;        // Total lifetime Wh
  system_size?: number | null;            // System size in W
}

export interface EnphaseSystem {
  system_id: string;
  name: string;
  timezone: string;
  connection_type: string;
  status: string;
  address?: {
    city?: string;
    state?: string;
    country?: string;
    postal_code?: string;
  };
  system_size?: number;
}

// Common polling data format (shared with Selectronic)
export interface PollingData {
  timestamp: string;
  solarW: number;
  solarInverterW: number;
  shuntW: number;
  loadW: number;
  batteryW: number;
  gridW: number;
  batterySOC: number;
  faultCode: number;
  faultTimestamp: number;
  generatorStatus: number;
  solarKwhTotal: number;
  loadKwhTotal: number;
  batteryInKwhTotal: number;
  batteryOutKwhTotal: number;
  gridInKwhTotal: number;
  gridOutKwhTotal: number;
}