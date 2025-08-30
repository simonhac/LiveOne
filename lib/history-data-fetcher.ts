import { db } from '@/lib/db';
import { readingsAgg5m, readingsAgg1d } from '@/lib/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { formatDateAEST, toUnixTimestamp, fromUnixTimestamp } from '@/lib/date-utils';
import { CalendarDate, ZonedDateTime, parseDate } from '@internationalized/date';

/**
 * Fill gaps in daily data with nulls
 * @param data Array of data points with date property (may have gaps)
 * @param startDate Start date
 * @param endDate End date
 * @returns Array with nulls inserted for missing days
 */
function fillDailyGaps<T extends { date: CalendarDate }>(
  data: T[],
  startDate: CalendarDate,
  endDate: CalendarDate
): (T | null)[] {
  if (data.length === 0) {
    // Generate all nulls for empty data
    const result: null[] = [];
    let currentDate = startDate.copy();
    
    while (currentDate.compare(endDate) <= 0) {
      result.push(null);
      currentDate = currentDate.add({ days: 1 });
    }
    return result;
  }
  
  const result: (T | null)[] = [];
  let expectedDate = startDate.copy();
  let dataIndex = 0;
  
  // Fill gaps with nulls
  while (expectedDate.compare(endDate) <= 0) {
    const currentItem = data[dataIndex];
    
    if (currentItem && currentItem.date.compare(expectedDate) === 0) {
      // We have data for this day
      result.push(currentItem);
      dataIndex++;
    } else {
      // Missing data - insert null
      result.push(null);
    }
    
    expectedDate = expectedDate.add({ days: 1 });
  }
  
  return result;
}

/**
 * Fill gaps in time series data with nulls
 * @param data Array of data points with intervalEnd property (may have gaps)
 * @param startTime Start of the time range
 * @param endTime End of the time range
 * @param intervalMinutes Interval size in minutes (5 or 30)
 * @returns Array with nulls inserted for missing intervals
 */
function fillTimeSeriesGaps<T extends { intervalEnd: ZonedDateTime }>(
  data: T[],
  startTime: ZonedDateTime,
  endTime: ZonedDateTime,
  intervalMinutes: number
): (T | null)[] {
  if (data.length === 0) {
    // Generate all nulls for empty data
    const result: null[] = [];
    const intervalSeconds = intervalMinutes * 60;
    const startTimestamp = toUnixTimestamp(startTime);
    const endTimestamp = toUnixTimestamp(endTime);
    let expectedIntervalEnd = Math.ceil(startTimestamp / intervalSeconds) * intervalSeconds;
    
    while (expectedIntervalEnd <= endTimestamp) {
      result.push(null);
      expectedIntervalEnd += intervalSeconds;
    }
    return result;
  }
  
  const result: (T | null)[] = [];
  const intervalSeconds = intervalMinutes * 60;
  const startTimestamp = toUnixTimestamp(startTime);
  const endTimestamp = toUnixTimestamp(endTime);
  
  // Start with the first expected interval (aligned to interval boundary)
  let expectedIntervalEnd = Math.ceil(startTimestamp / intervalSeconds) * intervalSeconds;
  let dataIndex = 0;
  
  // Fill gaps with nulls
  while (expectedIntervalEnd <= endTimestamp) {
    const currentItem = data[dataIndex];
    
    if (currentItem) {
      const itemTimestamp = toUnixTimestamp(currentItem.intervalEnd);
      
      if (itemTimestamp === expectedIntervalEnd) {
        // We have data for this interval
        result.push(currentItem);
        dataIndex++;
      } else {
        // Missing data - insert null
        result.push(null);
      }
    } else {
      // No more data - fill remaining intervals with nulls
      result.push(null);
    }
    
    expectedIntervalEnd += intervalSeconds;
  }
  
  return result;
}

// Fetch 5-minute aggregated data with reshaping
export async function fetch5MinuteData(systemId: number, startTime: ZonedDateTime, endTime: ZonedDateTime, timezoneOffsetMin: number) {
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
  const reshapedData = data.map(row => ({
    // Convert Unix seconds to ZonedDateTime
    intervalEnd: fromUnixTimestamp(row.intervalEnd, timezoneOffsetMin),
    
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
    
    // Data quality
    dataQuality: {
      sampleCount: row.sampleCount
    }
  }));
  
  // Fill gaps with nulls
  return fillTimeSeriesGaps(reshapedData, startTime, endTime, 5);
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
  const reshapedData = dailyData.map(row => ({
    // Parse the day string to CalendarDate
    date: parseDate(row.day),
    
    // Daily power, energy and SoC values
    solar: {
      minW: row.solarWMin,
      avgW: row.solarWAvg,
      maxW: row.solarWMax,
      intervalKwh: row.solarKwh
    },
    load: {
      minW: row.loadWMin,
      avgW: row.loadWAvg,
      maxW: row.loadWMax,
      loadIntervalKwh: row.loadKwh
    },
    battery: {
      minW: row.batteryWMin,
      avgW: row.batteryWAvg,
      maxW: row.batteryWMax,
      chargeIntervalKwh: row.batteryChargeKwh,
      dischargeIntervalKwh: row.batteryDischargeKwh,
      batteryLastSOC: row.batterySocEnd
    },
    grid: {
      minW: row.gridWMin,
      avgW: row.gridWAvg,
      maxW: row.gridWMax,
      importIntervalKwh: row.gridImportKwh,
      exportIntervalKwh: row.gridExportKwh
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
  
  // Fill gaps with nulls
  return fillDailyGaps(reshapedData, startDate, endDate);
}

// Fetch 30-minute aggregated data by fetching 5-minute data and aggregating
export async function fetch30MinuteData(systemId: number, startTime: ZonedDateTime, endTime: ZonedDateTime, timezoneOffsetMin: number) {
  // First fetch the 5-minute data
  const data5m = await fetch5MinuteData(systemId, startTime, endTime, timezoneOffsetMin);
  
  if (data5m.length === 0) return [];
  
  const result: any[] = [];
  
  // Track current 30-minute interval end time
  let currentIntervalEnd = startTime.add({ minutes: 30 });
  
  // Accumulators for the current 30-minute interval
  let solarWSum = 0, solarWMin = Infinity, solarWMax = -Infinity;
  let loadWSum = 0, loadWMin = Infinity, loadWMax = -Infinity;
  let batteryWSum = 0, batteryWMin = Infinity, batteryWMax = -Infinity;
  let gridWSum = 0, gridWMin = Infinity, gridWMax = -Infinity;
  let totalSamples = 0;
  let nonNullCount = 0;  // Count of non-null intervals for averaging
  let count = 0;
  let lastReading: any = null;
  
  // Process data in order (it's already sorted)
  for (let i = 0; i < data5m.length; i++) {
    const reading = data5m[i];
    
    if (reading) {
      // Track total samples for data quality reporting
      totalSamples += reading.dataQuality.sampleCount;
      nonNullCount++;
      
      // Weight each 5-minute interval equally (not by sample count)
      if (reading.power?.solar?.avgW !== null && reading.power?.solar?.avgW !== undefined) {
        solarWSum += reading.power.solar.avgW;  // Equal weight for each interval
        solarWMin = Math.min(solarWMin, reading.power.solar.minW ?? Infinity);
        solarWMax = Math.max(solarWMax, reading.power.solar.maxW ?? -Infinity);
      }
      if (reading.power?.load?.avgW !== null && reading.power?.load?.avgW !== undefined) {
        loadWSum += reading.power.load.avgW;  // Equal weight for each interval
        loadWMin = Math.min(loadWMin, reading.power.load.minW ?? Infinity);
        loadWMax = Math.max(loadWMax, reading.power.load.maxW ?? -Infinity);
      }
      if (reading.power?.battery?.avgW !== null && reading.power?.battery?.avgW !== undefined) {
        batteryWSum += reading.power.battery.avgW;  // Equal weight for each interval
        batteryWMin = Math.min(batteryWMin, reading.power.battery.minW ?? Infinity);
        batteryWMax = Math.max(batteryWMax, reading.power.battery.maxW ?? -Infinity);
      }
      if (reading.power?.grid?.avgW !== null && reading.power?.grid?.avgW !== undefined) {
        gridWSum += reading.power.grid.avgW;  // Equal weight for each interval
        gridWMin = Math.min(gridWMin, reading.power.grid.minW ?? Infinity);
        gridWMax = Math.max(gridWMax, reading.power.grid.maxW ?? -Infinity);
      }
      
      lastReading = reading;
    }
    
    count++;
    
    // Every 6 readings (or at the end of data), create a 30-minute aggregate
    if (count === 6 || i === data5m.length - 1) {
      // Keep the same shape as 5-minute data
      result.push({
        // Use the current interval end time
        intervalEnd: currentIntervalEnd,
        
        // Battery SOC - use the last value
        batterySOCLast: lastReading?.batterySOCLast ?? null,
        
        // Data quality
        dataQuality: {
          intervalCount: count,  // Number of 5-minute intervals aggregated
          sampleCount: totalSamples  // Total raw samples (cascaded)
        },
        
        // Full power statistics with proper min/max/avg across the interval (single source of truth)
        power: {
          solar: {
            minW: solarWMin === Infinity ? null : solarWMin,
            avgW: nonNullCount > 0 ? Math.round(solarWSum / nonNullCount) : null,  // Average using only non-null intervals
            maxW: solarWMax === -Infinity ? null : solarWMax
          },
          load: {
            minW: loadWMin === Infinity ? null : loadWMin,
            avgW: nonNullCount > 0 ? Math.round(loadWSum / nonNullCount) : null,  // Average using only non-null intervals
            maxW: loadWMax === -Infinity ? null : loadWMax
          },
          battery: {
            minW: batteryWMin === Infinity ? null : batteryWMin,
            avgW: nonNullCount > 0 ? Math.round(batteryWSum / nonNullCount) : null,  // Average using only non-null intervals
            maxW: batteryWMax === -Infinity ? null : batteryWMax
          },
          grid: {
            minW: gridWMin === Infinity ? null : gridWMin,
            avgW: nonNullCount > 0 ? Math.round(gridWSum / nonNullCount) : null,  // Average using only non-null intervals
            maxW: gridWMax === -Infinity ? null : gridWMax
          }
        },
        
        // Energy totals - use the last values
        energy: lastReading?.energy ?? {
          solarKwhTotal: null,
          loadKwhTotal: null,
          batteryInKwhTotal: null,
          batteryOutKwhTotal: null,
          gridInKwhTotal: null,
          gridOutKwhTotal: null
        }
      });
      
      // Move to next 30-minute interval
      currentIntervalEnd = currentIntervalEnd.add({ minutes: 30 });
      
      // Reset for next interval
      solarWSum = 0; solarWMin = Infinity; solarWMax = -Infinity;
      loadWSum = 0; loadWMin = Infinity; loadWMax = -Infinity;
      batteryWSum = 0; batteryWMin = Infinity; batteryWMax = -Infinity;
      gridWSum = 0; gridWMin = Infinity; gridWMax = -Infinity;
      totalSamples = 0;
      nonNullCount = 0;
      count = 0;
      lastReading = null;
    }
  }
  
  // Fill gaps with nulls (30-minute intervals)
  return fillTimeSeriesGaps(result, startTime, endTime, 30);
}