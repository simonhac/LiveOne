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
import { WRITE_OUTBOX } from "@/lib/db/routing";
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
  // Always drain (even when WRITE_OUTBOX is off) so that, after a rollback flip,
  // any straggler rows still reach the queue. With the flag off nothing new is
  // written, so steady state is an empty drain.
  const result = await drainOutbox();

  return NextResponse.json({
    configured: true,
    enabled: WRITE_OUTBOX,
    now: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ...result,
  });
}
