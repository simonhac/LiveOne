#!/usr/bin/env npx tsx
/**
 * Rebuild 5-minute aggregations from raw readings
 * 
 * Usage:
 *   npx tsx scripts/rebuild-5min-aggregations.ts                     # Rebuild all
 *   npx tsx scripts/rebuild-5min-aggregations.ts --date 2025-08-16   # Specific date
 *   npx tsx scripts/rebuild-5min-aggregations.ts --system 1          # Specific system
 *   npx tsx scripts/rebuild-5min-aggregations.ts --system 1 --date 2025-08-16
 */

import { db } from '../lib/db';
import { readings, readingsAgg5m } from '../lib/db/schema';
import { eq, and, gte, lte, sql, asc } from 'drizzle-orm';

// Parse command line arguments
const args = process.argv.slice(2);
let targetDate: string | undefined;
let targetSystemId: number | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date' && args[i + 1]) {
    targetDate = args[i + 1];
    i++;
  } else if (args[i] === '--system' && args[i + 1]) {
    targetSystemId = parseInt(args[i + 1]);
    i++;
  }
}

async function rebuild5MinAggregations(systemId?: number, date?: string) {
  const startTime = performance.now();
  
  console.log('🔄 Starting 5-minute aggregation rebuild...');
  if (systemId) console.log(`   System: ${systemId}`);
  if (date) console.log(`   Date: ${date}`);
  
  try {
    // Build WHERE conditions for filtering
    const conditions = [];
    if (systemId !== undefined) {
      conditions.push(eq(readings.systemId, systemId));
    }
    if (date) {
      // Convert date to Unix timestamp range (assuming UTC+10)
      const startOfDay = new Date(`${date}T00:00:00+10:00`);
      const endOfDay = new Date(`${date}T23:59:59+10:00`);
      conditions.push(
        gte(readings.inverterTime, startOfDay),
        lte(readings.inverterTime, endOfDay)
      );
    }
    
    // Get all readings to process
    const query = conditions.length > 0 
      ? db.select().from(readings).where(and(...conditions))
      : db.select().from(readings);
    
    const allReadings = await query.orderBy(asc(readings.inverterTime));
    
    if (allReadings.length === 0) {
      console.log('❌ No readings found to process');
      return;
    }
    
    console.log(`📊 Found ${allReadings.length} readings to process`);
    
    // Group readings by system and 5-minute interval
    const intervalMap = new Map<string, typeof allReadings>();
    
    for (const reading of allReadings) {
      // Calculate 5-minute interval (round up to next boundary)
      const intervalMs = 5 * 60 * 1000;
      const readingTime = reading.inverterTime.getTime();
      const intervalEnd = Math.ceil(readingTime / intervalMs) * intervalMs;
      const intervalKey = `${reading.systemId}-${intervalEnd}`;
      
      if (!intervalMap.has(intervalKey)) {
        intervalMap.set(intervalKey, []);
      }
      intervalMap.get(intervalKey)!.push(reading);
    }
    
    console.log(`📦 Grouped into ${intervalMap.size} intervals`);
    
    // Delete existing aggregations for the affected intervals
    const deleteConditions = [];
    if (systemId !== undefined) {
      deleteConditions.push(eq(readingsAgg5m.systemId, systemId));
    }
    if (date) {
      // Get min and max interval ends from our grouped data
      const intervalEnds = Array.from(intervalMap.keys()).map(key => {
        const [, intervalEnd] = key.split('-');
        return parseInt(intervalEnd);
      });
      const minInterval = Math.min(...intervalEnds) / 1000; // Convert to seconds
      const maxInterval = Math.max(...intervalEnds) / 1000;
      deleteConditions.push(
        gte(readingsAgg5m.intervalEnd, minInterval),
        lte(readingsAgg5m.intervalEnd, maxInterval)
      );
    }
    
    if (deleteConditions.length > 0) {
      const deleted = await db.delete(readingsAgg5m)
        .where(and(...deleteConditions));
      console.log(`🗑️  Deleted existing aggregations`);
    } else {
      // If no filters, delete all
      await db.delete(readingsAgg5m);
      console.log(`🗑️  Deleted all existing aggregations`);
    }
    
    // Process each interval and create aggregations
    const aggregations = [];
    
    for (const [intervalKey, intervalReadings] of intervalMap) {
      const [systemIdStr, intervalEndMs] = intervalKey.split('-');
      const systemId = parseInt(systemIdStr);
      const intervalEnd = parseInt(intervalEndMs) / 1000; // Convert to seconds for DB
      
      // Sort readings by time to get the last one
      intervalReadings.sort((a, b) => a.inverterTime.getTime() - b.inverterTime.getTime());
      const lastReading = intervalReadings[intervalReadings.length - 1];
      
      // Calculate aggregated values
      const solarWValues = intervalReadings.map(r => r.solarW);
      const loadWValues = intervalReadings.map(r => r.loadW);
      const batteryWValues = intervalReadings.map(r => r.batteryW);
      const gridWValues = intervalReadings.map(r => r.gridW);
      
      // Helper function for safe average
      const avg = (values: number[]): number | null => {
        if (values.length === 0) return null;
        return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      };
      
      aggregations.push({
        systemId,
        intervalEnd,
        
        // Power statistics (integers)
        solarWAvg: avg(solarWValues),
        solarWMin: solarWValues.length > 0 ? Math.min(...solarWValues) : null,
        solarWMax: solarWValues.length > 0 ? Math.max(...solarWValues) : null,
        
        loadWAvg: avg(loadWValues),
        loadWMin: loadWValues.length > 0 ? Math.min(...loadWValues) : null,
        loadWMax: loadWValues.length > 0 ? Math.max(...loadWValues) : null,
        
        batteryWAvg: avg(batteryWValues),
        batteryWMin: batteryWValues.length > 0 ? Math.min(...batteryWValues) : null,
        batteryWMax: batteryWValues.length > 0 ? Math.max(...batteryWValues) : null,
        
        gridWAvg: avg(gridWValues),
        gridWMin: gridWValues.length > 0 ? Math.min(...gridWValues) : null,
        gridWMax: gridWValues.length > 0 ? Math.max(...gridWValues) : null,
        
        // Last values in interval
        batterySOCLast: lastReading.batterySOC,
        solarKwhTotalLast: lastReading.solarKwhTotal,
        loadKwhTotalLast: lastReading.loadKwhTotal,
        batteryInKwhTotalLast: lastReading.batteryInKwhTotal,
        batteryOutKwhTotalLast: lastReading.batteryOutKwhTotal,
        gridInKwhTotalLast: lastReading.gridInKwhTotal,
        gridOutKwhTotalLast: lastReading.gridOutKwhTotal,
        
        // Sample count
        sampleCount: intervalReadings.length,
        
        // Timestamp
        createdAt: new Date()
      });
    }
    
    // Insert all aggregations
    if (aggregations.length > 0) {
      await db.insert(readingsAgg5m).values(aggregations);
      console.log(`✅ Created ${aggregations.length} new aggregations`);
    }
    
    // Verify results
    const verifyConditions = [];
    if (systemId !== undefined) {
      verifyConditions.push(eq(readingsAgg5m.systemId, systemId));
    }
    
    const result = await db.select({
      count: sql<number>`COUNT(*)`,
      totalSamples: sql<number>`SUM(sample_count)`,
      minDate: sql<string>`DATE(datetime(MIN(interval_end), 'unixepoch', '+10 hours'))`,
      maxDate: sql<string>`DATE(datetime(MAX(interval_end), 'unixepoch', '+10 hours'))`
    })
    .from(readingsAgg5m)
    .where(verifyConditions.length > 0 ? and(...verifyConditions) : undefined);
    
    const stats = result[0];
    const duration = ((performance.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n📈 Rebuild complete!');
    console.log(`   Intervals: ${stats.count}`);
    console.log(`   Total samples: ${stats.totalSamples}`);
    console.log(`   Date range: ${stats.minDate} to ${stats.maxDate}`);
    console.log(`   Duration: ${duration}s`);
    
  } catch (error) {
    console.error('❌ Error rebuilding aggregations:', error);
    throw error;
  }
}

// Run the rebuild
rebuild5MinAggregations(targetSystemId, targetDate)
  .then(() => process.exit(0))
  .catch(() => process.exit(1));