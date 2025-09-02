import { getEnphaseClient } from './enphase-client';
import type { PollingData } from '@/lib/types/enphase';

interface EnphaseSystemForPolling {
  id: number;
  ownerClerkUserId: string;
  vendorSiteId: string;
  timezoneOffsetMin: number;
}

/**
 * Check if we should poll an Enphase system
 * Only poll during daylight hours at 30-minute intervals
 */
export function shouldPollEnphase(system: EnphaseSystemForPolling): boolean {
  const now = new Date();
  const minutes = now.getMinutes();
  
  // In mock mode, always allow polling for testing
  if (process.env.ENPHASE_USE_MOCK === 'true') {
    console.log('ENPHASE: Mock mode enabled, allowing poll regardless of time');
    return true;
  }
  
  // Only poll on :00 and :30
  if (minutes !== 0 && minutes !== 30) {
    console.log('ENPHASE: Not on 30-minute boundary, skipping poll');
    return false;
  }
  
  // Calculate local time for the system
  const localOffset = system.timezoneOffsetMin * 60 * 1000;
  const utcTime = now.getTime();
  const localTime = new Date(utcTime + localOffset);
  const localHour = localTime.getHours();
  
  // Poll between 5 AM and 8 PM local time (rough daylight hours)
  // This can be refined with actual sunrise/sunset calculations
  if (localHour < 5 || localHour >= 20) {
    console.log(`ENPHASE: Outside daylight hours (local hour: ${localHour}), skipping poll`);
    return false;
  }
  
  console.log(`ENPHASE: Polling approved - local time ${localHour}:${String(minutes).padStart(2, '0')}`);
  return true;
}

/**
 * Poll an Enphase system for current data
 */
export async function pollEnphaseSystem(system: EnphaseSystemForPolling): Promise<PollingData> {
  console.log('ENPHASE: Starting poll for system:', system.vendorSiteId);
  
  const client = getEnphaseClient();
  const credentials = await client.getStoredTokens(system.ownerClerkUserId);
  
  if (!credentials) {
    console.error('ENPHASE: No stored tokens for user:', system.ownerClerkUserId);
    throw new Error('No Enphase credentials found');
  }
  
  // Check if token needs refresh (expires in less than 1 hour)
  let accessToken = credentials.access_token;
  if (credentials.expires_at < Date.now() + 3600000) {
    console.log('ENPHASE: Token expiring soon, refreshing...');
    try {
      const newTokens = await client.refreshTokens(credentials.refresh_token);
      await client.storeTokens(
        system.ownerClerkUserId, 
        newTokens, 
        credentials.enphase_system_id
      );
      accessToken = newTokens.access_token;
      console.log('ENPHASE: Token refreshed successfully');
    } catch (error) {
      console.error('ENPHASE: Token refresh failed:', error);
      throw new Error('Failed to refresh Enphase token');
    }
  }
  
  // Fetch telemetry
  console.log('ENPHASE: Fetching telemetry for system:', system.vendorSiteId);
  const telemetry = await client.getLatestTelemetry(
    system.vendorSiteId,
    accessToken
  );
  
  // For now, always use current time as the timestamp
  // This aligns better with our polling schedule and aggregation
  const timestamp = new Date();
  
  console.log('ENPHASE: Using current time for timestamp');
  
  // Transform Enphase data to our standard format
  const data: PollingData = {
    timestamp: timestamp.toISOString(),
    solarW: telemetry.production_power || 0,
    solarInverterW: telemetry.production_power || 0, // Enphase doesn't distinguish
    shuntW: 0, // Not available in Enphase
    loadW: telemetry.consumption_power || 0,
    batteryW: telemetry.storage_power || 0,
    gridW: telemetry.grid_power || 0,
    batterySOC: telemetry.storage_soc || 0,
    faultCode: 0, // Not available in Enphase telemetry
    faultTimestamp: 0,
    generatorStatus: 0,
    // Convert Wh to kWh for totals
    solarKwhTotal: (telemetry.production_energy_lifetime || 0) / 1000,
    loadKwhTotal: (telemetry.consumption_energy_lifetime || 0) / 1000,
    batteryInKwhTotal: (telemetry.storage_energy_charged || 0) / 1000,
    batteryOutKwhTotal: (telemetry.storage_energy_discharged || 0) / 1000,
    gridInKwhTotal: 0, // Would need different endpoint
    gridOutKwhTotal: 0  // Would need different endpoint
  };
  
  console.log('ENPHASE: Poll successful -',
    'Solar:', data.solarW, 'W',
    'Load:', data.loadW, 'W',
    'Battery:', data.batteryW, 'W',
    'SOC:', data.batterySOC ? `${data.batterySOC.toFixed(1)}%` : 'N/A');
  
  return data;
}

/**
 * Track API usage for rate limiting
 */
export async function trackEnphaseApiUsage(systemId: number): Promise<void> {
  // TODO: Implement API usage tracking
  // This would update a counter in the database to ensure we don't exceed
  // the 1000 requests/month limit on the Watt plan
  console.log('ENPHASE: API call tracked for system:', systemId);
}