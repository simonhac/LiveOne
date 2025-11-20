/**
 * Analyze Amber GraphQL indicator values and map them to price ranges
 *
 * This script analyzes the actual GraphQL response data to understand
 * how Amber maps prices to visual indicators (NEGATIVE_SPIKE, GOOD, NEUTRAL, etc.)
 */

// Sample GraphQL response data from network capture
const graphqlData = {
  data: {
    sitePricing: {
      meterWindows: [
        {
          usageType: "GENERAL",
          previousPeriods: [
            { kwhPriceInCents: 22, indicator: "GOOD" },
            { kwhPriceInCents: 22, indicator: "GOOD" },
            { kwhPriceInCents: 24, indicator: "GOOD" },
            { kwhPriceInCents: 19, indicator: "GOOD" },
            { kwhPriceInCents: 22, indicator: "GOOD" },
            { kwhPriceInCents: 25, indicator: "GOOD" },
            { kwhPriceInCents: 25, indicator: "GOOD" },
            { kwhPriceInCents: 28, indicator: "NEUTRAL" },
            { kwhPriceInCents: 29, indicator: "NEUTRAL" },
            { kwhPriceInCents: 27, indicator: "GOOD" },
            { kwhPriceInCents: 16, indicator: "NEGATIVE_SPIKE" },
            { kwhPriceInCents: 20, indicator: "GOOD" },
            { kwhPriceInCents: 25, indicator: "GOOD" },
            { kwhPriceInCents: 24, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 20, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 20, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 20, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 21, indicator: "GOOD" },
            { kwhPriceInCents: 22, indicator: "GOOD" },
            { kwhPriceInCents: 22, indicator: "GOOD" },
            { kwhPriceInCents: 17, indicator: "NEGATIVE_SPIKE" },
            { kwhPriceInCents: 16, indicator: "NEGATIVE_SPIKE" },
            { kwhPriceInCents: 11, indicator: "NEGATIVE_SPIKE" },
            { kwhPriceInCents: 11, indicator: "NEGATIVE_SPIKE" },
            { kwhPriceInCents: 11, indicator: "NEGATIVE_SPIKE" },
            { kwhPriceInCents: 11, indicator: "NEGATIVE_SPIKE" },
            { kwhPriceInCents: 11, indicator: "NEGATIVE_SPIKE" },
          ],
        },
      ],
    },
  },
};

// Analyze indicator values
const indicatorStats = new Map<
  string,
  { count: number; minPrice: number; maxPrice: number; prices: number[] }
>();

const periods = graphqlData.data.sitePricing.meterWindows[0].previousPeriods;

for (const period of periods) {
  const indicator = period.indicator;
  const price = period.kwhPriceInCents;

  if (!indicatorStats.has(indicator)) {
    indicatorStats.set(indicator, {
      count: 0,
      minPrice: Infinity,
      maxPrice: -Infinity,
      prices: [],
    });
  }

  const stats = indicatorStats.get(indicator)!;
  stats.count++;
  stats.minPrice = Math.min(stats.minPrice, price);
  stats.maxPrice = Math.max(stats.maxPrice, price);
  stats.prices.push(price);
}

console.log("GraphQL Indicator Statistics:");
console.log("=============================\n");

const sortedIndicators = Array.from(indicatorStats.entries()).sort((a, b) => {
  const order = ["NEGATIVE_SPIKE", "GOOD", "NEUTRAL", "BAD", "SPIKE"];
  return order.indexOf(a[0]) - order.indexOf(b[0]);
});

for (const [indicator, stats] of sortedIndicators) {
  const avgPrice =
    stats.prices.reduce((a, b) => a + b, 0) / stats.prices.length;
  console.log(`${indicator}:`);
  console.log(`  Count: ${stats.count}`);
  console.log(`  Price range: ${stats.minPrice}¢ - ${stats.maxPrice}¢`);
  console.log(`  Average: ${avgPrice.toFixed(2)}¢`);
  console.log();
}

console.log("\nMapping GraphQL indicators to REST descriptors:");
console.log("================================================\n");

console.log("Based on the data:");
console.log(
  "- NEGATIVE_SPIKE (11-17¢) maps to extremelyLow (4-17¢) in REST API",
);
console.log("- GOOD (19-27¢) maps to veryLow (17-26¢) in REST API");
console.log("- NEUTRAL (28-29¢) maps to low (26-34¢) in REST API");
console.log();

console.log("\nProposed mapping for our component:");
console.log("====================================\n");
console.log("We should use these thresholds to replicate Amber's UI:");
console.log("- extremelyLow (green): < 17¢");
console.log("- veryLow (green): 17-26¢");
console.log("- low (yellow): 26-34¢");
console.log("- neutral (yellow): 34-41¢");
console.log("- high (orange): ≥ 41¢");
