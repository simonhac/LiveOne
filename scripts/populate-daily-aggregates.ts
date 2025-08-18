#!/usr/bin/env tsx

import { aggregateAllDailyData } from '@/lib/db/aggregate-daily';
import { db } from '@/lib/db';
import { readingsAgg5m } from '@/lib/db/schema';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Starting daily aggregates population...\n');
  
  try {
    // Get all unique system IDs
    const systems = await db
      .selectDistinct({ systemId: readingsAgg5m.systemId })
      .from(readingsAgg5m);
    
    console.log(`Found ${systems.length} systems to process\n`);
    
    let totalAggregated = 0;
    
    for (const system of systems) {
      console.log(`\nProcessing system ${system.systemId}...`);
      
      try {
        const results = await aggregateAllDailyData(system.systemId.toString());
        totalAggregated += results.length;
        console.log(`✓ Aggregated ${results.length} days for system ${system.systemId}`);
      } catch (error) {
        console.error(`✗ Failed to aggregate system ${system.systemId}:`, error);
      }
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✓ Population complete!`);
    console.log(`  Total days aggregated: ${totalAggregated}`);
    console.log(`  Systems processed: ${systems.length}`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Show sample of aggregated data
    const sample = await db
      .select({
        systemId: readingsAgg1d.systemId,
        day: readingsAgg1d.day,
        solarKwh: readingsAgg1d.solarKwh,
        loadKwh: readingsAgg1d.loadKwh,
        intervalCount: readingsAgg1d.intervalCount
      })
      .from(readingsAgg1d)
      .limit(5);
    
    console.log('Sample of aggregated data:');
    console.table(sample);
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

// Import the schema to ensure types are available
import { readingsAgg1d } from '@/lib/db/schema';

main().catch(console.error);