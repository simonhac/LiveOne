import { db } from '@/lib/db';
import { readingsAgg5m, readingsAgg1d, systems } from '@/lib/db/schema';
import { sql, eq, and, gte, lt, desc, asc } from 'drizzle-orm';

/**
 * Aggregate data for a specific day and system
 * @param systemId - The system ID to aggregate
 * @param day - The day in YYYY-MM-DD format
 */
export async function aggregateDailyData(systemId: string, day: string) {
  const startTime = performance.now();
  
  // Get the system's timezone offset
  const [system] = await db.select()
    .from(systems)
    .where(eq(systems.id, parseInt(systemId)))
    .limit(1);
  
  if (!system) {
    throw new Error(`System ${systemId} not found`);
  }
  
  // Calculate the start and end timestamps for the day in the system's timezone
  // For example, for timezone offset +10 (AEST):
  // 2025-08-17T00:00:00+10:00 = 2025-08-16T14:00:00 UTC
  const offsetHours = system.timezoneOffset;
  const offsetString = offsetHours >= 0 ? `+${String(offsetHours).padStart(2, '0')}:00` : `-${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  
  const dayStart = new Date(`${day}T00:00:00${offsetString}`);
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const dayEnd = nextDay; // 00:00:00 of the next day
  
  try {
    // Get all 5-minute aggregated data for the day
    // Using > dayStart and <= dayEnd because interval_end represents the END of each 5-minute period
    // So a period ending at 00:00:00 belongs to the previous day
    const fiveMinData = await db
      .select()
      .from(readingsAgg5m)
      .where(
        and(
          eq(readingsAgg5m.systemId, parseInt(systemId)),
          sql`${readingsAgg5m.intervalEnd} > ${dayStart}`,
          sql`${readingsAgg5m.intervalEnd} <= ${dayEnd}`
        )
      )
      .orderBy(asc(readingsAgg5m.intervalEnd));

    if (fiveMinData.length === 0) {
      console.log(`No data found for system ${systemId} on ${day}`);
      return null;
    }

    // Calculate power statistics (min, avg, max)
    const solarWValues = fiveMinData.map(d => d.solarWAvg).filter(v => v !== null) as number[];
    const loadWValues = fiveMinData.map(d => d.loadWAvg).filter(v => v !== null) as number[];
    const batteryWValues = fiveMinData.map(d => d.batteryWAvg).filter(v => v !== null) as number[];
    const gridWValues = fiveMinData.map(d => d.gridWAvg).filter(v => v !== null) as number[];
    const socValues = fiveMinData.map(d => d.batterySOCLast).filter(v => v !== null) as number[];

    // Get the first and last records for energy calculations
    const firstRecord = fiveMinData[0];
    const lastRecord = fiveMinData[fiveMinData.length - 1];
    
    // Get the previous day's last record for energy delta calculation
    // We want the last record with interval_end <= dayStart (which is 00:00:00)
    const previousDayData = await db
      .select()
      .from(readingsAgg5m)
      .where(
        and(
          eq(readingsAgg5m.systemId, parseInt(systemId)),
          sql`${readingsAgg5m.intervalEnd} <= ${dayStart}`
        )
      )
      .orderBy(desc(readingsAgg5m.intervalEnd))
      .limit(1);
    
    const previousRecord = previousDayData[0];

    // Helper function to round to N decimal places
    const roundTo = (value: number | null, decimals: number) => {
      if (value === null) return null;
      const factor = Math.pow(10, decimals);
      return Math.round(value * factor) / factor;
    };

    // Calculate daily energy totals only if we have previous day's data
    let dailyEnergy = {
      solarKwh: null as number | null,
      loadKwh: null as number | null,
      batteryChargeKwh: null as number | null,
      batteryDischargeKwh: null as number | null,
      gridImportKwh: null as number | null,
      gridExportKwh: null as number | null,
    };

    if (previousRecord) {
      // We have previous data, so we can calculate daily totals
      dailyEnergy = {
        solarKwh: roundTo((lastRecord.solarKwhTotalLast ?? 0) - (previousRecord.solarKwhTotalLast ?? 0), 3),
        loadKwh: roundTo((lastRecord.loadKwhTotalLast ?? 0) - (previousRecord.loadKwhTotalLast ?? 0), 3),
        batteryChargeKwh: roundTo((lastRecord.batteryInKwhTotalLast ?? 0) - (previousRecord.batteryInKwhTotalLast ?? 0), 3),
        batteryDischargeKwh: roundTo((lastRecord.batteryOutKwhTotalLast ?? 0) - (previousRecord.batteryOutKwhTotalLast ?? 0), 3),
        gridImportKwh: roundTo((lastRecord.gridInKwhTotalLast ?? 0) - (previousRecord.gridInKwhTotalLast ?? 0), 3),
        gridExportKwh: roundTo((lastRecord.gridOutKwhTotalLast ?? 0) - (previousRecord.gridOutKwhTotalLast ?? 0), 3),
      };
    }

    const dailyAggregates = {
      systemId,
      day,
      
      // Energy metrics (kWh) - null for first day, calculated for subsequent days
      ...dailyEnergy,
      
      // Power statistics (W) - rounded to integers
      solarWMin: solarWValues.length > 0 ? Math.round(Math.min(...solarWValues)) : null,
      solarWAvg: solarWValues.length > 0 ? Math.round(solarWValues.reduce((a, b) => a + b, 0) / solarWValues.length) : null,
      solarWMax: solarWValues.length > 0 ? Math.round(Math.max(...solarWValues)) : null,
      
      loadWMin: loadWValues.length > 0 ? Math.round(Math.min(...loadWValues)) : null,
      loadWAvg: loadWValues.length > 0 ? Math.round(loadWValues.reduce((a, b) => a + b, 0) / loadWValues.length) : null,
      loadWMax: loadWValues.length > 0 ? Math.round(Math.max(...loadWValues)) : null,
      
      batteryWMin: batteryWValues.length > 0 ? Math.round(Math.min(...batteryWValues)) : null,
      batteryWAvg: batteryWValues.length > 0 ? Math.round(batteryWValues.reduce((a, b) => a + b, 0) / batteryWValues.length) : null,
      batteryWMax: batteryWValues.length > 0 ? Math.round(Math.max(...batteryWValues)) : null,
      
      gridWMin: gridWValues.length > 0 ? Math.round(Math.min(...gridWValues)) : null,
      gridWAvg: gridWValues.length > 0 ? Math.round(gridWValues.reduce((a, b) => a + b, 0) / gridWValues.length) : null,
      gridWMax: gridWValues.length > 0 ? Math.round(Math.max(...gridWValues)) : null,
      
      // Battery SOC statistics (%) - rounded to 1 decimal place
      batterySocMin: roundTo(socValues.length > 0 ? Math.min(...socValues) : null, 1),
      batterySocAvg: roundTo(socValues.length > 0 ? socValues.reduce((a, b) => a + b, 0) / socValues.length : null, 1),
      batterySocMax: roundTo(socValues.length > 0 ? Math.max(...socValues) : null, 1),
      batterySocEnd: roundTo(lastRecord.batterySOCLast, 1),
      
      // All-time energy metrics (kWh) - rounded to 3 decimal places
      solarAlltimeKwh: roundTo(lastRecord.solarKwhTotalLast, 3),
      loadAlltimeKwh: roundTo(lastRecord.loadKwhTotalLast, 3),
      batteryChargeAlltimeKwh: roundTo(lastRecord.batteryInKwhTotalLast, 3),
      batteryDischargeAlltimeKwh: roundTo(lastRecord.batteryOutKwhTotalLast, 3),
      gridImportAlltimeKwh: roundTo(lastRecord.gridInKwhTotalLast, 3),
      gridExportAlltimeKwh: roundTo(lastRecord.gridOutKwhTotalLast, 3),
      
      // Data quality
      intervalCount: fiveMinData.length,
      
      // Metadata
      version: 1,
      updatedAt: Math.floor(Date.now() / 1000)
    };

    // Insert or update the daily aggregate
    await db
      .insert(readingsAgg1d)
      .values(dailyAggregates)
      .onConflictDoUpdate({
        target: [readingsAgg1d.systemId, readingsAgg1d.day],
        set: {
          ...dailyAggregates,
          updatedAt: Math.floor(Date.now() / 1000)
        }
      });

    const processingTime = performance.now() - startTime;
    console.log(`Aggregated daily data for system ${systemId} on ${day} in ${processingTime.toFixed(2)}ms`);
    
    return dailyAggregates;
  } catch (error) {
    console.error(`Error aggregating daily data for system ${systemId} on ${day}:`, error);
    throw error;
  }
}

/**
 * Aggregate all missing daily data for a system
 * @param systemId - The system ID to aggregate
 * @param startDate - Optional start date (defaults to earliest data)
 * @param endDate - Optional end date (defaults to yesterday)
 */
export async function aggregateAllDailyData(
  systemId: string,
  startDate?: string,
  endDate?: string
) {
  try {
    // Get the date range
    let earliestDate = startDate;
    let latestDate = endDate;
    
    if (!earliestDate) {
      // Find the earliest data for this system
      const earliest = await db
        .select()
        .from(readingsAgg5m)
        .where(eq(readingsAgg5m.systemId, parseInt(systemId)))
        .orderBy(asc(readingsAgg5m.intervalEnd))
        .limit(1);
      
      if (earliest[0]) {
        earliestDate = earliest[0].intervalEnd.toISOString().split('T')[0];
      }
    }
    
    if (!latestDate) {
      // Default to yesterday
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      latestDate = yesterday.toISOString().split('T')[0];
    }
    
    if (!earliestDate) {
      console.log(`No data found for system ${systemId}`);
      return [];
    }
    
    // Get existing aggregated days
    const existingDays = await db
      .select()
      .from(readingsAgg1d)
      .where(
        and(
          eq(readingsAgg1d.systemId, systemId),
          gte(readingsAgg1d.day, earliestDate),
          lt(readingsAgg1d.day, latestDate)
        )
      );
    
    const existingDaySet = new Set(existingDays.map(d => d.day));
    
    // Generate list of all days in range
    const allDays: string[] = [];
    const currentDate = new Date(earliestDate);
    const endDateObj = new Date(latestDate);
    
    while (currentDate <= endDateObj) {
      const dayStr = currentDate.toISOString().split('T')[0];
      if (!existingDaySet.has(dayStr)) {
        allDays.push(dayStr);
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    console.log(`Found ${allDays.length} days to aggregate for system ${systemId}`);
    
    // Aggregate each missing day
    const results = [];
    for (const day of allDays) {
      try {
        const result = await aggregateDailyData(systemId, day);
        if (result) {
          results.push(result);
        }
      } catch (error) {
        console.error(`Failed to aggregate ${day}:`, error);
      }
    }
    
    console.log(`Successfully aggregated ${results.length} days for system ${systemId}`);
    return results;
  } catch (error) {
    console.error(`Error aggregating all daily data for system ${systemId}:`, error);
    throw error;
  }
}

/**
 * Aggregate yesterday's data for all active systems
 * This should be run daily via cron job
 */
export async function aggregateYesterdayForAllSystems() {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    // Get all unique system IDs from recent data  
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const allSystems = await db
      .select()
      .from(readingsAgg5m)
      .where(gte(readingsAgg5m.intervalEnd, sevenDaysAgo));
    
    // Extract unique system IDs
    const uniqueSystemIds = [...new Set(allSystems.map(r => r.systemId))];
    const systemsQuery = uniqueSystemIds.map(id => ({ systemId: id }));
    
    console.log(`Aggregating yesterday's data (${yesterdayStr}) for ${systemsQuery.length} systems`);
    
    const results = [];
    for (const system of systemsQuery) {
      try {
        const result = await aggregateDailyData(system.systemId.toString(), yesterdayStr);
        if (result) {
          results.push(result);
        }
      } catch (error) {
        console.error(`Failed to aggregate yesterday's data for system ${system.systemId}:`, error);
      }
    }
    
    console.log(`Successfully aggregated yesterday's data for ${results.length} systems`);
    return results;
  } catch (error) {
    console.error('Error aggregating yesterday data for all systems:', error);
    throw error;
  }
}

/**
 * Aggregate ALL missing daily data for ALL systems
 * This can be used for initial population or catching up
 */
export async function aggregateAllMissingDaysForAllSystems() {
  try {
    // Get all unique system IDs that have any 5-minute data
    const allSystems = await db
      .select()
      .from(readingsAgg5m);
    
    // Extract unique system IDs
    const uniqueSystemIds = [...new Set(allSystems.map(r => r.systemId))];
    const systems = uniqueSystemIds.map(id => ({ systemId: id }));
    
    console.log(`Found ${systems.length} systems to process for all missing days`);
    
    let totalAggregated = 0;
    const systemResults = [];
    
    for (const system of systems) {
      try {
        console.log(`Processing all missing days for system ${system.systemId}...`);
        const results = await aggregateAllDailyData(system.systemId.toString());
        totalAggregated += results.length;
        systemResults.push({
          systemId: system.systemId,
          daysAggregated: results.length
        });
        console.log(`✓ Aggregated ${results.length} days for system ${system.systemId}`);
      } catch (error) {
        console.error(`Failed to aggregate system ${system.systemId}:`, error);
      }
    }
    
    console.log(`Successfully aggregated ${totalAggregated} total days across ${systems.length} systems`);
    return systemResults;
  } catch (error) {
    console.error('Error aggregating all missing days for all systems:', error);
    throw error;
  }
}