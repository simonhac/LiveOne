import type { EnphaseCredentials } from '@/lib/types/enphase';
import type {
  EnphaseTokens,
  EnphaseTelemetryResponse,
  EnphaseSystem
} from './types';

/**
 * ENPHASE API IMPLEMENTATION NOTES
 * 
 * This client handles OAuth authentication and data fetching from the Enphase API.
 * 
 * KEY LEARNINGS ABOUT THE ENPHASE API:
 * 
 * 1. AUTHENTICATION:
 *    - Uses OAuth 2.0 flow with authorization code grant
 *    - Requires API key in addition to OAuth tokens for API calls
 *    - Tokens expire after 24 hours and must be refreshed
 *    - Basic auth (client_id:client_secret) for token exchange
 * 
 * 2. DATA FETCHING - PRODUCTION MICRO ENDPOINT:
 *    We primarily use /api/v4/systems/{id}/telemetry/production_micro
 *    
 *    IMPORTANT BEHAVIORS:
 *    - WITHOUT parameters: Returns today's partial data (from 00:05 until ~25 mins ago)
 *    - WITH start_at parameter: Returns full day data (288 intervals)
 *    - Granularity parameter quirk: granularity='day' actually returns 5-minute data
 *    
 * 3. DATA STRUCTURE:
 *    - Each interval represents a 5-minute period
 *    - `end_at` timestamp marks the END of the interval
 *    - Complete day has 288 intervals (00:05 to 00:00 next day)
 *    - Intervals are in watts_hours (Wh) not watts (W)
 *    
 * 4. TIMEZONE HANDLING:
 *    - All timestamps are in Unix time (UTC)
 *    - System timezone is stored separately and used for day boundaries
 *    - For fetching a specific day: start_at = day 00:05, end_at = next day 00:00
 *    
 * 5. RATE LIMITING:
 *    - API has monthly limits (typically 1000 calls/month)
 *    - We poll every 30 minutes during daylight hours
 *    - Check for yesterday's completeness during 01:00-05:00 local time
 *    
 * 6. CURRENT IMPLEMENTATION:
 *    - Uses summary endpoint for real-time monitoring (legacy)
 *    - Uses production_micro for historical data collection
 *    - Stores 5-minute interval data in readings_agg_5m table
 *    - No direct storage in readings table (unlike Selectronic)
 * 
 * See docs/ENPHASE_API.md for detailed API behavior documentation
 */

// Base client interface
export interface IEnphaseClient {
  getAuthorizationUrl(state: string, origin?: string): string;
  exchangeCodeForTokens(code: string): Promise<EnphaseTokens>;
  refreshTokens(refreshToken: string): Promise<EnphaseTokens>;
  getLatestTelemetry(systemId: string, accessToken: string): Promise<EnphaseTelemetryResponse>;
  getSystems(accessToken: string): Promise<EnphaseSystem[]>;
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

    // Client initialized
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
    // Generated authorization URL
    return url;
  }

  async exchangeCodeForTokens(code: string): Promise<EnphaseTokens> {
    // Exchanging authorization code for tokens
    
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
      // Successfully obtained tokens
      return tokens;
    } catch (error) {
      console.error('ENPHASE: Error exchanging code for tokens:', error);
      throw error;
    }
  }

  async refreshTokens(refreshToken: string): Promise<EnphaseTokens> {
    // Refreshing access token
    
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
      // Successfully refreshed tokens
      return tokens;
    } catch (error) {
      console.error('ENPHASE: Error refreshing tokens:', error);
      throw error;
    }
  }

  async getSystems(accessToken: string): Promise<EnphaseSystem[]> {
    // Fetching user systems
    
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
      // Found systems
      return data.systems || [];
    } catch (error) {
      console.error('ENPHASE: Error fetching systems:', error);
      throw error;
    }
  }

  async getLatestTelemetry(systemId: string, accessToken: string): Promise<EnphaseTelemetryResponse> {
    // Fetch system summary for current telemetry data
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
      
      const responseText = await response.text();
      const data = JSON.parse(responseText);
      // Got summary response
      
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
        last_report_at: data.last_report_at ?? null,
        // Include raw vendor response for consistency with SelectronicData
        raw: data,
        // Include raw response object for storage
        rawResponse: data
      };
      
      // Summary received
      
      return telemetryResponse;
    } catch (error) {
      console.error('ENPHASE: Error fetching telemetry:', error);
      throw error;
    }
  }

  // Methods removed - use storeEnphaseTokens and getSystemCredentials directly
}

// Factory function to get the Enphase client
export function getEnphaseClient(): IEnphaseClient {
  return new EnphaseClient();
}