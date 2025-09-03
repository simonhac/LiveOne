import { SelectronicFetchClient } from './selectronic-client';
import { getSelectLiveCredentials } from './credentials';
import type { CommonPollingData } from '@/lib/types/common';

interface SelectronicSystemForPolling {
  id: number;
  ownerClerkUserId: string;
  vendorSiteId: string;
}

// Cache for auth cookies
const authCache = new Map<string, { cookie: string; expires: number }>();

/**
 * Get or refresh authentication for Selectronic system
 */
async function getOrRefreshAuth(
  systemNumber: string, 
  client: SelectronicFetchClient
): Promise<string | null> {
  const cacheKey = systemNumber;
  const cached = authCache.get(cacheKey);
  
  // Use cached auth if still valid (with 5 minute buffer)
  if (cached && cached.expires > Date.now() + 300000) {
    console.log(`[Selectronic] Using cached auth for system ${systemNumber}`);
    return cached.cookie;
  }
  
  console.log(`[Selectronic] Authenticating for system ${systemNumber}...`);
  const authResult = await client.authenticate();
  
  if (authResult) {
    // Cache for 25 minutes (auth lasts 30 minutes)
    const authCookie = 'authenticated'; // We don't have access to the actual cookie
    authCache.set(cacheKey, {
      cookie: authCookie,
      expires: Date.now() + 25 * 60 * 1000
    });
    return authCookie;
  }
  
  return null;
}

/**
 * Poll a Selectronic system for current data
 */
export async function pollSelectronicSystem(system: SelectronicSystemForPolling): Promise<CommonPollingData> {
  console.log(`[Selectronic] Polling system ${system.vendorSiteId}...`);
  
  // Get the owner's Select.Live credentials from Clerk
  const credentials = await getSelectLiveCredentials(system.ownerClerkUserId);
  
  if (!credentials) {
    console.error(`[Selectronic] No credentials found for system ${system.vendorSiteId}`);
    throw new Error('No Select.Live credentials found');
  }
  
  console.log(`[Selectronic] Using credentials for system ${system.vendorSiteId}`);
  
  // Create client for this system
  const client = new SelectronicFetchClient({
    email: credentials.email,
    password: credentials.password,
    systemNumber: system.vendorSiteId
  });
  
  // Authenticate if needed
  const authCookie = await getOrRefreshAuth(system.vendorSiteId, client);
  if (!authCookie) {
    throw new Error('Authentication failed');
  }
  
  // Fetch data
  const response = await client.fetchData();
  
  if (!response || !response.success || !response.data) {
    throw new Error('Failed to fetch Selectronic data');
  }
  
  const data = response.data;
  
  // Transform to standard format
  const pollingData: CommonPollingData = {
    timestamp: data.timestamp.toString(),
    solarW: data.solarW,
    solarInverterW: data.solarInverterW,
    shuntW: data.shuntW,
    loadW: data.loadW,
    batteryW: data.batteryW,
    gridW: data.gridW,
    batterySOC: data.batterySOC,
    faultCode: data.faultCode,
    faultTimestamp: data.faultTimestamp,
    generatorStatus: data.generatorStatus,
    solarKwhTotal: data.solarKwhTotal,
    loadKwhTotal: data.loadKwhTotal,
    batteryInKwhTotal: data.batteryInKwhTotal,
    batteryOutKwhTotal: data.batteryOutKwhTotal,
    gridInKwhTotal: data.gridInKwhTotal,
    gridOutKwhTotal: data.gridOutKwhTotal
  };
  
  console.log(`[Selectronic] Poll successful -`,
    'Solar:', pollingData.solarW, 'W',
    'Load:', pollingData.loadW, 'W',
    'Battery:', pollingData.batteryW, 'W',
    'SOC:', pollingData.batterySOC.toFixed(1), '%');
  
  return pollingData;
}