/**
 * QStash Receiver Endpoint for Observation Batches
 *
 * Phase 1: Just verifies signature and acknowledges receipt (returns 200 OK)
 * Phase 2: Will process batch and insert into new database
 *
 * Uses verifySignatureAppRouter wrapper for automatic signature verification.
 * QStash will retry on non-2xx responses.
 */

import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextRequest, NextResponse } from "next/server";

async function handler(request: NextRequest) {
  // Phase 1: Just acknowledge receipt
  // The body has already been verified by the wrapper
  try {
    const body = await request.json();
    console.log(
      `[ObservationsReceiver] Received batch: systemId=${body.systemId}, ` +
        `observations=${body.observations?.length || 0}, batchTime=${body.batchTime}`,
    );
  } catch {
    // If parsing fails, still acknowledge - signature was already verified
    console.log(`[ObservationsReceiver] Received batch (parse failed)`);
  }

  // Phase 2: Will process batch here
  // await processObservationBatch(batch);

  return NextResponse.json({ status: "ok" });
}

// Wrap handler with signature verification using our custom env var names
export const POST = verifySignatureAppRouter(handler, {
  currentSigningKey: process.env.OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY,
});
