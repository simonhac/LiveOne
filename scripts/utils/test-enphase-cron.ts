#!/usr/bin/env tsx

import { shouldPollEnphaseNow, isEnphasePollingMinute } from '@/lib/enphase/enphase-cron';

async function testEnphaseCron() {
  console.log('Testing Enphase cron module...\n');
  
  // Test system with owner
  const testSystem = {
    id: 3,
    vendorSiteId: '364880',
    ownerClerkUserId: 'user_31xhdEB9tgNk4sWNyFVg6EEpXq7',
    timezoneOffsetMin: 600, // Melbourne UTC+10
    location: { lat: -37.8136, lon: 144.9631 }
  };
  
  // Test 1: Never polled before
  console.log('Test 1: Never polled before');
  const shouldPoll1 = shouldPollEnphaseNow(testSystem, null);
  console.log(`Should poll: ${shouldPoll1} (expected: true)\n`);
  
  // Test 2: Polled 10 minutes ago
  console.log('Test 2: Polled 10 minutes ago');
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  const shouldPoll2 = shouldPollEnphaseNow(testSystem, tenMinAgo);
  console.log(`Should poll: ${shouldPoll2} (expected: false)\n`);
  
  // Test 3: Polled 35 minutes ago at noon (should poll again)
  console.log('Test 3: Polled 35 minutes ago during active hours');
  const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000);
  const noonTime = new Date();
  noonTime.setHours(12, 0, 0, 0);
  const shouldPoll3 = shouldPollEnphaseNow(testSystem, thirtyFiveMinAgo, noonTime);
  console.log(`Should poll: ${shouldPoll3}\n`);
  
  // Test 4: Check polling minute
  console.log('Test 4: Polling minute check');
  const isPollingMin = isEnphasePollingMinute();
  const currentMin = new Date().getMinutes();
  console.log(`Current minute: ${currentMin}`);
  console.log(`Is polling minute: ${isPollingMin} (expected: ${currentMin === 0 || currentMin === 30})\n`);
  
  console.log('✅ All tests completed!');
}

testEnphaseCron();
