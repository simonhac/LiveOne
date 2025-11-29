/**
 * QStash Receiver Endpoint for Observation Batches
 *
 * Receives QueueMessage from QStash and inserts into PlanetScale PostgreSQL.
 * - Observations → point_readings or point_readings_agg_5m based on interval
 * - Sessions → sessions table
 *
 * Uses verifySignatureAppRouter wrapper for automatic signature verification.
 * QStash will retry on non-2xx responses.
 */

import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  pointReadings,
  pointReadingsAgg5m,
  sessions,
} from "@/lib/db/planetscale/schema";
import type {
  QueueMessage,
  Observation,
  Session,
} from "@/lib/observations/types";

/**
 * Parse ISO 8601 timestamp to Date object
 */
function parseTimestamp(isoString: string): Date {
  return new Date(isoString);
}

/**
 * Extract pointId from observation debug.reference
 * Format: "{systemId}.{pointIndex}"
 */
function extractPointId(observation: Observation): number | null {
  if (!observation.debug?.reference) {
    return null;
  }
  const parts = observation.debug.reference.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const pointId = parseInt(parts[1], 10);
  return isNaN(pointId) ? null : pointId;
}

/**
 * Insert raw observations into point_readings table
 */
async function insertRawObservations(
  db: NonNullable<typeof planetscaleDb>,
  systemId: number,
  observations: Observation[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const obs of observations) {
    const pointId = extractPointId(obs);
    if (pointId === null) {
      console.warn(
        `[ObservationsReceiver] Skipping observation without valid pointId: ${obs.topic}`,
      );
      skipped++;
      continue;
    }

    try {
      await db
        .insert(pointReadings)
        .values({
          systemId,
          pointId,
          sessionId: obs.sessionId,
          measurementTime: parseTimestamp(obs.measurementTime),
          receivedTime: parseTimestamp(obs.receivedTime),
          value: typeof obs.value === "number" ? obs.value : null,
          valueStr: typeof obs.value === "string" ? obs.value : null,
          dataQuality: "good",
        })
        .onConflictDoNothing();
      inserted++;
    } catch (error) {
      console.error(
        `[ObservationsReceiver] Error inserting raw observation:`,
        error,
      );
      skipped++;
    }
  }

  return { inserted, skipped };
}

/**
 * Insert 5m aggregated observations into point_readings_agg_5m table
 */
async function insert5mObservations(
  db: NonNullable<typeof planetscaleDb>,
  systemId: number,
  observations: Observation[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const obs of observations) {
    const pointId = extractPointId(obs);
    if (pointId === null) {
      console.warn(
        `[ObservationsReceiver] Skipping 5m observation without valid pointId: ${obs.topic}`,
      );
      skipped++;
      continue;
    }

    try {
      await db
        .insert(pointReadingsAgg5m)
        .values({
          systemId,
          pointId,
          intervalEnd: parseTimestamp(obs.measurementTime),
          sessionId: obs.sessionId,
          // For single observations, last = value
          last: typeof obs.value === "number" ? obs.value : null,
          valueStr: typeof obs.value === "string" ? obs.value : null,
          sampleCount: 1,
          errorCount: 0,
          dataQuality: "good",
        })
        .onConflictDoNothing();
      inserted++;
    } catch (error) {
      console.error(
        `[ObservationsReceiver] Error inserting 5m observation:`,
        error,
      );
      skipped++;
    }
  }

  return { inserted, skipped };
}

/**
 * Insert session into sessions table
 */
async function insertSession(
  db: NonNullable<typeof planetscaleDb>,
  systemId: number,
  session: Session,
): Promise<boolean> {
  try {
    await db
      .insert(sessions)
      .values({
        sessionLabel: session.sessionLabel,
        systemId,
        cause: session.cause,
        duration: session.durationMs,
        successful: session.successful,
        errorCode: session.errorCode,
        error: session.error,
        response: session.response,
        numRows: session.numRows,
        createdAt: parseTimestamp(session.started),
      })
      .onConflictDoNothing();
    return true;
  } catch (error) {
    console.error(`[ObservationsReceiver] Error inserting session:`, error);
    return false;
  }
}

/**
 * Process the queue message and insert into PlanetScale
 */
async function processQueueMessage(
  message: QueueMessage,
): Promise<{ success: boolean; stats: Record<string, number> }> {
  if (!planetscaleDb) {
    console.warn("[ObservationsReceiver] PlanetScale not configured, skipping");
    return { success: true, stats: { skipped: 1 } };
  }

  const stats: Record<string, number> = {};

  // Process observations
  if (message.observations && message.observations.length > 0) {
    const rawObs = message.observations.filter((o) => o.interval === "raw");
    const agg5mObs = message.observations.filter((o) => o.interval === "5m");

    if (rawObs.length > 0) {
      const result = await insertRawObservations(
        planetscaleDb,
        message.systemId,
        rawObs,
      );
      stats.rawInserted = result.inserted;
      stats.rawSkipped = result.skipped;
    }

    if (agg5mObs.length > 0) {
      const result = await insert5mObservations(
        planetscaleDb,
        message.systemId,
        agg5mObs,
      );
      stats.agg5mInserted = result.inserted;
      stats.agg5mSkipped = result.skipped;
    }
  }

  // Process session
  if (message.session) {
    const inserted = await insertSession(
      planetscaleDb,
      message.systemId,
      message.session,
    );
    stats.sessionInserted = inserted ? 1 : 0;
  }

  return { success: true, stats };
}

async function handler(request: NextRequest) {
  try {
    const body = (await request.json()) as QueueMessage;

    console.log(
      `[ObservationsReceiver] Received: systemId=${body.systemId}, ` +
        `observations=${body.observations?.length || 0}, ` +
        `session=${body.session ? "yes" : "no"}, ` +
        `batchTime=${body.batchTime}`,
    );

    const { success, stats } = await processQueueMessage(body);

    console.log(`[ObservationsReceiver] Processed: ${JSON.stringify(stats)}`);

    return NextResponse.json({ status: success ? "ok" : "partial", stats });
  } catch (error) {
    console.error(`[ObservationsReceiver] Error processing message:`, error);
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
