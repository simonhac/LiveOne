const { createClient } = require('@libsql/client');

const client = createClient({
  url: 'libsql://liveone-prod-simonhac.aws-ap-south-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function checkSystems() {
  try {
    // Check systems
    const result = await client.execute(`
      SELECT * FROM systems
    `);
    
    console.log('Systems in database:', result.rows.length);
    result.rows.forEach(row => {
      console.log(`- System ${row.system_number}: ${row.display_name}, User: ${row.user_id}`);
    });
    
    if (result.rows.length === 0) {
      console.log('\n❌ No systems configured! The cron job has nothing to poll.');
      console.log('You need to add a system first via the admin interface or API.');
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

checkSystems();
