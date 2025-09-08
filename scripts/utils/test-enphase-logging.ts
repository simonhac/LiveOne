#!/usr/bin/env tsx

import { shouldPollEnphaseNow } from '@/lib/enphase/enphase-cron';

async function testEnphaseLogging() {
  console.log('Testing Enphase cron logging...\n');
  
  // Test system with owner
  const testSystem = {
    id: 3,
    vendorSiteId: '364880',
    ownerClerkUserId: 'user_31xhdEB9tgNk4sWNyFVg6EEpXq7',
    timezoneOffsetMin: 600, // Melbourne UTC+10
    location: { lat: -37.8136, lon: 144.9631 }
  };
  
  // Test at different times of day
  const testTimes = [
    { hour: 5, minute: 30, desc: 'Early morning (before dawn)' },
    { hour: 8, minute: 15, desc: 'Morning (not polling minute)' },
    { hour: 12, minute: 0, desc: 'Noon (polling minute)' },
    { hour: 12, minute: 5, desc: 'Just after noon (recently polled)' },
    { hour: 20, minute: 30, desc: 'Evening (after dusk)' },
    { hour: 0, minute: 0, desc: 'Midnight' }
  ];
  
  for (const test of testTimes) {
    console.log(`\n${test.desc} - ${test.hour}:${String(test.minute).padStart(2, '0')}`);
    console.log('─'.repeat(50));
    
    // Create test time
    const testTime = new Date();
    testTime.setHours(test.hour, test.minute, 0, 0);
    
    // Test with last poll 35 minutes ago
    const lastPoll = new Date(testTime.getTime() - 35 * 60 * 1000);
    
    const shouldPoll = shouldPollEnphaseNow(testSystem, lastPoll, testTime);
    console.log(`Result: ${shouldPoll ? '✅ POLL' : '⏭️ SKIP'}`);
  }
  
  console.log('\n✅ Logging test completed!');
}

testEnphaseLogging();
