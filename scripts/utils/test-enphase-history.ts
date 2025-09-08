#!/usr/bin/env tsx

import { fetchEnphaseCurrentDay, fetchRecentEnphaseHistory } from '@/lib/enphase/enphase-history';

async function testEnphaseHistory() {
  const systemId = 3; // Jeffery Solar Enphase system
  
  console.log('Testing Enphase history module...\n');
  
  try {
    // Test 1: Dry run of current day fetch
    console.log('Test 1: Fetching current day data (dry run)...');
    const currentDayResult = await fetchEnphaseCurrentDay(systemId, true);
    console.log('Current day result:', {
      intervalCount: currentDayResult.intervalCount,
      gapsFilled: currentDayResult.gapsFilled,
      dryRun: currentDayResult.dryRun
    });
    
    if (currentDayResult.sampleRecord) {
      console.log('Sample record timestamp:', new Date(currentDayResult.sampleRecord.intervalEnd * 1000).toISOString());
    }
    
    // Test 2: Fetch last 2 hours (dry run)
    console.log('\nTest 2: Fetching last 2 hours (dry run)...');
    const recentResult = await fetchRecentEnphaseHistory(systemId, 2, true);
    console.log('Recent history result:', {
      intervalCount: recentResult.intervalCount,
      skippedCount: recentResult.skippedCount,
      dryRun: recentResult.dryRun
    });
    
    console.log('\n✅ All tests passed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testEnphaseHistory();
