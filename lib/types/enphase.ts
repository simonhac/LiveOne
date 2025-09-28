/**
 * Enphase Credentials Type
 * This type is used outside the vendor module by the secure-credentials system
 */

export interface EnphaseCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: Date;  // Date object for token expiry
  enphase_system_id: string;
  enphase_user_id?: string;
  created_at?: Date;  // Date object for when credentials were stored
}

