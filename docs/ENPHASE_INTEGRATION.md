# Enphase Integration Documentation

## Overview

This document outlines the complete workflow for integrating Enphase solar systems into LiveOne, using the Enphase API v4 with OAuth 2.0 authorization.

## Current Application Credentials

We have an existing Enphase application registered:
- **App Name**: LiveOne
- **API Key**: `{ENPHASE_API_KEY}` (stored in environment variables)
- **Client ID**: `{ENPHASE_CLIENT_ID}` (stored in environment variables)
- **Client Secret**: `{ENPHASE_CLIENT_SECRET}` (stored in environment variables)
- **Plan**: Watt (1,000 requests/month limit - may need to upgrade)
- **Access**: System Details, Site Level Production/Consumption Monitoring, EV Charger Monitoring

## Library Decision

After evaluating available options, we will **implement our own OAuth2 client** because:
- No official Enphase JavaScript SDK exists for API v4
- The only Node.js library (enlighten-api-node) is from 2015 and uses the deprecated v2 API
- Generic OAuth2 libraries like `client-oauth2` can handle the OAuth flow
- This gives us full control over token management and API interactions

## User Registration Workflow

### Step 1: System Owner Initiates Connection

1. User clicks "Add Enphase System" in LiveOne
2. We display information about what data will be accessed
3. User enters their Enphase system ID or serial number (optional, for validation)

### Step 2: OAuth Authorization

1. **Generate Authorization URL**:
   ```
   https://api.enphaseenergy.com/oauth/authorize
   ?response_type=code
   &client_id={ENPHASE_CLIENT_ID}
   &redirect_uri={our_callback_url}
   &state={unique_session_token}
   ```

2. **Redirect User to Enphase**:
   - User is redirected to Enphase login page
   - They log in with their Enphase credentials
   - They review and approve access permissions
   - Enphase shows what data LiveOne will access

3. **Handle Authorization Callback**:
   - Enphase redirects back to our `redirect_uri`
   - URL contains authorization code: `?code=AUTH_CODE&state=SESSION_TOKEN`
   - Verify state parameter matches our session
   - If denied: `?error=access_denied&state=SESSION_TOKEN`

### Step 3: Token Exchange

1. **Exchange Authorization Code for Tokens**:
   ```bash
   POST https://api.enphaseenergy.com/oauth/token
   Content-Type: application/x-www-form-urlencoded
   
   grant_type=authorization_code
   &code={authorization_code}
   &redirect_uri={same_redirect_uri}
   &client_id={ENPHASE_CLIENT_ID}
   &client_secret={ENPHASE_CLIENT_SECRET}
   ```

2. **Response Contains**:
   ```json
   {
     "access_token": "unique_access_token",
     "token_type": "bearer",
     "refresh_token": "unique_refresh_token",
     "expires_in": 86400,  // 1 day
     "scope": "read write",
     "enl_uid": "user_id",
     "enl_cid": "company_id",
     "enl_password_last_changed": "timestamp",
     "is_internal_app": false,
     "app_type": "partner",
     "jti": "token_id"
   }
   ```

### Step 4: Fetch System Information

1. **Get User's Systems**:
   ```bash
   GET https://api.enphaseenergy.com/api/v4/systems
   Authorization: Bearer {access_token}
   key: {ENPHASE_API_KEY}
   ```

2. **Store System Details**:
   - System ID
   - System name
   - Installation date
   - System size
   - Device information (inverters, batteries, etc.)

### Step 5: Store Credentials Securely

1. **Store in Clerk Private Metadata**:
   - Store encrypted tokens in user's Clerk private metadata
   - Structure: `enphaseCredentials: { access_token, refresh_token, expires_at, enphase_system_id }`
   - No new database tables needed

2. **Update Systems Table**:
   - Set `vendor_type = 'enphase'`
   - Use existing `vendor_site_id` for Enphase system ID
   - Use existing `display_name` for system name
   - Use existing `timezone_offset_min` for timezone

3. **Token Management**:
   - Access token expires in 1 day
   - Refresh token expires in 1 week (not 1 month as initially documented)
   - Implement automatic refresh before expiration

## Token Refresh Workflow

```bash
POST https://api.enphaseenergy.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token={current_refresh_token}
&client_id={ENPHASE_CLIENT_ID}
&client_secret={ENPHASE_CLIENT_SECRET}
```

## API Data Collection

### Available Endpoints (with Watt Plan)

1. **System Summary**:
   - `/api/v4/systems/{system_id}/summary`
   - Provides overview of system performance

2. **Energy Production**:
   - `/api/v4/systems/{system_id}/energy_lifetime` - Total production
   - `/api/v4/systems/{system_id}/production_meter_readings` - Meter readings
   - `/api/v4/systems/{system_id}/telemetry/production_micro` - Microinverter telemetry

3. **Energy Consumption** (if available):
   - `/api/v4/systems/{system_id}/consumption_lifetime`
   - `/api/v4/systems/{system_id}/telemetry/consumption_meter`

4. **Battery Data** (if available):
   - `/api/v4/systems/{system_id}/battery_lifetime`
   - `/api/v4/systems/{system_id}/telemetry/battery`

5. **Latest Telemetry**:
   - `/api/v4/systems/{system_id}/latest_telemetry`
   - Returns current power values (production, consumption, battery)

### Data Collection Strategy

1. **Phase 1 - Telemetry Only**:
   - Poll `/latest_telemetry` every 5 minutes
   - Store in `readings` table
   - Map Enphase fields to our existing schema

2. **Future Phase - Historical Backfill**:
   - Use telemetry endpoints with time ranges
   - Backfill historical data on demand
   - Use granularity parameter (5min, 15min, etc.)

## Data Mapping

### Enphase to LiveOne Field Mapping

```javascript
// From /api/v4/systems/{system_id}/latest_telemetry
{
  // Enphase Response              // LiveOne Field
  "production_power": 2500,        // solar_w
  "consumption_power": 1200,        // load_w  
  "storage_power": -1300,          // battery_w (negative = charging)
  "grid_power": 0,                 // grid_w
  "storage_energy_charged": 16200, // battery_in_kwh_total
  "storage_energy_discharged": 4200, // battery_out_kwh_total
  "production_energy_lifetime": 950000, // solar_kwh_total
  "consumption_energy_lifetime": 838100, // load_kwh_total
  "storage_soc": 75                // battery_soc
}
```

## No Database Schema Changes Required

Using existing infrastructure:
- **Clerk Private Metadata**: Store OAuth tokens
- **Systems Table**: Use existing fields
  - `vendor_type = 'enphase'`
  - `vendor_site_id` = Enphase system ID
  - `display_name` = System name from Enphase
  - `timezone_offset_min` = Already available

## Environment Variables Required

```bash
# Enphase API Credentials
ENPHASE_API_KEY=your_api_key_here
ENPHASE_CLIENT_ID=your_client_id_here
ENPHASE_CLIENT_SECRET=your_client_secret_here
ENPHASE_REDIRECT_URI=https://liveone.vercel.app/api/auth/enphase/callback
```

## Implementation Plan

### Phase 1: OAuth Flow & Token Management
1. **Create Enphase Service** (`lib/enphase-client.ts`)
   - OAuth URL generation with state parameter
   - Token exchange implementation
   - Automatic token refresh logic
   - API request wrapper with auth headers

2. **API Routes**
   - `POST /api/auth/enphase/connect` - Generate OAuth URL
   - `GET /api/auth/enphase/callback` - Handle OAuth callback
   - `POST /api/auth/enphase/disconnect` - Remove tokens

3. **Clerk Integration**
   - Store tokens in private metadata
   - Encrypt/decrypt token functions
   - Token expiry checking

### Phase 2: Data Collection (Telemetry Focus)

#### Rate Limit Strategy for Watt Plan (1000 requests/month)

With only 1000 API calls per month, we need a smart polling strategy:

**Problem**: 
- 1000 calls ÷ 31 days ≈ 32 calls/day maximum
- Polling every 5 minutes would require 288 calls/day (impossible)
- Need to balance data freshness with API limits

**Solution - Daylight-Only Polling**:
1. **Poll every 30 minutes during daylight hours only**
   - Summer (~15 hours): ~30 polls/day
   - Winter (~10 hours): ~20 polls/day
   - Average: ~25 polls/day = ~775 polls/month
   - Leaves headroom for token refreshes and other API calls

2. **Implementation**:
   ```typescript
   // Calculate sunrise/sunset for system location
   const { sunrise, sunset } = calculateSunTimes(latitude, longitude);
   
   // Round to nearest 30-minute boundary
   const pollStart = roundDown30(sunrise);
   const pollEnd = roundUp30(sunset);
   
   // Only poll if current time is within daylight window
   const shouldPoll = currentTime >= pollStart && currentTime <= pollEnd 
                      && currentTime.getMinutes() % 30 === 0;
   ```

3. **Alternative for Higher Resolution**:
   - Upgrade to Kilowatt plan (10,000 requests/month)
   - Would allow 5-minute polling during daylight hours
   - Or 15-minute polling 24/7

#### Polling Implementation
1. **Modified Cron Strategy**
   - Run cron every 30 minutes (not every minute)
   - Check daylight hours for each system's location
   - Skip polling outside daylight hours
   - Track API call count in database

2. **Data Transformation**
   - Convert Enphase power values to watts
   - Convert energy values to kWh
   - Handle missing/null values
   - Interpolate data gaps from 30-minute samples

3. **Error Handling**
   - Token expired → auto-refresh (counts as API call)
   - Rate limit approached → alert and pause
   - System offline → skip and log

### Phase 3: UI Integration
1. **Settings Page**
   - Add "Connect Enphase System" button
   - Show connection status
   - Display last sync time
   - Disconnect option

2. **System Registration Flow**
   - OAuth authorization page
   - System selection/confirmation
   - Success/error feedback

### Phase 4: API Usage Tracking

To ensure we stay within limits, implement usage tracking:

```typescript
// Track API calls in polling_status table
interface EnphaseApiUsage {
  system_id: number;
  month: string; // "2024-08"
  api_calls: number;
  last_call_time: number;
}

// Before each API call
async function checkApiLimit(systemId: number): Promise<boolean> {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const usage = await getApiUsage(systemId, currentMonth);
  
  if (usage.api_calls >= 950) { // Leave buffer
    console.warn(`Approaching API limit for system ${systemId}`);
    return false;
  }
  
  return true;
}
```

### Phase 5: Future Enhancements
1. **Historical data backfill** (when upgrading plan)
2. **Upgrade to Kilowatt plan** (10,000 requests/month)
   - Enable 5-minute polling during daylight
   - Or 15-minute polling 24/7
3. **Support for multiple Enphase systems per user**
4. **Local Envoy API integration** (unlimited local polling)
5. **Implement sunrise/sunset calculation** for optimal polling windows

## Security Considerations

1. **Token Storage**:
   - Encrypt all tokens at rest
   - Use environment variables for client credentials
   - Never expose tokens in logs or error messages

2. **Authorization Flow**:
   - Always validate state parameter
   - Use HTTPS for all callbacks
   - Implement PKCE if supported

3. **Rate Limiting**:
   - Respect Enphase rate limits
   - Implement exponential backoff
   - Cache responses where appropriate

## Error Handling

1. **Authorization Errors**:
   - User denies access
   - Invalid credentials
   - Expired authorization codes

2. **API Errors**:
   - Token expired (401)
   - Rate limit exceeded (429)
   - System offline or no data

3. **Recovery Strategies**:
   - Automatic token refresh
   - Retry with backoff
   - User notification for reauthorization

## Code Example: Enphase Client Implementation

```typescript
// lib/enphase-client.ts
import { clerkClient } from '@clerk/nextjs/server';

export class EnphaseClient {
  private apiKey = process.env.ENPHASE_API_KEY!;
  private clientId = process.env.ENPHASE_CLIENT_ID!;
  private clientSecret = process.env.ENPHASE_CLIENT_SECRET!;
  private redirectUri = process.env.ENPHASE_REDIRECT_URI!;
  private baseUrl = 'https://api.enphaseenergy.com';

  // Generate OAuth authorization URL
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state
    });
    return `${this.baseUrl}/oauth/authorize?${params}`;
  }

  // Exchange authorization code for tokens
  async exchangeCodeForTokens(code: string): Promise<TokenResponse> {
    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    });
    return response.json();
  }

  // Refresh access token
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    });
    return response.json();
  }

  // Fetch latest telemetry data
  async getLatestTelemetry(systemId: string, accessToken: string): Promise<TelemetryData> {
    const response = await fetch(
      `${this.baseUrl}/api/v4/systems/${systemId}/latest_telemetry`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'key': this.apiKey
        }
      }
    );
    
    if (response.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    
    return response.json();
  }

  // Store tokens in Clerk metadata
  async storeTokens(userId: string, tokens: TokenResponse, systemId: string) {
    await clerkClient.users.updateUserMetadata(userId, {
      privateMetadata: {
        enphaseCredentials: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: Date.now() + (tokens.expires_in * 1000),
          enphase_system_id: systemId
        }
      }
    });
  }
}
```

## Testing Checklist

- [ ] OAuth flow with real Enphase account
- [ ] Token refresh before expiration
- [ ] Token refresh when expired (1 week limit)
- [ ] Data collection with telemetry endpoint
- [ ] Rate limit handling (1000 requests/month)
- [ ] Error handling for all failure modes
- [ ] Data mapping accuracy
- [ ] Clerk metadata storage/retrieval

## References

- [Enphase API Documentation](https://developer-v4.enphase.com/docs.html)
- [OAuth 2.0 Specification](https://oauth.net/2/)
- [Enphase Developer Portal](https://developer-v4.enphase.com/)