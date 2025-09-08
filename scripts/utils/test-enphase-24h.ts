#!/usr/bin/env tsx

import { shouldPollEnphaseNow } from '@/lib/enphase/enphase-cron';
import * as fs from 'fs';
import * as path from 'path';

async function test24HourPolling() {
  console.log('Simulating 24-hour Enphase polling schedule...\n');
  
  // Test system with owner (Melbourne location)
  const testSystem = {
    id: 3,
    vendorSiteId: '364880',
    ownerClerkUserId: 'user_31xhdEB9tgNk4sWNyFVg6EEpXq7',
    timezoneOffsetMin: 600, // Melbourne UTC+10
    location: { lat: -37.8136, lon: 144.9631 }
  };
  
  // Start at midnight
  const baseTime = new Date();
  baseTime.setHours(0, 0, 0, 0);
  
  const logFile = path.join(process.cwd(), 'enphase-24h-poll-log.txt');
  const logStream = fs.createWriteStream(logFile);
  
  console.log(`Writing log to: ${logFile}\n`);
  
  // Header
  logStream.write('24-Hour Enphase Polling Simulation\n');
  logStream.write(`System: ${testSystem.id} (${testSystem.vendorSiteId})\n`);
  logStream.write(`Location: Melbourne (${testSystem.location.lat}, ${testSystem.location.lon})\n`);
  logStream.write(`Timezone Offset: ${testSystem.timezoneOffsetMin} minutes (UTC+10)\n`);
  logStream.write(`Base Date: ${baseTime.toDateString()}\n`);
  logStream.write('='.repeat(100) + '\n\n');
  
  // Track polling stats
  let totalPolls = 0;
  let lastPollTime: Date | null = null;
  const pollTimes: string[] = [];
  
  // Simulate every minute for 24 hours
  for (let minutes = 0; minutes < 24 * 60; minutes++) {
    const currentTime = new Date(baseTime.getTime() + minutes * 60 * 1000);
    const timeStr = currentTime.toTimeString().slice(0, 5);
    
    // Capture console output
    const originalLog = console.log;
    let capturedOutput = '';
    console.log = (msg: string) => {
      capturedOutput += msg + '\n';
    };
    
    // Check if should poll
    const shouldPoll = shouldPollEnphaseNow(testSystem, lastPollTime, currentTime);
    
    // Restore console.log
    console.log = originalLog;
    
    // Log the decision
    if (shouldPoll || capturedOutput.trim()) {
      logStream.write(`${timeStr} - `);
      
      if (shouldPoll) {
        logStream.write('✅ POLL - ');
        totalPolls++;
        lastPollTime = currentTime;
        pollTimes.push(timeStr);
      } else {
        logStream.write('⏭️ SKIP - ');
      }
      
      // Extract the reason from captured output
      const reason = capturedOutput
        .replace(/\[ENPHASE-CRON\] System \d+: /, '')
        .trim()
        .split('\n')[0];
      
      logStream.write(reason + '\n');
    }
  }
  
  // Summary
  logStream.write('\n' + '='.repeat(100) + '\n');
  logStream.write('SUMMARY\n');
  logStream.write('='.repeat(100) + '\n');
  logStream.write(`Total polls in 24 hours: ${totalPolls}\n`);
  logStream.write(`Poll times: ${pollTimes.join(', ')}\n`);
  
  // Calculate intervals
  const intervals: number[] = [];
  for (let i = 1; i < pollTimes.length; i++) {
    const prev = pollTimes[i - 1].split(':').map(Number);
    const curr = pollTimes[i].split(':').map(Number);
    const prevMinutes = prev[0] * 60 + prev[1];
    const currMinutes = curr[0] * 60 + curr[1];
    intervals.push(currMinutes - prevMinutes);
  }
  
  if (intervals.length > 0) {
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    logStream.write(`Average interval: ${avgInterval.toFixed(1)} minutes\n`);
    logStream.write(`Min interval: ${Math.min(...intervals)} minutes\n`);
    logStream.write(`Max interval: ${Math.max(...intervals)} minutes\n`);
  }
  
  logStream.end();
  
  console.log('✅ Simulation complete!');
  console.log(`📄 Log written to: ${logFile}`);
  console.log(`📊 Total polls: ${totalPolls}`);
  console.log(`⏰ Poll times: ${pollTimes.slice(0, 5).join(', ')}${pollTimes.length > 5 ? '...' : ''}`);
}

test24HourPolling().catch(console.error);