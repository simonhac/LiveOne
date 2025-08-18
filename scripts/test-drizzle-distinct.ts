#!/usr/bin/env npx tsx

import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { readingsAgg5m } from '../lib/db/schema';
import { gte } from 'drizzle-orm';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env.local  
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function main() {
  console.log('Testing Drizzle distinct queries on production...\n');
  
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  
  const db = drizzle(client);

  try {
    // Test 1: Simple select with groupBy
    console.log('Test 1: select().from().groupBy()');
    const result1 = await db
      .select({ systemId: readingsAgg5m.systemId })
      .from(readingsAgg5m)
      .groupBy(readingsAgg5m.systemId);
    console.log(`Found ${result1.length} systems:`, result1.map(r => r.systemId));
    
    // Test 2: With WHERE clause
    console.log('\nTest 2: With WHERE clause (last 7 days)');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result2 = await db
      .select({ systemId: readingsAgg5m.systemId })
      .from(readingsAgg5m)
      .where(gte(readingsAgg5m.intervalEnd, sevenDaysAgo))
      .groupBy(readingsAgg5m.systemId);
    console.log(`Found ${result2.length} systems with recent data:`, result2.map(r => r.systemId));
    
    // Test 3: Using selectDistinct (the old broken way)
    console.log('\nTest 3: selectDistinct (old broken way - should fail or return wrong)');
    try {
      const result3 = await db
        .selectDistinct()
        .from(readingsAgg5m);
      console.log(`selectDistinct returned ${result3.length} rows (WRONG - should be 2)`);
      console.log(`First 5 systemIds:`, result3.slice(0, 5).map(r => r.systemId));
    } catch (error: any) {
      console.log(`selectDistinct failed: ${error.message}`);
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
  
  process.exit(0);
}

main().catch(console.error);