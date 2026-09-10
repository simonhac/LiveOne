import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { readOutboxHealth } from "@/lib/observations/outbox";

/**
 * The durable side of the ingest path — `liveone queue outbox`.
 *
 * `/api/v4/queue` answers "is ingest flowing" from QSTASH's point of view, and `/timing` answers
 * "how long did each batch take". Neither can see a message that never reached QStash at all, which
 * is exactly what a broken PUBLISH looks like: both transports read empty, and the only evidence is
 * in Postgres.
 *
 * 🛑 **Read `failing`, not `backlog`.** An unpublished row means "the relay has not got to it yet",
 * which is the normal steady state between minutes. `attempts > 0` with a `lastError` is the
 * difference between an ingest path that is merely behind and one that is broken — and it is the
 * check that was missing when the flow-control cutover failed on prod (2026-09-10): the reason was
 * recorded in `observations_outbox.last_error` and no surface exposed it.
 *
 *   GET ?limit=<n>   → OutboxHealth
 *
 * Admin only, like its siblings. See docs/incidents/2026-09-09-observations-queue-head-of-line-stall.md.
 */

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  if (!planetscaleDb)
    return NextResponse.json(
      { error: "database not configured" },
      { status: 503 },
    );

  const raw = request.nextUrl.searchParams.get("limit");
  const limit = raw === null ? 20 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    return NextResponse.json(
      { error: `limit must be an integer between 1 and 200 — got "${raw}"` },
      { status: 422 },
    );

  try {
    return NextResponse.json(await readOutboxHealth(limit));
  } catch (error) {
    // Degrade with a reason. This view is reached when something is already wrong, and "the outbox
    // itself could not be read" is a finding, not a stack trace to swallow.
    console.error("[QueueOutbox] read failed:", error);
    return NextResponse.json(
      { error: `could not read the outbox: ${String(error)}` },
      { status: 502 },
    );
  }
}
