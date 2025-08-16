#!/usr/bin/env tsx

/**
 * Show full output from successful authentication and data fetch
 */

import { SelectronicFetchClient } from '../lib/selectronic-fetch-client';
import { USER_SECRETS } from '../USER_SECRETS';

async function main() {
  console.log('='.repeat(60));
  console.log('Successful Authentication & Data Fetch');
  console.log('='.repeat(60));
  console.log();

  const client = new SelectronicFetchClient({
    email: USER_SECRETS.email,
    password: USER_SECRETS.password,
    systemNumber: USER_SECRETS.systemNumber,
  });

  // Step 1: Authenticate
  console.log('STEP 1: AUTHENTICATION');
  console.log('-'.repeat(60));
  console.log(`Email: ${USER_SECRETS.email}`);
  console.log(`System Number: ${USER_SECRETS.systemNumber}`);
  console.log();

  const authResult = await client.authenticate();
  
  if (authResult) {
    console.log('✅ Authentication successful!\n');
  } else {
    console.log('❌ Authentication failed\n');
    process.exit(1);
  }

  // Step 2: Fetch Data
  console.log('STEP 2: FETCH DATA');
  console.log('-'.repeat(60));
  
  // Check if we're in magic window
  const minute = new Date().getMinutes();
  if (minute >= 48 && minute <= 52) {
    console.log('⚠️  Currently in magic window (48-52 minutes past hour)');
    console.log('   Normally data fetch would be skipped, but forcing for demo...\n');
    // Temporarily bypass for demonstration
  }

  const dataResult = await client.fetchData();
  
  if (dataResult.success && dataResult.data) {
    console.log('✅ Data fetch successful!\n');
    
    console.log('INVERTER DATA:');
    console.log('-'.repeat(60));
    const data = dataResult.data;
    
    console.log('Power Flow:');
    console.log(`  Solar Generation:  ${data.solarPower.toFixed(1)} W`);
    console.log(`  Load Consumption:  ${data.loadPower.toFixed(1)} W`);
    console.log(`  Battery Power:     ${data.batteryPower.toFixed(1)} W ${data.batteryPower > 0 ? '(charging)' : data.batteryPower < 0 ? '(discharging)' : ''}`);
    console.log(`  Grid Power:        ${data.gridPower.toFixed(1)} W ${data.gridPower > 0 ? '(importing)' : data.gridPower < 0 ? '(exporting)' : ''}`);
    
    console.log('\nBattery Status:');
    console.log(`  State of Charge:   ${data.batterySOC.toFixed(1)}%`);
    console.log(`  Battery Voltage:   ${data.batteryVoltage.toFixed(1)} V`);
    
    console.log('\nSystem Status:');
    console.log(`  Inverter Mode:     ${data.inverterMode}`);
    console.log(`  Inverter Temp:     ${data.inverterTemperature.toFixed(1)}°C`);
    console.log(`  Grid Voltage:      ${data.gridVoltage.toFixed(1)} V`);
    console.log(`  Grid Frequency:    ${data.gridFrequency.toFixed(2)} Hz`);
    
    console.log('\nSolar Array:');
    console.log(`  Solar Voltage:     ${data.solarVoltage.toFixed(1)} V`);
    console.log(`  Solar Current:     ${data.solarCurrent.toFixed(1)} A`);
    
    console.log('\nTimestamp:', data.timestamp.toLocaleString());
    
    if (data.raw) {
      console.log('\n' + '='.repeat(60));
      console.log('RAW JSON RESPONSE FROM SELECT.LIVE:');
      console.log('='.repeat(60));
      console.log(JSON.stringify(data.raw, null, 2));
    }
  } else {
    console.log('❌ Data fetch failed');
    console.log('Error:', dataResult.error);
  }
}

main().catch(console.error);