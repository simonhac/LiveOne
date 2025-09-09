import { ZonedDateTime, CalendarDate } from '@internationalized/date';
import type { OpenNEMDataSeries } from '@/types/opennem';

// Type for the getSystemHistoryInOpenNEMFormat function
type GetSystemHistoryFn = (
  system: any,
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: '5m' | '30m' | '1d',
  fields: string[]
) => Promise<OpenNEMDataSeries[]>;

/**
 * Get combined history data for a craighack system in OpenNEM format
 * This combines:
 * - Solar data from system 3 (Enphase)
 * - Battery, load, and grid data from system 2 (Selectronic)
 */
export async function getCraigHackSystemHistoryInOpenNEMFormat(
  craighackSystem: any,
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: '5m' | '30m' | '1d',
  fields: string[],
  getSystemHistoryInOpenNEMFormat: GetSystemHistoryFn
): Promise<OpenNEMDataSeries[]> {
  console.log(`[Craighack] Fetching combined OpenNEM history for system ${craighackSystem.vendorSiteId}`);
  
  // Hardcoded system objects for systems 2 and 3
  // These need to match the actual systems in the database
  const system2 = { 
    id: 2, 
    vendorType: 'selectronic',
    vendorSiteId: '545',
    timezoneOffsetMin: craighackSystem.timezoneOffsetMin,
    displayName: 'System 2 (Selectronic)'
  };
  
  const system3 = { 
    id: 3,
    vendorType: 'enphase',
    vendorSiteId: '364880',
    timezoneOffsetMin: craighackSystem.timezoneOffsetMin,
    displayName: 'System 3 (Enphase)'
  };
  
  // Determine which fields we need from each system
  const solarFields = fields.includes('solar') ? ['solar'] : [];
  const otherFields = fields.filter(f => f !== 'solar');
  
  // Fetch data from both systems
  const promises: Promise<OpenNEMDataSeries[]>[] = [];
  
  // Get solar data from system 3 if needed
  if (solarFields.length > 0) {
    promises.push(
      getSystemHistoryInOpenNEMFormat(
        system3,
        startTime,
        endTime,
        interval,
        solarFields
      )
    );
  }
  
  // Get other data from system 2 if needed
  if (otherFields.length > 0) {
    promises.push(
      getSystemHistoryInOpenNEMFormat(
        system2,
        startTime,
        endTime,
        interval,
        otherFields
      )
    );
  }
  
  if (promises.length === 0) {
    return [];
  }
  
  // Wait for both requests
  const results = await Promise.all(promises);
  const allSeries = results.flat();
  
  // Create the craighack system identifier
  const craighackIdentifier = `${craighackSystem.vendorType}.${craighackSystem.vendorSiteId}`;
  
  // Rename all series IDs to use the craighack system identifier
  const renamedSeries: OpenNEMDataSeries[] = allSeries.map(series => {
    // Extract the field part after the vendor.siteId
    // e.g., "liveone.enphase.364880.solar.power" -> "solar.power"
    const parts = series.id.split('.');
    const fieldPart = parts.slice(3).join('.'); // Everything after "liveone.vendor.siteId"
    
    return {
      ...series,
      id: `liveone.${craighackIdentifier}.${fieldPart}`,
      network: 'liveone', // Ensure consistent network
      source: 'craighack' // Mark as coming from craighack combination
    };
  });
  
  console.log(`[Craighack] Combined ${renamedSeries.length} data series from systems 2 and 3`);
  
  return renamedSeries;
}