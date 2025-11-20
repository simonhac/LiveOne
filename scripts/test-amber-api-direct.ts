import { config } from "dotenv";
config({ path: ".env.local" });

async function testAmberAPI() {
  // Get credentials from environment
  const apiKey = process.env.AMBER_API_KEY;
  const siteId = process.env.AMBER_SITE_ID || "01E8RD8Q0GABW66Z0WP8RDT6X1";

  if (!apiKey) {
    console.error("❌ AMBER_API_KEY not set in environment");
    console.log("\nPlease add to .env.local:");
    console.log("AMBER_API_KEY=your_api_key_here");
    console.log("AMBER_SITE_ID=your_site_id_here");
    process.exit(1);
  }

  console.log("Testing Amber API with credentials from environment");
  console.log(`API Key: ${apiKey.substring(0, 20)}...`);
  console.log(`Site ID: ${siteId}`);
  console.log();

  // Test 1: Get sites
  console.log("Test 1: GET /sites");
  try {
    const response = await fetch("https://api.amber.com.au/v1/sites", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    console.log(`Status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const text = await response.text();
      console.error("Error response:", text);
      process.exit(1);
    }

    const sites = await response.json();
    console.log(`✅ Success - found ${sites.length} site(s)`);
    sites.forEach((s: any) =>
      console.log(`   - ${s.id}: ${s.nmi || "No NMI"}`),
    );
    console.log();
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }

  // Test 2: Get usage for yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  console.log(`Test 2: GET /sites/${siteId}/usage for ${dateStr}`);
  try {
    const url = `https://api.amber.com.au/v1/sites/${siteId}/usage?startDate=${dateStr}&endDate=${dateStr}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    console.log(`Status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const text = await response.text();
      console.error("Error response:", text);

      if (response.status === 404) {
        console.log("\n💡 Possible reasons for 404:");
        console.log("  - Site ID doesn't exist");
        console.log("  - No data available for this date");
        console.log("  - API key doesn't have access to this site");
      }
      process.exit(1);
    }

    const data = await response.json();
    console.log(`✅ Success - found ${data.length} usage record(s)`);
    if (data.length > 0) {
      console.log("First record:", JSON.stringify(data[0], null, 2));
    }
    console.log();
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }

  console.log("✅ All tests passed!");
}

testAmberAPI().catch(console.error);
