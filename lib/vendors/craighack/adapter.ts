import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import type { LatestReadingData } from '@/lib/types/readings';
import { VendorRegistry } from '@/lib/vendors/registry';

/**
 * Vendor adapter for CraigHack systems
 * CraigHack systems don't poll - they combine data from other systems
 */
export class CraigHackAdapter extends BaseVendorAdapter {
  readonly vendorType = 'craighack';
  readonly displayName = 'CraigHack';
  readonly dataSource = 'push' as const;  // CraigHack doesn't poll, it aggregates from other systems

  /**
   * Override getLastReading to combine data from systems 2 and 3
   * Solar data from systemId=3 (Enphase), battery/load/grid from systemId=2 (Selectronic)
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    try {
      // Get adapters for systems 2 and 3 using the registry
      const solarAdapter = await VendorRegistry.getAdapterForSystem(3);
      const batteryAdapter = await VendorRegistry.getAdapterForSystem(2);

      if (!solarAdapter || !batteryAdapter) {
        console.error('[Craighack] Could not get adapters for systems 2 and 3');
        return null;
      }

      // Fetch data using adapter methods
      const solarData = await solarAdapter.getLastReading(3);  // System 3 (Enphase)
      const batteryData = await batteryAdapter.getLastReading(2);  // System 2 (Selectronic)

      if (!solarData) {
        console.error('[Craighack] No solar data available from system 3');
        return null;
      }

      if (!batteryData) {
        console.error('[Craighack] No battery/load/grid data available from system 2');
        return null;
      }

      // Combine the data - solar from system 3, everything else from system 2
      const combinedData: LatestReadingData = {
        timestamp: batteryData.timestamp,
        receivedTime: batteryData.receivedTime,

        solar: {
          powerW: solarData.solar.powerW,
          localW: solarData.solar.localW, // From system 3 (Enphase)
          remoteW: solarData.solar.remoteW, // From system 3 (Enphase) - null
        },

        battery: {
          powerW: batteryData.battery.powerW,
          soc: batteryData.battery.soc,
        },

        load: {
          powerW: batteryData.load.powerW,
        },

        grid: {
          powerW: batteryData.grid.powerW,
          generatorStatus: batteryData.grid.generatorStatus || null,  // Convert 0 to null when no generator
        },

        connection: {
          faultCode: batteryData.connection.faultCode,
          faultTimestamp: batteryData.connection.faultTimestamp || null,  // Convert 0 to null when no fault
        },
      };

      console.log('[Craighack] Combined data -',
        'Solar:', combinedData.solar.powerW, 'W (from system 3)',
        'Load:', combinedData.load.powerW, 'W (from system 2)',
        'Battery:', combinedData.battery.powerW, 'W (from system 2)',
        'SOC:', combinedData.battery.soc?.toFixed(1) ?? 'N/A', '%');

      return combinedData;
    } catch (error) {
      console.error('[Craighack] Error fetching combined data:', error);
      return null;
    }
  }

  // CraigHack doesn't support test connection - it's a combined system that aggregates data
}