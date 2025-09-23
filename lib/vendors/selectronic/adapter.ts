import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import { SelectronicFetchClient } from '@/lib/selectronic/selectronic-client';
import { getSelectLiveCredentials } from '@/lib/selectronic/credentials';

/**
 * Vendor adapter for Selectronic/Select.Live systems
 */
export class SelectronicAdapter extends BaseVendorAdapter {
  readonly vendorType = 'selectronic';
  readonly displayName = 'Selectronic';
  readonly dataSource = 'poll' as const;
  
  // Cache for auth cookies
  private static authCache = new Map<string, { cookie: string; expires: number }>();
  
  async poll(system: SystemForVendor, credentials: any): Promise<PollingResult> {
    // Selectronic polls every minute with no restrictions
    try {
      const client = new SelectronicFetchClient({
        email: credentials.email,
        password: credentials.password,
        systemNumber: system.vendorSiteId
      });
      
      // Try to use cached auth if available
      const cacheKey = `${credentials.email}:${system.vendorSiteId}`;
      const cached = SelectronicAdapter.authCache.get(cacheKey);
      
      // If no valid cache, authenticate
      if (!cached || cached.expires < Date.now() + 300000) {
        console.log(`[Selectronic] Authenticating for system ${system.vendorSiteId}...`);
        const authResult = await client.authenticate();
        
        if (!authResult) {
          return this.error('Authentication failed');
        }
        
        // Cache for 25 minutes (auth lasts 30 minutes)
        SelectronicAdapter.authCache.set(cacheKey, {
          cookie: 'authenticated',
          expires: Date.now() + 25 * 60 * 1000
        });
      }
      
      const response = await client.fetchData();
      if (!response.success || !response.data) {
        return this.error(response.error || 'Failed to fetch data');
      }
      
      const transformed = this.transformData(response.data);
      
      console.log(`[Selectronic] Poll successful -`,
        'Solar:', transformed.solarW, 'W',
        'Load:', transformed.loadW, 'W',
        'Battery:', transformed.batteryW, 'W',
        'SOC:', transformed.batterySOC != null ? transformed.batterySOC.toFixed(1) + '%' : 'N/A');
      
      return this.polled(
        transformed,
        1,
        new Date(Date.now() + 60 * 1000), // Poll again in 1 minute
        response.rawJson  // Include raw JSON string for storage
      );
    } catch (error) {
      console.error(`[Selectronic] Error polling system ${system.id}:`, error);
      return this.error(error instanceof Error ? error : 'Unknown error');
    }
  }
  
  async getMostRecentReadings(system: SystemForVendor, credentials: any): Promise<CommonPollingData | null> {
    try {
      const client = new SelectronicFetchClient({
        email: credentials.email,
        password: credentials.password,
        systemNumber: system.vendorSiteId
      });
      
      const authSuccess = await client.authenticate();
      if (!authSuccess) return null;
      
      const response = await client.fetchData();
      if (!response.success || !response.data) return null;
      
      return this.transformData(response.data);
    } catch (error) {
      console.error(`[Selectronic] Error getting recent readings: ${error}`);
      return null;
    }
  }
  
  async testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult> {
    try {
      const client = new SelectronicFetchClient({
        email: credentials.email,
        password: credentials.password,
        systemNumber: system.vendorSiteId
      });
      
      // Authenticate
      const authSuccess = await client.authenticate();
      if (!authSuccess) {
        return {
          success: false,
          error: 'Failed to authenticate with Select.Live'
        };
      }
      
      // Fetch current data
      const result = await client.fetchData();
      if (!result.success || !result.data) {
        return {
          success: false,
          error: result.error || 'Failed to fetch data from Select.Live'
        };
      }
      
      // Also fetch system info
      const systemInfo = await client.fetchSystemInfo();
      console.log('[Selectronic] System info received:', JSON.stringify(systemInfo, null, 2));
      
      const latestData = this.transformData(result.data);
      
      return {
        success: true,
        systemInfo: systemInfo || undefined,
        latestData,
        vendorResponse: result.data.raw // Include raw vendor response
      };
    } catch (error) {
      console.error('Error testing Selectronic connection:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
  
  /**
   * Transform Selectronic vendor data to common format
   */
  private transformData(vendorData: any): CommonPollingData {
    return {
      timestamp: vendorData.timestamp.toString(),
      solarW: vendorData.solarW,
      solarLocalW: vendorData.shuntW,           // Map old field name
      solarRemoteW: vendorData.solarInverterW,  // Map old field name
      loadW: vendorData.loadW,
      batteryW: vendorData.batteryW,
      gridW: vendorData.gridW,
      batterySOC: vendorData.batterySOC,
      faultCode: vendorData.faultCode != null ? String(vendorData.faultCode) : null,
      faultTimestamp: vendorData.faultTimestamp || null,  // Convert 0 to null when no fault
      generatorStatus: vendorData.generatorStatus || null,  // Convert 0 to null when no generator
      // Lifetime totals
      solarKwhTotal: vendorData.solarKwhTotal,
      loadKwhTotal: vendorData.loadKwhTotal,
      batteryInKwhTotal: vendorData.batteryInKwhTotal,
      batteryOutKwhTotal: vendorData.batteryOutKwhTotal,
      gridInKwhTotal: vendorData.gridInKwhTotal,
      gridOutKwhTotal: vendorData.gridOutKwhTotal
    };
  }
}