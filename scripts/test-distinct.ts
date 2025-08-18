#!/usr/bin/env npx tsx

import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function main() {
  console.log('Testing distinct system query on production...\n');
  
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  try {
    // Test 1: Raw SQL distinct
    console.log('Test 1: Raw SQL DISTINCT');
    const result1 = await client.execute('SELECT DISTINCT system_id FROM readings_agg_5m');
    console.log(`Found ${result1.rows.length} distinct systems:`, result1.rows.map(r => r.system_id));
    
    // Test 2: GROUP BY
    console.log('\nTest 2: SQL GROUP BY');
    const result2 = await client.execute('SELECT system_id FROM readings_agg_5m GROUP BY system_id');
    console.log(`Found ${result2.rows.length} systems:`, result2.rows.map(r => r.system_id));
    
    // Test 3: With WHERE clause
    console.log('\nTest 3: With WHERE clause (last 7 days)');
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const result3 = await client.execute({
      sql: 'SELECT system_id FROM readings_agg_5m WHERE interval_end >= ? GROUP BY system_id',
      args: [sevenDaysAgo]
    });
    console.log(`Found ${result3.rows.length} systems with recent data:`, result3.rows.map(r => r.system_id));
    
    // Test 4: Count rows per system
    console.log('\nTest 4: Row count per system');
    const result4 = await client.execute('SELECT system_id, COUNT(*) as count FROM readings_agg_5m GROUP BY system_id');
    result4.rows.forEach(row => {
      console.log(`System ${row.system_id}: ${row.count} rows`);
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
  
  process.exit(0);
}

main().catch(console.error);