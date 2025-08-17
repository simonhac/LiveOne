#!/usr/bin/env tsx
// Script to create and populate the 5-minute aggregated readings table

import { db } from '../lib/db';
import { readingsAgg5m, readings, systems } from '../lib/db/schema';
import { sql, eq, and, gte, lte, desc } from 'drizzle-orm';

async function createAndPopulateAggregatedTable() {
  console.log('Creating 5-minute aggregated readings table...');
  
  try {
    // Create the table (drizzle will handle this through the schema)
    // The table will be created when we first try to insert
    
    // Get all systems
    const allSystems = await db.select().from(systems);
    console.log(`Found ${allSystems.length} systems to process`);
    
    for (const system of allSystems) {
      console.log(`\nProcessing system ${system.systemNumber} (ID: ${system.id})`);
      
      // Get the date range of data for this system
      const [oldestReading] = await db
        .select({ inverterTime: readings.inverterTime })
        .from(readings)
        .where(eq(readings.systemId, system.id))
        .orderBy(readings.inverterTime)
        .limit(1);
      
      const [newestReading] = await db
        .select({ inverterTime: readings.inverterTime })
        .from(readings)
        .where(eq(readings.systemId, system.id))
        .orderBy(desc(readings.inverterTime))
        .limit(1);
      
      if (!oldestReading || !newestReading) {
        console.log(`No readings found for system ${system.systemNumber}`);
        continue;
      }
      
      const startDate = oldestReading.inverterTime;
      const endDate = newestReading.inverterTime;
      
      console.log(`Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
      
      // Process in daily chunks to avoid memory issues
      const currentDate = new Date(startDate);
      currentDate.setHours(0, 0, 0, 0);
      
      let totalIntervals = 0;
      let processedDays = 0;
      
      while (currentDate <= endDate) {
        const dayStart = new Date(currentDate);
        const dayEnd = new Date(currentDate);
        dayEnd.setDate(dayEnd.getDate() + 1);
        
        // Fetch all readings for this day
        const dayReadings = await db
          .select()
          .from(readings)
          .where(
            and(
              eq(readings.systemId, system.id),
              gte(readings.inverterTime, dayStart),
              lte(readings.inverterTime, dayEnd)
            )
          )
          .orderBy(readings.inverterTime);
        
        if (dayReadings.length === 0) {
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }
        
        // Group readings into 5-minute intervals
        const intervals = new Map<number, typeof dayReadings>();
        
        for (const reading of dayReadings) {
          // Calculate the 5-minute interval end time
          const time = reading.inverterTime.getTime();
          const intervalMs = 5 * 60 * 1000;
          const intervalEnd = Math.ceil(time / intervalMs) * intervalMs;
          
          if (!intervals.has(intervalEnd)) {
            intervals.set(intervalEnd, []);
          }
          intervals.get(intervalEnd)!.push(reading);
        }
        
        // Create aggregated records for each interval
        const aggregatedRecords = [];
        
        for (const [intervalEnd, intervalReadings] of intervals) {
          if (intervalReadings.length === 0) continue;
          
          // Sort readings by time to get the last one
          const sortedReadings = intervalReadings.sort((a, b) => 
            a.inverterTime.getTime() - b.inverterTime.getTime()
          );
          const lastReading = sortedReadings[sortedReadings.length - 1];
          
          // Calculate aggregated values
          const solarWValues = intervalReadings.map(r => r.solarW).filter(v => v !== null);
          const loadWValues = intervalReadings.map(r => r.loadW).filter(v => v !== null);
          const batteryWValues = intervalReadings.map(r => r.batteryW).filter(v => v !== null);
          const gridWValues = intervalReadings.map(r => r.gridW).filter(v => v !== null);
          
          aggregatedRecords.push({
            systemId: system.id,
            intervalEnd: new Date(intervalEnd),
            
            // Power averages, min, max
            solarWAvg: solarWValues.length > 0 ? solarWValues.reduce((a, b) => a + b, 0) / solarWValues.length : null,
            solarWMin: solarWValues.length > 0 ? Math.min(...solarWValues) : null,
            solarWMax: solarWValues.length > 0 ? Math.max(...solarWValues) : null,
            
            loadWAvg: loadWValues.length > 0 ? loadWValues.reduce((a, b) => a + b, 0) / loadWValues.length : null,
            loadWMin: loadWValues.length > 0 ? Math.min(...loadWValues) : null,
            loadWMax: loadWValues.length > 0 ? Math.max(...loadWValues) : null,
            
            batteryWAvg: batteryWValues.length > 0 ? batteryWValues.reduce((a, b) => a + b, 0) / batteryWValues.length : null,
            batteryWMin: batteryWValues.length > 0 ? Math.min(...batteryWValues) : null,
            batteryWMax: batteryWValues.length > 0 ? Math.max(...batteryWValues) : null,
            
            gridWAvg: gridWValues.length > 0 ? gridWValues.reduce((a, b) => a + b, 0) / gridWValues.length : null,
            gridWMin: gridWValues.length > 0 ? Math.min(...gridWValues) : null,
            gridWMax: gridWValues.length > 0 ? Math.max(...gridWValues) : null,
            
            // State values - use last reading
            batterySOCLast: lastReading.batterySOC,
            
            // Energy counters - use last reading
            solarKwhTotalLast: lastReading.solarKwhTotal,
            loadKwhTotalLast: lastReading.loadKwhTotal,
            batteryInKwhTotalLast: lastReading.batteryInKwhTotal,
            batteryOutKwhTotalLast: lastReading.batteryOutKwhTotal,
            gridInKwhTotalLast: lastReading.gridInKwhTotal,
            gridOutKwhTotalLast: lastReading.gridOutKwhTotal,
            
            sampleCount: intervalReadings.length,
          });
        }
        
        // Insert aggregated records (using upsert to handle duplicates)
        if (aggregatedRecords.length > 0) {
          // Insert in batches of 100
          for (let i = 0; i < aggregatedRecords.length; i += 100) {
            const batch = aggregatedRecords.slice(i, i + 100);
            
            // Use INSERT OR REPLACE to handle duplicates
            for (const record of batch) {
              await db.insert(readingsAgg5m)
                .values(record)
                .onConflictDoUpdate({
                  target: [readingsAgg5m.systemId, readingsAgg5m.intervalEnd],
                  set: record,
                });
            }
          }
          
          totalIntervals += aggregatedRecords.length;
        }
        
        processedDays++;
        if (processedDays % 10 === 0) {
          console.log(`  Processed ${processedDays} days, ${totalIntervals} intervals so far...`);
        }
        
        currentDate.setDate(currentDate.getDate() + 1);
      }
      
      console.log(`  Completed: ${processedDays} days, ${totalIntervals} total intervals`);
    }
    
    // Verify the data
    const totalRecords = await db
      .select({ count: sql<number>`count(*)` })
      .from(readingsAgg5m);
    
    console.log(`\n✅ Migration complete! Total aggregated records: ${totalRecords[0].count}`);
    
    // Show sample performance comparison
    console.log('\n📊 Sample query performance test:');
    
    // Test original query time
    const startOriginal = Date.now();
    const originalData = await db
      .select()
      .from(readings)
      .where(
        and(
          eq(readings.systemId, allSystems[0].id),
          gte(readings.inverterTime, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        )
      );
    const originalTime = Date.now() - startOriginal;
    
    // Test aggregated query time
    const startAgg = Date.now();
    const aggData = await db
      .select()
      .from(readingsAgg5m)
      .where(
        and(
          eq(readingsAgg5m.systemId, allSystems[0].id),
          gte(readingsAgg5m.intervalEnd, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        )
      );
    const aggTime = Date.now() - startAgg;
    
    console.log(`  Original query (7 days): ${originalData.length} rows in ${originalTime}ms`);
    console.log(`  Aggregated query (7 days): ${aggData.length} rows in ${aggTime}ms`);
    console.log(`  Speed improvement: ${(originalTime / aggTime).toFixed(1)}x faster`);
    
  } catch (error) {
    console.error('Error during migration:', error);
    process.exit(1);
  }
}

// Run the migration
createAndPopulateAggregatedTable()
  .then(() => {
    console.log('\n✨ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });