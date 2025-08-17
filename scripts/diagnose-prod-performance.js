#!/usr/bin/env node

const AUTH_TOKEN = 'password';
const BASE_URL = 'https://liveone.vercel.app';

async function measureLatency() {
  console.log('1. MEASURING NETWORK LATENCY');
  console.log('================================');
  
  // Measure basic ping to Vercel edge
  const pingTimes = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    await fetch(BASE_URL + '/favicon.ico', { method: 'HEAD' });
    pingTimes.push(Date.now() - start);
  }
  console.log(`Network latency to Vercel: ${Math.min(...pingTimes)}ms (minimum of 5 pings)\n`);
}

async function testMinimalAPI() {
  console.log('2. TESTING MINIMAL API ENDPOINT');
  console.log('================================');
  
  // Test a minimal API that doesn't hit the database
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    const res = await fetch(BASE_URL + '/api/status', {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    });
    await res.text();
    times.push(Date.now() - start);
  }
  console.log(`Minimal API (no DB): ${Math.min(...times)}ms\n`);
}

async function testHistoryAPI() {
  console.log('3. TESTING HISTORY API PERFORMANCE');
  console.log('===================================');
  
  const tests = [
    { interval: '5m', last: '1h', desc: '1 hour @ 5m (12 points)' },
    { interval: '5m', last: '6h', desc: '6 hours @ 5m (72 points)' },
    { interval: '5m', last: '24h', desc: '24 hours @ 5m (288 points)' },
    { interval: '30m', last: '24h', desc: '24 hours @ 30m (48 points)' },
    { interval: '30m', last: '7d', desc: '7 days @ 30m (336 points)' },
  ];
  
  for (const test of tests) {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const res = await fetch(
        `${BASE_URL}/api/history?interval=${test.interval}&last=${test.last}`,
        { headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` } }
      );
      const data = await res.json();
      const elapsed = Date.now() - start;
      times.push(elapsed);
      
      if (i === 0 && data.data?.[0]?.history?.data) {
        console.log(`${test.desc}:`);
        console.log(`  Data points returned: ${data.data[0].history.data.length}`);
      }
    }
    console.log(`  Response time: ${Math.min(...times)}ms (best of 3)\n`);
  }
}

async function testDatabaseConnection() {
  console.log('4. DATABASE CONNECTION ANALYSIS');
  console.log('================================');
  
  // Test multiple rapid requests to check connection pooling
  console.log('Testing rapid sequential requests:');
  const seqStart = Date.now();
  for (let i = 0; i < 5; i++) {
    await fetch(BASE_URL + '/api/history?interval=5m&last=1h', {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    });
  }
  const seqTime = Date.now() - seqStart;
  console.log(`  5 sequential requests: ${seqTime}ms total (${(seqTime/5).toFixed(0)}ms avg)`);
  
  console.log('\nTesting parallel requests:');
  const parStart = Date.now();
  await Promise.all([
    fetch(BASE_URL + '/api/history?interval=5m&last=1h', {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    }),
    fetch(BASE_URL + '/api/history?interval=5m&last=1h', {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    }),
    fetch(BASE_URL + '/api/history?interval=5m&last=1h', {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    }),
    fetch(BASE_URL + '/api/history?interval=5m&last=1h', {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    }),
    fetch(BASE_URL + '/api/history?interval=5m&last=1h', {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    }),
  ]);
  const parTime = Date.now() - parStart;
  console.log(`  5 parallel requests: ${parTime}ms total\n`);
}

async function checkColdStart() {
  console.log('5. COLD START ANALYSIS');
  console.log('======================');
  
  // Wait a bit to let function go cold
  console.log('Waiting 30s for function to potentially go cold...');
  await new Promise(r => setTimeout(r, 30000));
  
  const start = Date.now();
  const res = await fetch(BASE_URL + '/api/history?interval=5m&last=1h', {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
  });
  await res.json();
  const coldTime = Date.now() - start;
  
  // Immediate second request (warm)
  const warmStart = Date.now();
  const res2 = await fetch(BASE_URL + '/api/history?interval=5m&last=1h', {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
  });
  await res2.json();
  const warmTime = Date.now() - warmStart;
  
  console.log(`  Potentially cold start: ${coldTime}ms`);
  console.log(`  Warm request: ${warmTime}ms`);
  console.log(`  Difference: ${coldTime - warmTime}ms\n`);
}

async function main() {
  console.log('========================================');
  console.log('PRODUCTION PERFORMANCE DIAGNOSIS');
  console.log('========================================\n');
  
  await measureLatency();
  await testMinimalAPI();
  await testHistoryAPI();
  await testDatabaseConnection();
  await checkColdStart();
  
  console.log('========================================');
  console.log('ANALYSIS COMPLETE');
  console.log('========================================');
  
  console.log('\nPOSSIBLE BOTTLENECKS:');
  console.log('1. Database location - Turso region may be far from Vercel function');
  console.log('2. Database connection overhead - new connection per request');
  console.log('3. Vercel function cold starts');
  console.log('4. Network latency between Vercel and Turso');
}

main().catch(console.error);