#!/usr/bin/env npx tsx
/**
 * Fetch last 7 days of Enphase data for a system
 * Usage: ./scripts/utils/fetch-enphase-week.ts --systemId=<id> --environment=<dev|prod>
 * Examples: 
 *   ./scripts/utils/fetch-enphase-week.ts --systemId=3 --environment=dev
 *   ./scripts/utils/fetch-enphase-week.ts --systemId=3 --environment=prod
 *   ./scripts/utils/fetch-enphase-week.ts --systemId=5 --environment=prod
 */

import { parseDate } from '@internationalized/date';

async function fetchEnphaseWeek() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const params: Record<string, string> = {};
  
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.+)$/);
    if (match) {
      params[match[1]] = match[2];
    }
  }
  
  // Check required parameters
  if (!params.systemId || !params.environment) {
    console.error('Error: Missing required parameters');
    console.error('Usage: ./scripts/utils/fetch-enphase-week.ts --systemId=<id> --environment=<dev|prod>');
    console.error('Example: ./scripts/utils/fetch-enphase-week.ts --systemId=3 --environment=dev');
    process.exit(1);
  }
  
  const systemId = params.systemId;
  const environment = params.environment;
  
  // Validate environment
  if (environment !== 'dev' && environment !== 'prod') {
    console.error('Error: environment must be "dev" or "prod"');
    process.exit(1);
  }
  
  const baseUrl = environment === 'prod' ? 'https://liveone.vercel.app' : 'http://localhost:3000';
  
  console.log(`Fetching last 7 days of data for system ${systemId} (${environment})...`);
  console.log(`Using API: ${baseUrl}`);
  console.log('');
  
  // Get dates for last 7 days
  const today = new Date();
  const dates: string[] = [];
  
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    dates.push(dateStr);
  }
  
  // Fetch data for each date
  let totalRecords = 0;
  let successCount = 0;
  let failureCount = 0;
  
  for (const dateStr of dates) {
    console.log(`Fetching ${dateStr}...`);
    
    try {
      const url = `${baseUrl}/api/cron/minutely?systemId=${systemId}&force=true&date=${dateStr}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.results?.[0]) {
        const result = data.results[0];
        if (result.status === 'polled') {
          const recordsUpserted = result.recordsUpserted || 0;
          totalRecords += recordsUpserted;
          successCount++;
          console.log(`  ✓ Success: ${recordsUpserted} records upserted (${result.durationMs}ms)`);
        } else if (result.status === 'skipped') {
          console.log(`  ⏭ Skipped: ${result.skipReason}`);
        } else {
          failureCount++;
          console.log(`  ✗ Error: ${result.error}`);
        }
      } else {
        failureCount++;
        console.log(`  ✗ Failed: ${data.error || 'Unknown error'}`);
      }
      
      // Small delay between requests to be nice to the server
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      failureCount++;
      console.log(`  ✗ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  console.log('');
  console.log('=== Summary ===');
  console.log(`Dates processed: ${dates.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${failureCount}`);
  console.log(`Total records upserted: ${totalRecords}`);
  console.log(`Average per day: ${Math.round(totalRecords / (successCount || 1))} records`);
}

fetchEnphaseWeek().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});