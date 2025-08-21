import { db } from '@/lib/db';
import { readingsAgg5m, readingsAgg1d } from '@/lib/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { formatDateAEST, toUnixTimestamp, fromUnixTimestamp } from '@/lib/date-utils';
import { CalendarDate, ZonedDateTime, parseDate } from '@internationalized/date';

// Fetch 5-minute aggregated data with reshaping
export async function fetch5MinuteData(systemId: number, startTime: ZonedDateTime, endTime: ZonedDateTime, timezoneOffset: number = 10) {
  // Convert ZonedDateTime to Unix timestamp for database query
  const startTimestamp = toUnixTimestamp(startTime);
  const endTimestamp = toUnixTimestamp(endTime);
  
  // The intervalEnd column is stored as Unix timestamp, so compare directly
  const data = await db.select()
    .from(readingsAgg5m)
    .where(
      and(
        eq(readingsAgg5m.systemId, systemId),
        gte(readingsAgg5m.intervalEnd, startTimestamp),
        lte(readingsAgg5m.intervalEnd, endTimestamp)
      )
    )
    .orderBy(readingsAgg5m.intervalEnd);
  
  // Reshape 5-minute data with proper time objects
  return data.map(row => ({
    // Convert Unix seconds to ZonedDateTime
    intervalEnd: fromUnixTimestamp(row.intervalEnd, timezoneOffset),
    
    // Battery SOC
    batterySOCLast: row.batterySOCLast,
    
    // Full power statistics (single source of truth)
    power: {
      solar: {
        minW: row.solarWMin,
        avgW: row.solarWAvg,
        maxW: row.solarWMax
      },
      load: {
        minW: row.loadWMin,
        avgW: row.loadWAvg,
        maxW: row.loadWMax
      },
      battery: {
        minW: row.batteryWMin,
        avgW: row.batteryWAvg,
        maxW: row.batteryWMax
      },
      grid: {
        minW: row.gridWMin,
        avgW: row.gridWAvg,
        maxW: row.gridWMax
      }
    },
    
    // Energy totals (last values)
    energy: {
      solarKwhTotal: row.solarKwhTotalLast,
      loadKwhTotal: row.loadKwhTotalLast,
      batteryInKwhTotal: row.batteryInKwhTotalLast,
      batteryOutKwhTotal: row.batteryOutKwhTotalLast,
      gridInKwhTotal: row.gridInKwhTotalLast,
      gridOutKwhTotal: row.gridOutKwhTotalLast
    },
    
    // Data quality
    dataQuality: {
      sampleCount: row.sampleCount
    }
  }));
}

// Fetch daily aggregated data with reshaping
export async function fetch1DayData(systemId: number, startDate: CalendarDate, endDate: CalendarDate) {
  // Format dates as YYYY-MM-DD strings for the database query
  const startDateStr = formatDateAEST(startDate);
  const endDateStr = formatDateAEST(endDate);
  
  const dailyData = await db.select()
    .from(readingsAgg1d)
    .where(
      and(
        eq(readingsAgg1d.systemId, systemId.toString()),
        gte(readingsAgg1d.day, startDateStr),
        lte(readingsAgg1d.day, endDateStr)
      )
    )
    .orderBy(readingsAgg1d.day);
  
  // Reshape daily data with proper date objects
  return dailyData.map(row => ({
    // Parse the day string to CalendarDate
    date: parseDate(row.day),
    
    // Battery SOC at end of day
    batterySOCLast: row.batterySocEnd,
    
    // Daily energy totals (no rounding, direct from database)
    energy: {
      solarKwh: row.solarKwh,
      loadKwh: row.loadKwh,
      batteryChargeKwh: row.batteryChargeKwh,
      batteryDischargeKwh: row.batteryDischargeKwh,
      gridImportKwh: row.gridImportKwh,
      gridExportKwh: row.gridExportKwh
    },
    
    // Full power statistics (single source of truth)
    power: {
      solar: {
        minW: row.solarWMin,
        avgW: row.solarWAvg,
        maxW: row.solarWMax
      },
      load: {
        minW: row.loadWMin,
        avgW: row.loadWAvg,
        maxW: row.loadWMax
      },
      battery: {
        minW: row.batteryWMin,
        avgW: row.batteryWAvg,
        maxW: row.batteryWMax
      },
      grid: {
        minW: row.gridWMin,
        avgW: row.gridWAvg,
        maxW: row.gridWMax
      }
    },
    
    // Battery SOC statistics
    soc: {
      minBattery: row.batterySocMin,
      avgBattery: row.batterySocAvg,
      maxBattery: row.batterySocMax,
      endBattery: row.batterySocEnd
    },
    
    // Data quality
    dataQuality: {
      intervalCount: row.intervalCount,
      sampleCount: row.sampleCount
    }
  }));
}

// Fetch 30-minute aggregated data by fetching 5-minute data and aggregating
export async function fetch30MinuteData(systemId: number, startTime: ZonedDateTime, endTime: ZonedDateTime, timezoneOffset: number = 10) {
  // First fetch the 5-minute data
  const data5m = await fetch5MinuteData(systemId, startTime, endTime, timezoneOffset);
  
  if (data5m.length === 0) return [];
  
  const result: any[] = [];
  
  // Accumulators for the current 30-minute interval
  let solarWSum = 0, solarWMin = Infinity, solarWMax = -Infinity;
  let loadWSum = 0, loadWMin = Infinity, loadWMax = -Infinity;
  let batteryWSum = 0, batteryWMin = Infinity, batteryWMax = -Infinity;
  let gridWSum = 0, gridWMin = Infinity, gridWMax = -Infinity;
  let totalSamples = 0;
  let count = 0;
  let lastReading: any = null;
  
  // Process data in order (it's already sorted)
  for (let i = 0; i < data5m.length; i++) {
    const reading = data5m[i];
    
    // Track total samples for data quality reporting
    totalSamples += reading.dataQuality.sampleCount;
    
    // Weight each 5-minute interval equally (not by sample count)
    if (reading.power.solar.avgW !== null) {
      solarWSum += reading.power.solar.avgW;  // Equal weight for each interval
      solarWMin = Math.min(solarWMin, reading.power.solar.minW || Infinity);
      solarWMax = Math.max(solarWMax, reading.power.solar.maxW || -Infinity);
    }
    if (reading.power.load.avgW !== null) {
      loadWSum += reading.power.load.avgW;  // Equal weight for each interval
      loadWMin = Math.min(loadWMin, reading.power.load.minW || Infinity);
      loadWMax = Math.max(loadWMax, reading.power.load.maxW || -Infinity);
    }
    if (reading.power.battery.avgW !== null) {
      batteryWSum += reading.power.battery.avgW;  // Equal weight for each interval
      batteryWMin = Math.min(batteryWMin, reading.power.battery.minW || Infinity);
      batteryWMax = Math.max(batteryWMax, reading.power.battery.maxW || -Infinity);
    }
    if (reading.power.grid.avgW !== null) {
      gridWSum += reading.power.grid.avgW;  // Equal weight for each interval
      gridWMin = Math.min(gridWMin, reading.power.grid.minW || Infinity);
      gridWMax = Math.max(gridWMax, reading.power.grid.maxW || -Infinity);
    }
    
    lastReading = reading;
    count++;
    
    // Every 6 readings (or at the end of data), create a 30-minute aggregate
    if (count === 6 || i === data5m.length - 1) {
      // Keep the same shape as 5-minute data
      result.push({
        // Use the last reading's intervalEnd (already a ZonedDateTime)
        intervalEnd: reading.intervalEnd,
        
        // Battery SOC - use the last value
        batterySOCLast: lastReading?.batterySOCLast || null,
        
        // Data quality
        dataQuality: {
          intervalCount: count,  // Number of 5-minute intervals aggregated
          sampleCount: totalSamples  // Total raw samples (cascaded)
        },
        
        // Full power statistics with proper min/max/avg across the interval (single source of truth)
        power: {
          solar: {
            minW: solarWMin === Infinity ? null : solarWMin,
            avgW: count > 0 ? Math.round(solarWSum / count) : null,  // Average of interval averages
            maxW: solarWMax === -Infinity ? null : solarWMax
          },
          load: {
            minW: loadWMin === Infinity ? null : loadWMin,
            avgW: count > 0 ? Math.round(loadWSum / count) : null,  // Average of interval averages
            maxW: loadWMax === -Infinity ? null : loadWMax
          },
          battery: {
            minW: batteryWMin === Infinity ? null : batteryWMin,
            avgW: count > 0 ? Math.round(batteryWSum / count) : null,  // Average of interval averages
            maxW: batteryWMax === -Infinity ? null : batteryWMax
          },
          grid: {
            minW: gridWMin === Infinity ? null : gridWMin,
            avgW: count > 0 ? Math.round(gridWSum / count) : null,  // Average of interval averages
            maxW: gridWMax === -Infinity ? null : gridWMax
          }
        },
        
        // Energy totals - use the last values
        energy: lastReading?.energy || {
          solarKwhTotal: null,
          loadKwhTotal: null,
          batteryInKwhTotal: null,
          batteryOutKwhTotal: null,
          gridInKwhTotal: null,
          gridOutKwhTotal: null
        }
      });
      
      // Reset for next interval
      solarWSum = 0; solarWMin = Infinity; solarWMax = -Infinity;
      loadWSum = 0; loadWMin = Infinity; loadWMax = -Infinity;
      batteryWSum = 0; batteryWMin = Infinity; batteryWMax = -Infinity;
      gridWSum = 0; gridWMin = Infinity; gridWMax = -Infinity;
      totalSamples = 0;
      count = 0;
      lastReading = null;
    }
  }
  
  return result;
}