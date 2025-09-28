/**
 * Internal types for Enphase vendor implementation
 * These types are only used within the Enphase vendor module
 */

export interface EnphaseTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  enl_uid?: string;
  enl_cid?: string;
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
  // Raw vendor response for consistency with SelectronicData
  raw?: Record<string, any>;
  rawResponse?: any;                       // Raw response object from API
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