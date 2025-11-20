/**
 * Test script to verify Amber credentials and API access
 *
 * Usage:
 *   npx tsx scripts/test-amber-credentials.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSystemCredentials } from "@/lib/secure-credentials";
import type { AmberCredentials } from "@/lib/vendors/amber/types";

async function testCredentials() {
  const systemId = 10001; // Amber Kinkora system
  const userId = "user_31xcrIbiSrjjTIKlXShEPilRow7"; // Simon's Clerk user ID
  const siteId = "01E8RD8Q0GABW66Z0WP8RDT6X1"; // From database

  console.log("=".repeat(60));
  console.log("Testing Amber Credentials");
  console.log("=".repeat(60));
  console.log(
    "DEBUG: CLERK_SECRET_KEY is",
    process.env.CLERK_SECRET_KEY ? "SET" : "NOT SET",
  );
  console.log(`System ID: ${systemId}`);
  console.log(`User ID: ${userId}`);
  console.log(`Site ID: ${siteId}`);
  console.log();

  // 1. Check if credentials exist in Clerk
  console.log("Step 1: Checking Clerk private metadata...");
  const credentials = await getSystemCredentials(userId, systemId);

  if (!credentials) {
    console.error("❌ No credentials found in Clerk for system", systemId);
    console.log("\nCredentials need to be stored. You can do this by:");
    console.log("1. Going to the system setup page");
    console.log("2. Re-entering your Amber API key");
    process.exit(1);
  }

  console.log("✅ Credentials found in Clerk");
  console.log("Credential keys:", Object.keys(credentials));

  const amberCreds = credentials as any as AmberCredentials;

  if (!amberCreds.apiKey) {
    console.error("❌ apiKey missing from credentials");
    process.exit(1);
  }

  console.log(`API Key: ${amberCreds.apiKey.substring(0, 20)}...`);
  console.log(`Site ID: ${amberCreds.siteId || "Not set in credentials"}`);
  console.log();

  // 2. Test API access - Get sites
  console.log("Step 2: Testing /sites endpoint...");
  try {
    const sitesResponse = await fetch("https://api.amber.com.au/v1/sites", {
      headers: {
        Authorization: `Bearer ${amberCreds.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!sitesResponse.ok) {
      const errorText = await sitesResponse.text();
      console.error(
        `❌ /sites failed: ${sitesResponse.status} ${sitesResponse.statusText}`,
      );
      console.error("Response body:", errorText);
      process.exit(1);
    }

    const sites = await sitesResponse.json();
    console.log(`✅ Successfully retrieved ${sites.length} site(s)`);
    console.log();
    console.log("Sites:");
    for (const site of sites) {
      console.log(`  - ${site.id}: ${site.nmi || "No NMI"} (${site.status})`);
    }
    console.log();
  } catch (error) {
    console.error("❌ Error calling /sites:", error);
    process.exit(1);
  }

  // 3. Test API access - Get usage for yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  console.log(`Step 3: Testing /usage endpoint for ${yesterdayStr}...`);
  try {
    const usageUrl = `https://api.amber.com.au/v1/sites/${siteId}/usage?startDate=${yesterdayStr}&endDate=${yesterdayStr}`;
    console.log(`URL: ${usageUrl}`);

    const usageResponse = await fetch(usageUrl, {
      headers: {
        Authorization: `Bearer ${amberCreds.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!usageResponse.ok) {
      const errorText = await usageResponse.text();
      console.error(
        `❌ /usage failed: ${usageResponse.status} ${usageResponse.statusText}`,
      );
      console.error("Response body:", errorText);

      // Check if it's a 404
      if (usageResponse.status === 404) {
        console.log("\n💡 404 Not Found - This could mean:");
        console.log("  1. The site ID is incorrect");
        console.log("  2. No usage data available for this date");
        console.log("  3. The API key doesn't have access to this site");
      }

      process.exit(1);
    }

    const usageData = await usageResponse.json();
    console.log(
      `✅ Successfully retrieved ${usageData.length} usage record(s)`,
    );

    if (usageData.length > 0) {
      console.log("\nFirst record:");
      console.log(JSON.stringify(usageData[0], null, 2));
    }
    console.log();
  } catch (error) {
    console.error("❌ Error calling /usage:", error);
    process.exit(1);
  }

  // 4. Test API access - Get prices
  console.log("Step 4: Testing /prices endpoint...");
  try {
    const pricesUrl = `https://api.amber.com.au/v1/sites/${siteId}/prices`;
    console.log(`URL: ${pricesUrl}`);

    const pricesResponse = await fetch(pricesUrl, {
      headers: {
        Authorization: `Bearer ${amberCreds.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!pricesResponse.ok) {
      const errorText = await pricesResponse.text();
      console.error(
        `❌ /prices failed: ${pricesResponse.status} ${pricesResponse.statusText}`,
      );
      console.error("Response body:", errorText);
      process.exit(1);
    }

    const pricesData = await pricesResponse.json();
    console.log(
      `✅ Successfully retrieved ${pricesData.length} price record(s)`,
    );

    if (pricesData.length > 0) {
      console.log("\nFirst record:");
      console.log(JSON.stringify(pricesData[0], null, 2));
    }
    console.log();
  } catch (error) {
    console.error("❌ Error calling /prices:", error);
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("✅ All tests passed!");
  console.log("=".repeat(60));
}

// Run the test
testCredentials().catch((error) => {
  console.error("\n❌ Test failed with exception:");
  console.error(error);
  process.exit(1);
});
