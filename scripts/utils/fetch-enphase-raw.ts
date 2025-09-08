#!/usr/bin/env npx tsx
/**
 * Fetch raw Enphase API response and save to file
 * Usage: ./scripts/fetch-enphase-raw.ts [systemId] [date]
 * Example: ./scripts/fetch-enphase-raw.ts 3 2025-09-04
 */

import { db } from '@/lib/db';
import { systems, enphaseCredentials } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { parseDate } from '@internationalized/date';
import { calendarDateToUnixRange } from '@/lib/date-utils';
import { writeFileSync } from 'fs';
import { join } from 'path';

async function fetchRawEnphaseData() {
  const systemId = parseInt(process.argv[2] || '3');
  const dateStr = process.argv[3] || new Date().toISOString().split('T')[0]; // Default to today
  
  console.log(`Fetching raw Enphase data for system ${systemId} on ${dateStr}`);
  
  // Get system details
  const [system] = await db
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);
    
  if (!system) {
    console.error(`System ${systemId} not found`);
    process.exit(1);
  }
  
  if (system.vendorType !== 'enphase') {
    console.error(`System ${systemId} is not an Enphase system (type: ${system.vendorType})`);
    process.exit(1);
  }
  
  if (!system.ownerClerkUserId) {
    console.error(`System ${systemId} has no owner`);
    process.exit(1);
  }
  
  console.log(`System: ${system.displayName} (${system.vendorSiteId})`);
  console.log(`Owner: ${system.ownerClerkUserId}`);
  
  // Parse date and convert to Unix range
  const date = parseDate(dateStr);
  const [startUnix, endUnix] = calendarDateToUnixRange(date, system.timezoneOffsetMin);
  
  console.log(`Date range: ${new Date(startUnix * 1000).toISOString()} to ${new Date(endUnix * 1000).toISOString()}`);
  
  // Check if we're in development or production
  const isDev = process.env.NODE_ENV === 'development' || !process.env.TURSO_DATABASE_URL;
  
  if (isDev) {
    console.log('Running in development mode - will proxy through production');
    
    // In development, use the production proxy endpoint
    const baseUrl = 'https://liveone.vercel.app';
    
    // Build the Enphase API URL path with parameters
    const apiParams = new URLSearchParams({
      start_at: startUnix.toString(),
      end_at: endUnix.toString(),
      granularity: 'day'
    });
    const apiPath = `/api/v4/systems/{systemId}/telemetry/production_micro?${apiParams}`;
    
    // Build proxy URL
    const proxyParams = new URLSearchParams({
      systemId: systemId.toString(),
      url: apiPath
    });
    
    const url = `${baseUrl}/api/enphase-proxy?${proxyParams}`;
    console.log(`Fetching from proxy: ${url}`);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`Proxy error: ${response.status} - ${error}`);
      process.exit(1);
    }
    
    const data = await response.json();
    
    // Save to file
    const fileName = `enphase-raw-${systemId}-${dateStr}.json`;
    const filePath = join(process.cwd(), fileName);
    
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`\nRaw data saved to: ${fileName}`);
    console.log(`Total intervals: ${data.intervals?.length || 0}`);
    
    // Show summary
    if (data.intervals && data.intervals.length > 0) {
      const totalEnergy = data.intervals.reduce((sum: number, i: any) => sum + (i.enwh || 0), 0);
      const maxPower = Math.max(...data.intervals.map((i: any) => i.powr || 0));
      console.log(`\nSummary:`);
      console.log(`- Total energy: ${(totalEnergy / 1000).toFixed(2)} kWh`);
      console.log(`- Peak power: ${maxPower} W`);
      console.log(`- First interval: ${new Date(data.intervals[0].end_at * 1000).toISOString()}`);
      console.log(`- Last interval: ${new Date(data.intervals[data.intervals.length - 1].end_at * 1000).toISOString()}`);
    }
    
  } else {
    console.log('Running in production mode - direct API access');
    
    // Get credentials
    const [credentials] = await db
      .select()
      .from(enphaseCredentials)
      .where(eq(enphaseCredentials.clerkUserId, system.ownerClerkUserId))
      .limit(1);
      
    if (!credentials) {
      console.error(`No Enphase credentials found for user ${system.ownerClerkUserId}`);
      process.exit(1);
    }
    
    // Build URL
    const params = new URLSearchParams({
      start_at: startUnix.toString(),
      end_at: endUnix.toString(),
      granularity: 'day'  // This returns 5-minute data for the full day
    });
    
    const url = `https://api.enphaseenergy.com/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro?${params}`;
    console.log(`Fetching from Enphase API: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${credentials.access_token}`,
        'key': process.env.ENPHASE_API_KEY || ''
      }
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`API error: ${response.status} - ${error}`);
      process.exit(1);
    }
    
    const data = await response.json();
    
    // Save to file
    const fileName = `enphase-raw-${systemId}-${dateStr}.json`;
    const filePath = join(process.cwd(), fileName);
    
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`\nRaw data saved to: ${fileName}`);
    console.log(`Total intervals: ${data.intervals?.length || 0}`);
    
    // Show summary
    if (data.intervals && data.intervals.length > 0) {
      const totalEnergy = data.intervals.reduce((sum: number, i: any) => sum + (i.enwh || 0), 0);
      const maxPower = Math.max(...data.intervals.map((i: any) => i.powr || 0));
      console.log(`\nSummary:`);
      console.log(`- Total energy: ${(totalEnergy / 1000).toFixed(2)} kWh`);
      console.log(`- Peak power: ${maxPower} W`);
      console.log(`- First interval: ${new Date(data.intervals[0].end_at * 1000).toISOString()}`);
      console.log(`- Last interval: ${new Date(data.intervals[data.intervals.length - 1].end_at * 1000).toISOString()}`);
    }
  }
  
  process.exit(0);
}

fetchRawEnphaseData().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});