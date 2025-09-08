#!/usr/bin/env npx tsx

import { shouldPollEnphaseNow } from '@/lib/enphase/enphase-cron';
import * as SunCalc from 'suncalc';

// Test the polling schedule logic
function testSchedule() {
  const system = {
    id: 3,
    vendorSiteId: '364880',
    ownerClerkUserId: 'user_123',
    timezoneOffsetMin: 600, // Melbourne UTC+10
    location: { lat: -37.8136, lon: 144.9631 }
  };
  
  // Get sun times for today
  const now = new Date();
  const sunTimes = SunCalc.getTimes(now, -37.8136, 144.9631);
  
  console.log('Sun times for Melbourne today (UTC):');
  console.log('Dawn:', sunTimes.dawn.toISOString());
  console.log('Sunrise:', sunTimes.sunrise.toISOString());
  console.log('Sunset:', sunTimes.sunset.toISOString());
  console.log('Dusk:', sunTimes.dusk.toISOString());
  
  console.log('\nSun times for Melbourne today (Local):');
  const localOffset = 600 * 60 * 1000;
  console.log('Dawn:', new Date(sunTimes.dawn.getTime() + localOffset).toLocaleTimeString());
  console.log('Sunrise:', new Date(sunTimes.sunrise.getTime() + localOffset).toLocaleTimeString());
  console.log('Sunset:', new Date(sunTimes.sunset.getTime() + localOffset).toLocaleTimeString());
  console.log('Dusk:', new Date(sunTimes.dusk.getTime() + localOffset).toLocaleTimeString());
  
  console.log('\nTesting key times:');
  
  // Test key times
  const testCases = [
    { time: '06:00', desc: 'Early morning' },
    { time: '06:30', desc: 'Around dawn' },
    { time: '09:00', desc: 'Morning' },
    { time: '12:00', desc: 'Noon' },
    { time: '15:00', desc: 'Afternoon' },
    { time: '18:00', desc: 'Around sunset' },
    { time: '18:30', desc: 'After sunset' },
    { time: '19:30', desc: '1hr after sunset' },
    { time: '00:00', desc: 'Midnight' },
  ];
  
  for (const test of testCases) {
    const [hour, minute] = test.time.split(':').map(Number);
    const testDate = new Date();
    testDate.setHours(hour - 10, minute, 0, 0); // Adjust for UTC+10
    
    // Test with old poll (35 minutes ago)
    const lastPoll = new Date(testDate.getTime() - 35 * 60000);
    const shouldPoll = shouldPollEnphaseNow(system, lastPoll, testDate);
    
    console.log(`${test.time} - ${test.desc}: ${shouldPoll ? '✓ POLL' : '✗ SKIP'}`);
  }
}

testSchedule();