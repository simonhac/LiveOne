import { storeVendorCredentials, getVendorCredentials, removeVendorCredentials } from '@/lib/secure-credentials';
import type { 
  EnphaseTokens, 
  EnphaseCredentials, 
  EnphaseTelemetryResponse, 
  EnphaseSystem 
} from '@/lib/types/enphase';

// ============================================
// Helper functions for Enphase credentials
// ============================================

/**
 * Store Enphase OAuth tokens (transforms to credential format)
 */
export async function storeEnphaseTokens(
  userId: string,
  tokens: EnphaseTokens,
  systemId: string
) {
  const credentials: EnphaseCredentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in * 1000),
    enphase_system_id: systemId,
    enphase_user_id: tokens.enl_uid,
    created_at: Math.floor(Date.now() / 1000)  // Unix timestamp in seconds
  }
  
  return storeVendorCredentials(userId, 'enphase', credentials)
}

/**
 * Get Enphase credentials specifically
 */
export async function getEnphaseCredentials(
  userId: string
): Promise<EnphaseCredentials | null> {
  return getVendorCredentials(userId, 'enphase') as Promise<EnphaseCredentials | null>
}

// Base client interface
export interface IEnphaseClient {
  getAuthorizationUrl(state: string, origin?: string): string;
  exchangeCodeForTokens(code: string): Promise<EnphaseTokens>;
  refreshTokens(refreshToken: string): Promise<EnphaseTokens>;
  getLatestTelemetry(systemId: string, accessToken: string): Promise<EnphaseTelemetryResponse>;
  getSystems(accessToken: string): Promise<EnphaseSystem[]>;
  storeTokens(userId: string, tokens: EnphaseTokens, systemId: string): Promise<void>;
  getStoredTokens(userId: string): Promise<EnphaseCredentials | null>;
}

// Real Enphase Client
export class EnphaseClient implements IEnphaseClient {
  private apiKey: string;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private baseUrl = 'https://api.enphaseenergy.com';

  constructor() {
    const apiKey = process.env.ENPHASE_API_KEY;
    const clientId = process.env.ENPHASE_CLIENT_ID;
    const clientSecret = process.env.ENPHASE_CLIENT_SECRET;
    const redirectUri = process.env.ENPHASE_REDIRECT_URI;

    if (!apiKey || !clientId || !clientSecret || !redirectUri) {
      const missing = [];
      if (!apiKey) missing.push('ENPHASE_API_KEY');
      if (!clientId) missing.push('ENPHASE_CLIENT_ID');
      if (!clientSecret) missing.push('ENPHASE_CLIENT_SECRET');
      if (!redirectUri) missing.push('ENPHASE_REDIRECT_URI');
      
      console.error('ENPHASE: Missing required environment variables:', missing.join(', '));
      throw new Error(`Enphase configuration incomplete: Missing ${missing.join(', ')}`);
    }

    this.apiKey = apiKey;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;

    console.log('ENPHASE: Client initialized with redirect URI:', this.redirectUri);
  }

  getAuthorizationUrl(state: string, origin?: string): string {
    // For real Enphase, we don't use the origin (it goes to Enphase's server)
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state
    });
    const url = `${this.baseUrl}/oauth/authorize?${params}`;
    console.log('ENPHASE: Generated authorization URL:', url);
    return url;
  }

  async exchangeCodeForTokens(code: string): Promise<EnphaseTokens> {
    console.log('ENPHASE: Exchanging authorization code for tokens');
    console.log('ENPHASE: Token exchange parameters:', {
      grant_type: 'authorization_code',
      code: code.substring(0, 20) + '...',
      redirect_uri: this.redirectUri,
      client_id: this.clientId.substring(0, 10) + '...',
      client_secret: this.clientSecret.substring(0, 10) + '...',
      endpoint: `${this.baseUrl}/oauth/token`,
      auth_method: 'Basic Authentication'
    });
    
    // Try Basic Authentication - encode client_id:client_secret in base64
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    // Only send grant_type, code, and redirect_uri in the body
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri
    });

    try {
      const response = await fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        },
        body: params
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('ENPHASE: Token exchange failed');
        console.error('ENPHASE: Response status:', response.status);
        console.error('ENPHASE: Response headers:', Object.fromEntries(response.headers.entries()));
        console.error('ENPHASE: Response body:', errorText);
        
        // Try to parse error as JSON if possible
        let errorDetail = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail = errorJson.error_description || errorJson.error || errorText;
          console.error('ENPHASE: Error detail:', errorJson);
        } catch {
          // Not JSON, use as is
        }
        
        throw new Error(`Token exchange failed: ${response.status} - ${errorDetail}`);
      }

      const tokens = await response.json();
      console.log('ENPHASE: Successfully obtained tokens, expires in:', tokens.expires_in);
      return tokens;
    } catch (error) {
      console.error('ENPHASE: Error exchanging code for tokens:', error);
      throw error;
    }
  }

  async refreshTokens(refreshToken: string): Promise<EnphaseTokens> {
    console.log('ENPHASE: Refreshing access token');
    
    // Use Basic Authentication for client credentials
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });

    try {
      const response = await fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        },
        body: params
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('ENPHASE: Token refresh failed');
        console.error('ENPHASE: Response status:', response.status);
        console.error('ENPHASE: Response body:', errorText);
        
        // Try to parse error as JSON if possible
        let errorDetail = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail = errorJson.error_description || errorJson.error || errorText;
        } catch {
          // Not JSON, use as is
        }
        
        throw new Error(`Token refresh failed: ${response.status} - ${errorDetail}`);
      }

      const tokens = await response.json();
      console.log('ENPHASE: Successfully refreshed tokens');
      return tokens;
    } catch (error) {
      console.error('ENPHASE: Error refreshing tokens:', error);
      throw error;
    }
  }

  async getSystems(accessToken: string): Promise<EnphaseSystem[]> {
    console.log('ENPHASE: Fetching user systems');
    
    try {
      const response = await fetch(`${this.baseUrl}/api/v4/systems`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'key': this.apiKey
        }
      });

      if (!response.ok) {
        console.error('ENPHASE: Failed to fetch systems:', response.status);
        throw new Error(`Failed to fetch systems: ${response.status}`);
      }

      const data = await response.json();
      console.log('ENPHASE: Found', data.systems?.length || 0, 'systems');
      return data.systems || [];
    } catch (error) {
      console.error('ENPHASE: Error fetching systems:', error);
      throw error;
    }
  }

  async getLatestTelemetry(systemId: string, accessToken: string): Promise<EnphaseTelemetryResponse> {
    console.log('ENPHASE: Fetching data from multiple endpoints for system:', systemId);
    
    // Try all three endpoints and log their responses
    const endpoints = [
      { name: 'summary', url: `${this.baseUrl}/api/v4/systems/${systemId}/summary` },
      { name: 'telemetry/production', url: `${this.baseUrl}/api/v4/systems/${systemId}/telemetry/production?size=1` },
      { name: 'latest_telemetry', url: `${this.baseUrl}/api/v4/systems/${systemId}/latest_telemetry` }
    ];
    
    for (const endpoint of endpoints) {
      try {
        console.log(`ENPHASE: Trying ${endpoint.name} endpoint...`);
        const response = await fetch(endpoint.url, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'key': this.apiKey
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          console.log(`ENPHASE: ${endpoint.name} response:`, JSON.stringify(data, null, 2));
        } else {
          console.log(`ENPHASE: ${endpoint.name} failed with status ${response.status}`);
        }
      } catch (error) {
        console.log(`ENPHASE: ${endpoint.name} error:`, error);
      }
    }
    
    // For now, continue using summary endpoint for actual data
    try {
      const response = await fetch(
        `${this.baseUrl}/api/v4/systems/${systemId}/summary`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'key': this.apiKey
          }
        }
      );
      
      if (response.status === 401) {
        console.warn('ENPHASE: Access token expired for system:', systemId);
        throw new Error('TOKEN_EXPIRED');
      }

      if (!response.ok) {
        console.error('ENPHASE: Telemetry fetch failed:', response.status);
        throw new Error(`Telemetry fetch failed: ${response.status}`);
      }
      
      const data = await response.json();
      console.log('ENPHASE: Raw summary response:', JSON.stringify(data, null, 2));
      
      // The summary endpoint returns different data structure
      // Convert it to match our expected telemetry response format
      const telemetryResponse: EnphaseTelemetryResponse = {
        system_id: systemId,
        // Use nullish coalescing (??) instead of || to preserve 0 values
        production_power: data.current_power ?? null,
        consumption_power: null, // Summary endpoint doesn't provide consumption
        storage_power: null,
        storage_soc: null,
        grid_power: null,
        // Add any other summary data we might want
        energy_today: data.energy_today ?? null,
        energy_lifetime: data.energy_lifetime ?? null,
        system_size: data.size_w ?? null,
        // Include the timestamp if available
        last_report_at: data.last_report_at ?? null
      };
      
      console.log('ENPHASE: Summary received for system:', systemId, 
        'Current Power:', telemetryResponse.production_power, 'W',
        'Energy Today:', telemetryResponse.energy_today, 'Wh');
      
      return telemetryResponse;
    } catch (error) {
      console.error('ENPHASE: Error fetching telemetry:', error);
      throw error;
    }
  }

  async storeTokens(userId: string, tokens: EnphaseTokens, systemId: string): Promise<void> {
    console.log('ENPHASE: Storing tokens for user:', userId, 'system:', systemId);
    
    try {
      const result = await storeEnphaseTokens(userId, tokens, systemId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to store tokens');
      }
      console.log('ENPHASE: Tokens stored successfully');
    } catch (error) {
      console.error('ENPHASE: Error storing tokens:', error);
      throw error;
    }
  }

  async getStoredTokens(userId: string): Promise<EnphaseCredentials | null> {
    console.log('ENPHASE: Retrieving stored tokens for user:', userId);
    
    try {
      const credentials = await getEnphaseCredentials(userId);
      
      if (!credentials) {
        console.log('ENPHASE: No stored tokens found for user:', userId);
        return null;
      }

      console.log('ENPHASE: Found stored tokens for system:', credentials.enphase_system_id);
      return credentials;
    } catch (error) {
      console.error('ENPHASE: Error retrieving tokens:', error);
      return null;
    }
  }

  async clearTokens(userId: string): Promise<void> {
    console.log('ENPHASE: Clearing tokens for user:', userId);
    
    try {
      const result = await removeVendorCredentials(userId, 'enphase');
      if (!result.success) {
        throw new Error(result.error || 'Failed to clear tokens');
      }
      console.log('ENPHASE: Tokens cleared successfully');
    } catch (error) {
      console.error('ENPHASE: Error clearing tokens:', error);
      throw error;
    }
  }
}

// Mock Enphase Client for Testing
export class MockEnphaseClient implements IEnphaseClient {
  private mockTokens: Map<string, EnphaseCredentials> = new Map();
  private mockDelay = 100; // Simulate network delay

  constructor() {
    console.log('ENPHASE: Mock client initialized for testing');
  }

  private async delay(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.mockDelay));
  }

  getAuthorizationUrl(state: string, origin?: string): string {
    // Use the mock auth page for testing - use the provided origin or environment variable
    const baseUrl = origin || process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
      throw new Error('Unable to determine base URL for mock authorization');
    }
    const url = `${baseUrl}/mock-enphase-auth?state=${encodeURIComponent(state)}`;
    console.log('ENPHASE MOCK: Generated authorization URL:', url);
    return url;
  }

  async exchangeCodeForTokens(code: string): Promise<EnphaseTokens> {
    console.log('ENPHASE MOCK: Exchanging code for tokens:', code);
    await this.delay();
    
    if (code === 'invalid') {
      throw new Error('Invalid authorization code');
    }

    const tokens: EnphaseTokens = {
      access_token: `mock_access_${Date.now()}`,
      refresh_token: `mock_refresh_${Date.now()}`,
      expires_in: 86400, // 1 day
      token_type: 'bearer',
      scope: 'read write',
      enl_uid: 'mock_user_123',
      enl_cid: 'mock_company_456'
    };

    console.log('ENPHASE MOCK: Generated tokens');
    return tokens;
  }

  async refreshTokens(refreshToken: string): Promise<EnphaseTokens> {
    console.log('ENPHASE MOCK: Refreshing token');
    await this.delay();
    
    return {
      access_token: `mock_access_refreshed_${Date.now()}`,
      refresh_token: `mock_refresh_refreshed_${Date.now()}`,
      expires_in: 86400,
      token_type: 'bearer',
      scope: 'read write'
    };
  }

  async getSystems(accessToken: string): Promise<EnphaseSystem[]> {
    console.log('ENPHASE MOCK: Fetching systems');
    await this.delay();
    
    return [{
      system_id: 'mock_system_001',
      name: 'Mock Solar System',
      timezone: 'Australia/Melbourne',
      connection_type: 'ethernet',
      status: 'normal',
      address: {
        city: 'Melbourne',
        state: 'VIC',
        country: 'Australia',
        postal_code: '3000'
      },
      system_size: 5000 // 5kW
    }];
  }

  async getLatestTelemetry(systemId: string, accessToken: string): Promise<EnphaseTelemetryResponse> {
    console.log('ENPHASE MOCK: Generating telemetry for system:', systemId);
    await this.delay();
    
    // Generate realistic-looking data based on time of day
    const now = new Date();
    const hour = now.getHours();
    
    // Solar production curve (peaks at noon)
    let solarW = 0;
    if (hour >= 6 && hour <= 18) {
      const peakHour = 12;
      const distanceFromPeak = Math.abs(hour - peakHour);
      solarW = Math.max(0, (5000 - distanceFromPeak * 500) * (0.8 + Math.random() * 0.4));
    }

    // Consumption varies throughout the day
    const consumptionW = 500 + Math.random() * 2000;
    
    // Battery behavior
    const batteryW = solarW > consumptionW 
      ? -(solarW - consumptionW) * 0.9  // Charging (negative)
      : (consumptionW - solarW) * 0.8;   // Discharging (positive)
    
    // Grid supplements when needed
    const gridW = Math.max(0, consumptionW - solarW - Math.max(0, batteryW));

    const telemetry: EnphaseTelemetryResponse = {
      production_power: Math.round(solarW),
      consumption_power: Math.round(consumptionW),
      storage_power: Math.round(batteryW),
      grid_power: Math.round(gridW),
      storage_energy_charged: Math.round(Math.random() * 20000),
      storage_energy_discharged: Math.round(Math.random() * 15000),
      production_energy_lifetime: Math.round(Math.random() * 1000000),
      consumption_energy_lifetime: Math.round(Math.random() * 900000),
      storage_soc: 20 + Math.random() * 60, // 20-80%
      last_report_at: Math.floor(Date.now() / 1000)
    };

    console.log('ENPHASE MOCK: Generated telemetry -',
      'Solar:', telemetry.production_power, 'W',
      'Load:', telemetry.consumption_power, 'W',
      'Battery:', telemetry.storage_power, 'W',
      'SOC:', telemetry.storage_soc ? `${telemetry.storage_soc.toFixed(1)}%` : 'N/A');
    
    return telemetry;
  }

  async storeTokens(userId: string, tokens: EnphaseTokens, systemId: string): Promise<void> {
    console.log('ENPHASE MOCK: Storing tokens for user:', userId);
    
    // Store in both memory and Clerk for mock mode
    const credentials: EnphaseCredentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      enphase_system_id: systemId,
      enphase_user_id: tokens.enl_uid
    };
    
    // Store in memory for quick access
    this.mockTokens.set(userId, credentials);
    
    // Also store in Clerk so it persists
    try {
      const result = await storeEnphaseTokens(userId, tokens, systemId);
      if (!result.success) {
        console.error('ENPHASE MOCK: Failed to store tokens in Clerk:', result.error);
      } else {
        console.log('ENPHASE MOCK: Tokens stored in Clerk successfully');
      }
    } catch (error) {
      console.error('ENPHASE MOCK: Error storing tokens in Clerk:', error);
    }
  }

  async getStoredTokens(userId: string): Promise<EnphaseCredentials | null> {
    console.log('ENPHASE MOCK: Retrieving tokens for user:', userId);
    
    // First check memory
    const memoryTokens = this.mockTokens.get(userId);
    if (memoryTokens) {
      console.log('ENPHASE MOCK: Found tokens in memory');
      return memoryTokens;
    }
    
    // Then check Clerk
    try {
      const clerkTokens = await getEnphaseCredentials(userId);
      if (clerkTokens) {
        console.log('ENPHASE MOCK: Found tokens in Clerk, caching in memory');
        this.mockTokens.set(userId, clerkTokens);
        return clerkTokens;
      }
    } catch (error) {
      console.error('ENPHASE MOCK: Error retrieving tokens from Clerk:', error);
    }
    
    console.log('ENPHASE MOCK: No tokens found');
    return null;
  }

  async clearTokens(userId: string): Promise<void> {
    console.log('ENPHASE MOCK: Clearing tokens for user:', userId);
    this.mockTokens.delete(userId);
  }
}

// Factory function to get the appropriate client
export function getEnphaseClient(): IEnphaseClient {
  const useMock = process.env.ENPHASE_USE_MOCK === 'true' || 
                  process.env.NODE_ENV === 'development' && !process.env.ENPHASE_API_KEY;
  
  if (useMock) {
    console.log('ENPHASE: Using mock client for testing');
    return new MockEnphaseClient();
  }
  
  return new EnphaseClient();
}