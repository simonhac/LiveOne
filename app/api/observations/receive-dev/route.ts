/**
 * Dev QStash Receiver Endpoint for Observation Batches
 *
 * Receives QueueMessage from QStash and logs them (no database writes).
 * Used to test the queue pipeline from development environments.
 *
 * Uses verifySignatureAppRouter wrapper for automatic signature verification.
 */

import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextRequest, NextResponse } from "next/server";
import type { QueueMessage } from "@/lib/observations/types";

async function handler(request: NextRequest) {
  try {
    const body = (await request.json()) as QueueMessage;

    // Log the received message
    console.log(
      `[ObservationsReceiver-Dev] Received: env=${body.env}, systemId=${body.systemId}, ` +
        `systemName="${body.systemName}", observations=${body.observations?.length || 0}, ` +
        `session=${body.session ? "yes" : "no"}, batchTime=${body.batchTime}`,
    );

    // Log observation summary
    if (body.observations && body.observations.length > 0) {
      const topicCounts: Record<string, number> = {};
      for (const obs of body.observations) {
        const topicShort = obs.topic.split("/").slice(-1)[0];
        topicCounts[topicShort] = (topicCounts[topicShort] || 0) + 1;
      }
      console.log(
        `[ObservationsReceiver-Dev] Topics: ${Object.entries(topicCounts)
          .map(([k, v]) => `${k}(${v})`)
          .join(", ")}`,
      );
    }

    // Log session if present
    if (body.session) {
      console.log(
        `[ObservationsReceiver-Dev] Session: label=${body.session.sessionLabel}, ` +
          `cause=${body.session.cause}, successful=${body.session.successful}, ` +
          `numRows=${body.session.numRows}`,
      );
    }

    return NextResponse.json({
      status: "ok",
      message: "Dev receiver - logged only, no database writes",
      stats: {
        observations: body.observations?.length || 0,
        hasSession: !!body.session,
      },
    });
  } catch (error) {
    console.error(
      `[ObservationsReceiver-Dev] Error processing message:`,
      error,
    );
    // Return 500 to trigger QStash retry
    return NextResponse.json(
      { status: "error", error: String(error) },
      { status: 500 },
    );
  }
}

// Wrap handler with signature verification using our custom env var names
export const POST = verifySignatureAppRouter(handler, {
  currentSigningKey: process.env.OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY,
});
