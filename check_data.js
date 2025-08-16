const { createClient } = require('@libsql/client');

const client = createClient({
  url: 'libsql://liveone-prod-simonhac.aws-ap-south-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function checkData() {
  try {
    // Check latest readings
    const result = await client.execute(`
      SELECT COUNT(*) as count, 
             MAX(inverter_time) as latest,
             MIN(inverter_time) as earliest
      FROM readings
    `);
    
    console.log('Database statistics:');
    console.log('Total readings:', result.rows[0].count);
    console.log('Latest reading:', result.rows[0].latest);
    console.log('Earliest reading:', result.rows[0].earliest);
    
    // Check recent readings
    const recent = await client.execute(`
      SELECT inverter_time, solar_power, battery_soc
      FROM readings
      ORDER BY inverter_time DESC
      LIMIT 5
    `);
    
    console.log('\nLast 5 readings:');
    recent.rows.forEach(row => {
      console.log(`${row.inverter_time}: Solar=${row.solar_power}W, SOC=${row.battery_soc}%`);
    });
    
    // Check time since last reading
    if (result.rows[0].latest) {
      const lastReading = new Date(result.rows[0].latest * 1000); // Convert seconds to milliseconds
      const now = new Date();
      const minutesAgo = Math.floor((now - lastReading) / 60000);
      console.log(`\nLast reading was ${minutesAgo} minutes ago (${lastReading.toISOString()})`);
      
      if (minutesAgo < 2) {
        console.log('✅ Cron job is working! Data is being collected.');
      } else if (minutesAgo < 10) {
        console.log('⚠️ Data might be delayed. Check Vercel logs.');
      } else {
        console.log('❌ No recent data. Cron job may not be running.');
      }
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

checkData();
