// Run this in your browser console while logged in as admin at http://localhost:3000

async function testDailyEndpoint() {
  console.log('Testing /api/cron/daily endpoint...');
  
  try {
    const response = await fetch('/api/cron/daily', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})  // Empty body for basic test
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log('✅ Success:', data);
    } else {
      console.error('❌ Error:', response.status, data);
    }
    
    return data;
  } catch (error) {
    console.error('❌ Failed:', error);
    throw error;
  }
}

// Test with specific action
async function testDailyWithAction(action) {
  console.log(`Testing /api/cron/daily with action: ${action}`);
  
  try {
    const response = await fetch('/api/cron/daily', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log('✅ Success:', data);
    } else {
      console.error('❌ Error:', response.status, data);
    }
    
    return data;
  } catch (error) {
    console.error('❌ Failed:', error);
    throw error;
  }
}

console.log('Functions loaded. Run:');
console.log('  testDailyEndpoint()        - Test basic aggregation');
console.log('  testDailyWithAction("catchup")  - Catch up missing days');
console.log('  testDailyWithAction("clear")    - Clear and regenerate all');