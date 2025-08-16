#!/usr/bin/env tsx

/**
 * Test script to fetch data from select.live and dump to console
 * Run with: npm run fetch-data
 */

import { SelectronicFetchClient } from '../lib/selectronic-fetch-client';
import { SELECTLIVE_CONFIG } from '../config';

async function main() {
  console.log('='.repeat(60));
  console.log('LiveOne - Selectronic Data Fetcher');
  console.log('='.repeat(60));
  console.log();

  // Create client
  const client = new SelectronicFetchClient({
    email: SELECTLIVE_CONFIG.username,
    password: SELECTLIVE_CONFIG.password,
    systemNumber: SELECTLIVE_CONFIG.systemNumber,
  });

  console.log('Configuration:');
  console.log(`  Email: ${SELECTLIVE_CONFIG.username}`);
  console.log(`  System Number: ${SELECTLIVE_CONFIG.systemNumber}`);
  console.log();

  try {
    // Authenticate
    console.log('Authenticating...');
    const authSuccess = await client.authenticate();
    
    if (!authSuccess) {
      console.error('❌ Authentication failed');
      console.error('   Please check credentials in USER_SECRETS.ts');
      process.exit(1);
    }
    console.log('✅ Authentication successful');
    console.log();

    // Fetch system info
    console.log('Fetching system info...');
    const systemInfo = await client.fetchSystemInfo();
    
    if (systemInfo && Object.keys(systemInfo).length > 0) {
      console.log('✅ System info fetched successfully');
      console.log();
      console.log('System Information:');
      if (systemInfo.model) console.log(`  Model: ${systemInfo.model}`);
      if (systemInfo.serial) console.log(`  Serial: ${systemInfo.serial}`);
      if (systemInfo.ratings) console.log(`  Ratings: ${systemInfo.ratings}`);
      if (systemInfo.solarSize) console.log(`  Solar Size: ${systemInfo.solarSize}`);
      if (systemInfo.batterySize) console.log(`  Battery Size: ${systemInfo.batterySize}`);
    }

    // Fetch data
    console.log();
    console.log('Fetching inverter data...');
    const response = await client.fetchData();

    if (response.success && response.data) {
      console.log('✅ Data fetched successfully');
      console.log();
      console.log('='.repeat(60));
      console.log('INVERTER DATA');
      console.log('='.repeat(60));
      
      const data = response.data;
      
      // Power Flow
      console.log();
      console.log('Power Flow:');
      console.log(`  Solar Generation: ${data.solarPower.toFixed(0)} W`);
      console.log(`  Load Consumption: ${data.loadPower.toFixed(0)} W`);
      console.log(`  Grid Power: ${data.gridPower > 0 ? '+' : ''}${data.gridPower.toFixed(0)} W ${data.gridPower > 0 ? '(importing)' : data.gridPower < 0 ? '(exporting)' : ''}`);
      console.log(`  Battery Power: ${data.batteryPower > 0 ? '+' : ''}${data.batteryPower.toFixed(0)} W ${data.batteryPower > 0 ? '(charging)' : data.batteryPower < 0 ? '(discharging)' : ''}`);
      
      // Battery Status
      console.log();
      console.log('Battery Status:');
      console.log(`  State of Charge: ${data.batterySOC.toFixed(1)}%`);
      
      // Timestamp
      console.log();
      console.log('Data Timestamp:');
      console.log(`  ${data.timestamp.toLocaleString()}`);
      
      // Raw data (if enabled)
      if (data.raw && process.env.DEBUG) {
        console.log();
        console.log('='.repeat(60));
        console.log('RAW API RESPONSE');
        console.log('='.repeat(60));
        console.log(JSON.stringify(data.raw, null, 2));
      }
      
    } else {
      console.error('❌ Failed to fetch data');
      console.error(`   Error: ${response.error}`);
      process.exit(1);
    }

    console.log();
    console.log('='.repeat(60));

  } catch (error) {
    console.error();
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  }
}

// Run the script
main().catch(console.error);