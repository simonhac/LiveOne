#!/usr/bin/env node

const AUTH_TOKEN = 'zefmud-2Qudca-fexbop';
const BASE_URL = 'http://localhost:3000';

async function testAPI(endpoint, params, iterations = 10) {
  const url = `${BASE_URL}${endpoint}?${params}`;
  const times = [];
  
  console.log(`\nTesting ${endpoint} with params: ${params}`);
  console.log('Running', iterations, 'iterations...');
  
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
        continue;
      }
      
      const data = await response.json();
      const elapsed = Date.now() - start;
      times.push(elapsed);
      
      // Verify version and data structure
      if (i === 0) {
        console.log(`  Version: ${data.version}`);
        console.log(`  Data series count: ${data.data?.length || 0}`);
        if (data.data?.[0]?.history?.data) {
          console.log(`  Data points: ${data.data[0].history.data.length}`);
        }
      }
      
      console.log(`  Iteration ${i + 1}: ${elapsed}ms`);
    } catch (error) {
      console.error(`  Iteration ${i + 1}: Error -`, error.message);
    }
  }
  
  if (times.length > 0) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(`\nResults for ${endpoint}:`);
    console.log(`  Average: ${avg.toFixed(1)}ms`);
    console.log(`  Min: ${min}ms`);
    console.log(`  Max: ${max}ms`);
    return avg;
  }
  
  return null;
}

async function main() {
  console.log('=== API Performance Comparison ===');
  console.log('Testing both regular and fast history APIs...');
  
  // Test configurations
  const tests = [
    { name: '24 hours @ 5m', params: 'interval=5m&last=24h' },
    { name: '7 days @ 5m', params: 'interval=5m&last=7d' },
    { name: '7 days @ 30m', params: 'interval=30m&last=7d' },
    { name: '30 days @ 30m', params: 'interval=30m&last=30d' },
  ];
  
  for (const test of tests) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Test: ${test.name}`);
    console.log('='.repeat(50));
    
    const regularTime = await testAPI('/api/history', test.params, 10);
    const fastTime = await testAPI('/api/history-fast', test.params, 10);
    
    if (regularTime && fastTime) {
      const speedup = regularTime / fastTime;
      console.log(`\n🚀 Speedup: ${speedup.toFixed(2)}x faster`);
      console.log(`   Time saved: ${(regularTime - fastTime).toFixed(1)}ms per request`);
    }
  }
  
  console.log('\n=== Test Complete ===');
}

main().catch(console.error);