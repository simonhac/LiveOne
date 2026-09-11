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

export interface EnphaseDevice {
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
