/**
 * One-time setup script to create the observations queue in QStash
 *
 * Run with: npx tsx scripts/setup-observations-queue.ts
 *
 * This creates the queue in a PAUSED state, so messages will accumulate
 * without being delivered. This allows:
 * 1. Testing the publishing side without needing a receiver
 * 2. Inspecting queued messages via the admin page
 * 3. Resuming delivery when the receiver is ready
 */

import { Client } from "@upstash/qstash";
import * as dotenv from "dotenv";

// Load environment variables from .env.local
dotenv.config({ path: ".env.local" });

const QUEUE_NAME = "observations";

async function main() {
  const token = process.env.OBSERVATIONS_QSTASH_TOKEN;
  if (!token) {
    console.error("Error: OBSERVATIONS_QSTASH_TOKEN not set in environment");
    console.error("Add it to .env.local and try again");
    process.exit(1);
  }

  console.log("Setting up observations queue...");
  console.log(`Queue name: ${QUEUE_NAME}`);

  const client = new Client({ token });
  const queue = client.queue({ queueName: QUEUE_NAME });

  try {
    // Create or update the queue in paused state
    await queue.upsert({
      parallelism: 1, // Process one message at a time
      paused: true, // Start paused so messages accumulate
    });

    console.log("\nQueue created successfully!");
    console.log("- Status: PAUSED (messages will accumulate)");
    console.log("- Parallelism: 1");
    console.log("\nNext steps:");
    console.log("1. Deploy the receiver endpoint (/api/observations/receive)");
    console.log("2. Start publishing observations (will queue while paused)");
    console.log("3. Resume the queue when ready to process");

    // Fetch and display current queue status
    const info = await queue.get();
    console.log("\nCurrent queue info:", JSON.stringify(info, null, 2));
  } catch (error) {
    console.error("Failed to create queue:", error);
    process.exit(1);
  }
}

main();
