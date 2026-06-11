/**
 * Outbox relay — drains the `observations_outbox` table to QStash (Phase 4).
 *
 * GET /api/cron/relay-outbox  (minutely, see vercel.json)
 *
 * The "relay" half of the transactional outbox: it republishes durably-captured
 * outbox rows to QStash → the existing idempotent receiver, marking each row
 * published once QStash accepts it. Running alongside the live direct enqueue
 * during the soak, it proves PG raw-durability is independent of the swallowed/
 * crashed-enqueue windows. READ-then-WRITE but idempotent + best-effort; the drain
 * itself never throws. See lib/observations/outbox.ts and
 * docs/turso-pg-migration.md Phase 4.
 *
 * Tuning via env: OUTBOX_RELAY_BATCH (rows/run, default 200), OUTBOX_GC_DAYS
 * (published-row retention, default 7).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { drainOutbox } from "@/lib/observations/outbox";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const auth = await requireCronOrAdmin(request);
  if (auth instanceof NextResponse) return auth;

  if (!planetscaleDb) {
    return NextResponse.json({ configured: false });
  }

  const startedAt = Date.now();
  // Drain the outbox to QStash. The outbox tee is always written at the publish
  // seam, so this is the durable on-ramp that re-delivers anything the direct
  // enqueue dropped.
  const result = await drainOutbox();

  return NextResponse.json({
    configured: true,
    enabled: true,
    now: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ...result,
  });
}
