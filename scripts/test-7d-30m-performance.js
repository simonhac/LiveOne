#!/usr/bin/env node

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'password';
const BASE_URL = 'http://localhost:3000';

async function testAPI(endpoint, params, iterations = 10) {
  const url = `${BASE_URL}${endpoint}?${params}`;
  const times = [];
  
  console.log(`Testing ${endpoint}`);
  console.log(`URL: ${url}`);
  console.log('---');
  
  // Warm-up request
  await fetch(url, {
    headers: { 'Cookie': `auth-token=${AUTH_TOKEN}` }
  });
  
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    try {
      const response = await fetch(url, {
        headers: {
          'Cookie': `auth-token=${AUTH_TOKEN}`
        }
      });
      
      if (!response.ok) {
        console.error(`  Iteration ${i + 1}: Error ${response.status}`);
        const errorData = await response.json();
        console.error(`  Error details:`, errorData.error);
        continue;
      }
      
      const data = await response.json();
      const elapsed = Date.now() - start;
      times.push(elapsed);
      
      // Verify data on first iteration
      if (i === 0) {
        console.log(`Version: ${data.version}`);
        console.log(`Data series: ${data.data?.length || 0}`);
        if (data.data?.[0]?.history?.data) {
          console.log(`Data points: ${data.data[0].history.data.length}`);
          console.log(`Interval: ${data.data[0].history.interval}`);
        }
        console.log('---');
      }
      
      process.stdout.write(`${elapsed}ms `);
      if ((i + 1) % 5 === 0) process.stdout.write('\n');
    } catch (error) {
      console.error(`\n  Iteration ${i + 1}: Error -`, error.message);
    }
  }
  
  console.log('\n');
  
  if (times.length > 0) {
    // Remove outliers (first run often slower due to caching)
    const sortedTimes = [...times].sort((a, b) => a - b);
    const trimmedTimes = sortedTimes.slice(1, -1); // Remove highest and lowest
    
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const trimmedAvg = trimmedTimes.length > 0 
      ? trimmedTimes.reduce((a, b) => a + b, 0) / trimmedTimes.length 
      : avg;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const median = sortedTimes[Math.floor(sortedTimes.length / 2)];
    
    console.log(`Statistics:`);
    console.log(`  Average: ${avg.toFixed(1)}ms`);
    console.log(`  Trimmed avg: ${trimmedAvg.toFixed(1)}ms (excluding outliers)`);
    console.log(`  Median: ${median}ms`);
    console.log(`  Min: ${min}ms`);
    console.log(`  Max: ${max}ms`);
    return { avg, trimmedAvg, median, min, max };
  }
  
  return null;
}

async function main() {
  console.log('==============================================');
  console.log('Performance Test: 7 Days @ 30-minute intervals');
  console.log('==============================================\n');
  
  const params = 'interval=30m&last=7d';
  
  // Test regular API
  console.log('REGULAR HISTORY API (/api/history)');
  console.log('=====================================');
  const regularStats = await testAPI('/api/history', params, 20);
  
  console.log('\n');
  
  // Test fast API
  console.log('FAST HISTORY API (/api/history-fast)');
  console.log('=====================================');
  const fastStats = await testAPI('/api/history-fast', params, 20);
  
  // Compare results
  if (regularStats && fastStats) {
    console.log('\n==============================================');
    console.log('COMPARISON RESULTS');
    console.log('==============================================');
    
    const speedup = regularStats.avg / fastStats.avg;
    const trimmedSpeedup = regularStats.trimmedAvg / fastStats.trimmedAvg;
    const medianSpeedup = regularStats.median / fastStats.median;
    
    console.log(`\n🚀 Performance Improvement:`);
    console.log(`   Average speedup: ${speedup.toFixed(2)}x faster`);
    console.log(`   Trimmed speedup: ${trimmedSpeedup.toFixed(2)}x faster (more accurate)`);
    console.log(`   Median speedup: ${medianSpeedup.toFixed(2)}x faster`);
    console.log(`\n💾 Time saved per request:`);
    console.log(`   Average: ${(regularStats.avg - fastStats.avg).toFixed(1)}ms`);
    console.log(`   Median: ${(regularStats.median - fastStats.median).toFixed(1)}ms`);
    
    if (fastStats.avg < 10) {
      console.log(`\n✅ Fast API achieving sub-10ms response times!`);
    }
  } else if (fastStats && !regularStats) {
    console.log('\n⚠️  Regular API failed, but fast API works!');
    console.log(`Fast API average: ${fastStats.avg.toFixed(1)}ms`);
  }
  
  console.log('\n==============================================');
}

main().catch(console.error);