import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult, CredentialField } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import { SelectronicFetchClient, type SelectronicData } from './selectronic-client';
import { fromDate } from '@internationalized/date';

/**
 * Vendor adapter for Selectronic/Select.Live systems
 */
export class SelectronicAdapter extends BaseVendorAdapter {
  readonly vendorType = 'selectronic';
  readonly displayName = 'Selectronic';
  readonly dataSource = 'poll' as const;
  readonly supportsAddSystem = true;

  readonly credentialFields: CredentialField[] = [
    {
      name: 'email',
      label: 'Email',
      type: 'email',
      placeholder: 'your@email.com',
      required: true,
      helpText: 'Your Select.Live account email'
    },
    {
      name: 'password',
      label: 'Password',
      type: 'password',
      placeholder: 'Enter your password',
      required: true,
      helpText: 'Your Select.Live account password'
    }
  ];
  
  // Cache for auth cookies
  private static authCache = new Map<string, { cookie: string; expires: number }>();
  
  async poll(system: SystemForVendor, credentials: any, force?: boolean): Promise<PollingResult> {
    // Selectronic polls every minute with no restrictions
    // The force flag is available but not needed for Selectronic as it has no rate limiting
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
      
      // Calculate next poll time at the beginning of the next minute
      const now = new Date();
      const nextMinute = new Date(now);
      nextMinute.setSeconds(0, 0); // Reset seconds and milliseconds to 0
      nextMinute.setMinutes(nextMinute.getMinutes() + 1); // Add 1 minute

      const nextPollTime = fromDate(nextMinute, 'Australia/Brisbane');

      return this.polled(
        transformed,
        1,
        nextPollTime,
        response.rawResponse  // Pass the raw response object
      );
    } catch (error) {
      console.error(`[Selectronic] Error polling system ${system.id}:`, error);
      return this.error(error instanceof Error ? error : 'Unknown error');
    }
  }
  async testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult> {
    try {
      // If no vendorSiteId provided, we need to discover available systems
      if (!system.vendorSiteId) {
        const discoveryClient = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: '' // Empty to discover systems
        });

        // Authenticate first
        const authSuccess = await discoveryClient.authenticate();
        if (!authSuccess) {
          return {
            success: false,
            error: 'Failed to authenticate with Select.Live'
          };
        }

        // Get available systems
        const availableSystems = await discoveryClient.getSystemsList();

        if (!availableSystems || availableSystems.length === 0) {
          return {
            success: false,
            error: 'No systems found for this Select.Live account'
          };
        }

        // Use the first system (in future we could let user choose)
        const firstSystem = availableSystems[0];
        const vendorSiteId = firstSystem.serialNumber || firstSystem.systemNumber;

        // Now test with the discovered system
        const client = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: vendorSiteId
        });

        const result = await client.fetchData();
        if (!result.success || !result.data) {
          return {
            success: false,
            error: result.error || 'Failed to fetch data from Select.Live'
          };
        }

        const systemInfo = await client.fetchSystemInfo();
        const latestData = this.transformData(result.data);

        return {
          success: true,
          systemInfo: {
            vendorSiteId,
            displayName: firstSystem.name || `Selectronic ${vendorSiteId}`,
            model: systemInfo?.model || firstSystem.model || 'SP PRO',
            serial: systemInfo?.serial || firstSystem.serialNumber,
            solarSize: systemInfo?.solarSize,
            batterySize: systemInfo?.batterySize,
            ratings: systemInfo?.ratings
          },
          latestData,
          vendorResponse: { systems: availableSystems, data: result.data.raw }
        };
      }

      // Normal flow when vendorSiteId is provided
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
  private transformData(vendorData: SelectronicData): CommonPollingData {
    return {
      timestamp: vendorData.timestamp, // Already a Date object from client
      solarW: vendorData.solarW,
      solarLocalW: vendorData.shuntW,           // Map old field name
      solarRemoteW: vendorData.solarInverterW,  // Map old field name
      loadW: vendorData.loadW,
      batteryW: vendorData.batteryW,
      gridW: vendorData.gridW,
      batterySOC: vendorData.batterySOC,
      faultCode: vendorData.faultCode != null ? String(vendorData.faultCode) : null,
      faultTimestamp: vendorData.faultTimestamp ? new Date(vendorData.faultTimestamp * 1000) : null,  // Convert Unix timestamp to Date, 0 to null
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