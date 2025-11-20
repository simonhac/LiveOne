/**
 * Test script to call Amber's REST API /prices endpoint
 * Fetches 3 days of price forecasts starting from 2025-11-20
 */

import { config } from "dotenv";
config({ path: ".env.local" });

// Use same credentials as test-amber-sync.ts
const AMBER_API_KEY =
  process.env.AMBER_API_KEY || "psk_a5b4b523ec85b30a203212597a58c3af";
const AMBER_SITE_ID = process.env.AMBER_SITE_ID || "01E8RD8Q0GABW66Z0WP8RDT6X1";

async function fetchAmberPrices() {
  const startDate = "2025-11-20";
  const endDate = "2025-11-23"; // 3 days from start date

  const url = `https://api.amber.com.au/v1/sites/${AMBER_SITE_ID}/prices?startDate=${startDate}&endDate=${endDate}&resolution=30`;

  console.log("Fetching Amber prices...");
  console.log("URL:", url);
  console.log("Start Date:", startDate);
  console.log("End Date:", endDate);
  console.log("");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${AMBER_API_KEY}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    console.error(
      "❌ API request failed:",
      response.status,
      response.statusText,
    );
    const text = await response.text();
    console.error("Response:", text);
    process.exit(1);
  }

  const data = await response.json();

  console.log("✅ Success! Retrieved", data.length, "price records");
  console.log("");

  // Separate by channel type
  const generalRecords = data.filter((r: any) => r.channelType === "general");
  const feedInRecords = data.filter((r: any) => r.channelType === "feedIn");

  console.log(`General (import): ${generalRecords.length} records`);
  console.log(`Feed-in (export): ${feedInRecords.length} records`);
  console.log("");

  // Analyze descriptor values and price ranges for GENERAL channel only
  const descriptorStats = new Map<
    string,
    { count: number; minPrice: number; maxPrice: number; prices: number[] }
  >();

  for (const record of generalRecords) {
    const descriptor = record.descriptor;
    const price = record.perKwh; // Price in cents

    if (!descriptorStats.has(descriptor)) {
      descriptorStats.set(descriptor, {
        count: 0,
        minPrice: Infinity,
        maxPrice: -Infinity,
        prices: [],
      });
    }

    const stats = descriptorStats.get(descriptor)!;
    stats.count++;
    stats.minPrice = Math.min(stats.minPrice, price);
    stats.maxPrice = Math.max(stats.maxPrice, price);
    stats.prices.push(price);
  }

  console.log("Descriptor Statistics (GENERAL USAGE only):");
  console.log("============================================");
  const sortedDescriptors = Array.from(descriptorStats.entries()).sort(
    (a, b) => {
      const order = [
        "extremelyLow",
        "veryLow",
        "low",
        "neutral",
        "high",
        "spike",
      ];
      return order.indexOf(a[0]) - order.indexOf(b[0]);
    },
  );

  for (const [descriptor, stats] of sortedDescriptors) {
    const avgPrice =
      stats.prices.reduce((a, b) => a + b, 0) / stats.prices.length;
    console.log(`\n${descriptor}:`);
    console.log(`  Count: ${stats.count}`);
    console.log(
      `  Price range: ${stats.minPrice.toFixed(2)}¢ - ${stats.maxPrice.toFixed(2)}¢`,
    );
    console.log(`  Average: ${avgPrice.toFixed(2)}¢`);
  }

  console.log("\n\nFirst 5 general usage records:");
  console.log("===============================");
  for (let i = 0; i < Math.min(5, generalRecords.length); i++) {
    const record = generalRecords[i];
    console.log(`\n${i + 1}. ${record.type} - ${record.date}`);
    console.log(`   Descriptor: ${record.descriptor}`);
    console.log(`   Price: ${record.perKwh}¢/kWh`);
    console.log(`   Renewables: ${record.renewables}%`);
  }
}

fetchAmberPrices().catch(console.error);
