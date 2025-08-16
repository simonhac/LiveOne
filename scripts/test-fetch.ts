#!/usr/bin/env tsx

/**
 * Test script using node-fetch client
 */

import { SelectronicFetchClient } from '../lib/selectronic-fetch-client';

async function main() {
  console.log('='.repeat(60));
  console.log('Testing with node-fetch client');
  console.log('='.repeat(60));
  console.log();

  const client = new SelectronicFetchClient();

  // Test authentication
  console.log('Step 1: Authenticate');
  const authResult = await client.authenticate();
  
  if (!authResult) {
    console.error('❌ Authentication failed');
    process.exit(1);
  }
  
  console.log('✅ Authentication successful\n');

  // Test data fetching
  console.log('Step 2: Fetch data');
  const dataResult = await client.fetchData();
  
  if (dataResult.success && dataResult.data) {
    console.log('✅ Data fetched successfully\n');
    
    const data = dataResult.data;
    console.log('Current readings:');
    console.log(`  Solar: ${data.solarPower} W`);
    console.log(`  Load: ${data.loadPower} W`);
    console.log(`  Battery: ${data.batteryPower} W (${data.batterySOC}% SOC)`);
    console.log(`  Grid: ${data.gridPower} W`);
    
    if (data.raw) {
      console.log('\nRaw data:');
      console.log(JSON.stringify(data.raw, null, 2));
    }
  } else {
    console.error('❌ Failed to fetch data:', dataResult.error);
    process.exit(1);
  }
}

main().catch(console.error);