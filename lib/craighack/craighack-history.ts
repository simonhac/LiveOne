import { ZonedDateTime, CalendarDate } from '@internationalized/date';
import { fetch5MinuteData, fetch30MinuteData, fetch1DayData } from '@/lib/history-data-fetcher';

/**
 * Fetch and combine history data for craighack systems
 * Solar data from systemId=3 (Enphase), battery/load/grid from systemId=2 (Selectronic)
 */
export async function fetchCraighackHistory(
  systemId: number,
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: string,
  systemTimezoneOffsetMin: number
): Promise<any[]> {
  try {
    // Fetch data from both systems
    let solarData: any[] = [];
    let batteryData: any[] = [];
    
    console.log(`[Craighack] Fetching history for interval: ${interval}`);
    
    if (interval === '1d') {
      // CalendarDate for daily data
      const start = startTime as CalendarDate;
      const end = endTime as CalendarDate;
      
      solarData = await fetch1DayData(3, start, end) || []; // System 3 (Enphase)
      batteryData = await fetch1DayData(2, start, end) || []; // System 2 (Selectronic)
    } else if (interval === '30m') {
      // ZonedDateTime for 30-minute data
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;
      
      solarData = await fetch30MinuteData(3, start, end, systemTimezoneOffsetMin) || [];
      batteryData = await fetch30MinuteData(2, start, end, systemTimezoneOffsetMin) || [];
    } else {
      // ZonedDateTime for 5-minute data
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;
      
      solarData = await fetch5MinuteData(3, start, end, systemTimezoneOffsetMin) || [];
      batteryData = await fetch5MinuteData(2, start, end, systemTimezoneOffsetMin) || [];
    }
    
    console.log(`[Craighack] Solar data: ${solarData.length} records, Battery data: ${batteryData.length} records`);
    
    // Create a map of battery data by timestamp for efficient lookup
    const batteryDataMap = new Map();
    batteryData.forEach(record => {
      if (!record) return;
      const key = interval === '1d' ? record.day : record.intervalEnd;
      if (key != null) {
        batteryDataMap.set(key, record);
      }
    });
    
    // Create a map of solar data by timestamp
    const solarDataMap = new Map();
    solarData.forEach(record => {
      if (!record) return;
      const key = interval === '1d' ? record.day : record.intervalEnd;
      if (key != null) {
        solarDataMap.set(key, record);
      }
    });
    
    // Get all unique timestamps from both datasets
    const allTimestamps = new Set([
      ...batteryDataMap.keys(),
      ...solarDataMap.keys()
    ]);
    
    // Combine data from both systems
    const combinedData: any[] = [];
    
    for (const timestamp of allTimestamps) {
      if (timestamp == null) continue;
      
      const battery = batteryDataMap.get(timestamp);
      const solar = solarDataMap.get(timestamp);
      
      if (!battery && !solar) continue;
      
      // Create combined record
      const combined: any = {};
      
      if (interval === '1d') {
        // Daily data structure
        combined.day = timestamp;
        combined.systemId = systemId;
        
        // Solar values from system 3, or battery's solar if system 3 not available
        combined.solarWMin = solar?.solarWMin ?? battery?.solarWMin ?? null;
        combined.solarWAvg = solar?.solarWAvg ?? battery?.solarWAvg ?? null;
        combined.solarWMax = solar?.solarWMax ?? battery?.solarWMax ?? null;
        combined.solarKwh = solar?.solarKwh ?? battery?.solarKwh ?? null;
        
        // All other values from system 2 (battery)
        combined.loadWMin = battery?.loadWMin ?? null;
        combined.loadWAvg = battery?.loadWAvg ?? null;
        combined.loadWMax = battery?.loadWMax ?? null;
        combined.loadKwh = battery?.loadKwh ?? null;
        
        combined.batteryWMin = battery?.batteryWMin ?? null;
        combined.batteryWAvg = battery?.batteryWAvg ?? null;
        combined.batteryWMax = battery?.batteryWMax ?? null;
        combined.batteryChargeKwh = battery?.batteryChargeKwh ?? null;
        combined.batteryDischargeKwh = battery?.batteryDischargeKwh ?? null;
        
        combined.gridWMin = battery?.gridWMin ?? null;
        combined.gridWAvg = battery?.gridWAvg ?? null;
        combined.gridWMax = battery?.gridWMax ?? null;
        combined.gridImportKwh = battery?.gridImportKwh ?? null;
        combined.gridExportKwh = battery?.gridExportKwh ?? null;
        
        combined.batterySocMin = battery?.batterySocMin ?? null;
        combined.batterySocAvg = battery?.batterySocAvg ?? null;
        combined.batterySocMax = battery?.batterySocMax ?? null;
        combined.batterySocEnd = battery?.batterySocEnd ?? null;
        
        combined.intervalCount = battery?.intervalCount ?? solar?.intervalCount ?? null;
      } else {
        // 5-minute or 30-minute data structure  
        // The fetch functions return nested structure, we need to flatten it
        combined.intervalEnd = timestamp;
        combined.systemId = systemId;
        
        // Solar values from system 3, or battery's solar if system 3 not available
        combined.solarWAvg = solar?.power?.solar?.avgW ?? battery?.power?.solar?.avgW ?? null;
        combined.solarIntervalWh = solar?.solarIntervalWh ?? battery?.solarIntervalWh ?? null;
        
        // All other values from system 2 (battery)
        combined.loadWAvg = battery?.power?.load?.avgW ?? null;
        combined.loadIntervalWh = battery?.loadIntervalWh ?? null;
        
        combined.batteryWAvg = battery?.power?.battery?.avgW ?? null;
        combined.batteryChargeIntervalWh = battery?.batteryChargeIntervalWh ?? null;
        combined.batteryDischargeIntervalWh = battery?.batteryDischargeIntervalWh ?? null;
        
        combined.gridWAvg = battery?.power?.grid?.avgW ?? null;
        combined.gridImportIntervalWh = battery?.gridImportIntervalWh ?? null;
        combined.gridExportIntervalWh = battery?.gridExportIntervalWh ?? null;
        
        combined.batterySOCLast = battery?.batterySOCLast ?? null;
        combined.dataQuality = battery?.dataQuality ?? solar?.dataQuality ?? null;
      }
      
      combinedData.push(combined);
    }
    
    // Sort by timestamp
    combinedData.sort((a, b) => {
      const aKey = interval === '1d' ? a.day : a.intervalEnd;
      const bKey = interval === '1d' ? b.day : b.intervalEnd;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
    
    console.log(`[Craighack] Combined ${combinedData.length} history records from systems 2 and 3`);
    
    return combinedData;
  } catch (error) {
    console.error('[Craighack] Error fetching history:', error);
    // Return empty array on error to prevent crash
    return [];
  }
}