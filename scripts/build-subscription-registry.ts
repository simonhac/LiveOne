#!/usr/bin/env tsx
/**
 * Build subscription registry for composite systems
 *
 * This script builds the reverse mapping from source systems to composite systems
 * that subscribe to their points. Should be run after creating/updating composite systems.
 *
 * Usage: npx tsx scripts/build-subscription-registry.ts
 */

import { buildSubscriptionRegistry } from "../lib/kv-cache-manager";

async function main() {
  console.log("Building subscription registry...");

  try {
    await buildSubscriptionRegistry();
    console.log("✓ Subscription registry built successfully");
    process.exit(0);
  } catch (error) {
    console.error("✗ Failed to build subscription registry:", error);
    process.exit(1);
  }
}

main();
