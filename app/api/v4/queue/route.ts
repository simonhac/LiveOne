import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { qstash, OBSERVATIONS_QUEUE_NAME } from "@/lib/qstash";
import { ReadingsDao } from "@/lib/readings";
import { planetscaleDb } from "@/lib/db/planetscale";

/**
 * The observations queue — status and control, for `liveone queue`.
 *
 * The v4 twin of `/api/admin/observations/info`, and it exists as a SEPARATE address rather than by
 * admitting the admin one to the CLI-token allowlist: `/api/admin/*` is deliberately outside that
 * allowlist ("a stray `lo_cli_` bearer can never skip the edge on admin, control or vendor routes"),
 * and `auth.protect()` rewrites it to a 404 before any handler sees the bearer. Verified 2026-09-09:
 * a valid CLI token against `/api/admin/amber-sync` returns `404` with
 * `x-clerk-auth-reason: protect-rewrite, token-invalid`. So the capability moves to a v4 route that
 * authorizes in-handler; the admin route and its dashboard UI are untouched.
 *
 *   GET   → { name, paused, lag, parallelism, lastIngestedAt, stalledMinutes }
 *   PATCH { paused?, parallelism? } → the same shape, after applying
 *
 * 🛑 **`stalledMinutes` is the field that matters, not `lag`.** During the 2026-09-09 ingest stall a
 * rising `lag` was read twice as a throughput deficit; it is ambiguous, because a busy queue and a
 * blocked one both grow. `lastIngestedAt` aged against now is not: a busy queue still ingests. The
 * per-minute series had a clean 34-minute hole in an otherwise steady 42.9/min. See
 * `docs/plans/ingest-head-of-line-hardening.md`.
 *
 * Admin only (`requireAdmin`), which a CLI token resolves through exactly like a browser session.
 */

interface QueueView {
  name: string;
  paused: boolean;
  lag: number;
  parallelism: number;
  /** ISO8601, or null when nothing has ever been ingested. */
  lastIngestedAt: string | null;
  /** Minutes since the last durable write. `null` when `lastIngestedAt` is null. */
  stalledMinutes: number | null;
}

/**
 * Queue facts from QStash, joined with ingest recency from Postgres.
 *
 * A queue that does not exist yet is reported as paused rather than raised — the same tolerance
 * `/api/admin/observations/info` has, and for the same reason: a fresh environment has no queue
 * until its first publish, and that is a state, not a failure.
 */
async function readQueue(): Promise<QueueView> {
  const queue = qstash!.queue({ queueName: OBSERVATIONS_QUEUE_NAME });

  let paused = true;
  let lag = 0;
  let parallelism = 1;
  try {
    const info = await queue.get();
    paused = info.paused ?? false;
    lag = info.lag ?? 0;
    parallelism = info.parallelism ?? 1;
  } catch (error) {
    const err = error as { message?: string; status?: number };
    if (!(err?.message?.includes("not found") || err?.status === 404))
      throw error;
  }

  // Ingest recency is a Postgres fact, not a queue fact — the queue can be empty because everything
  // was delivered or because nothing is being dispatched, and only this tells the two apart.
  const lastMs = planetscaleDb
    ? await ReadingsDao.latestRawCreatedAtMs()
    : null;

  return {
    name: OBSERVATIONS_QUEUE_NAME,
    paused,
    lag,
    parallelism,
    lastIngestedAt: lastMs ? new Date(lastMs).toISOString() : null,
    stalledMinutes:
      lastMs != null
        ? Math.round(((Date.now() - lastMs) / 60000) * 10) / 10
        : null,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  if (!qstash)
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );

  return NextResponse.json(await readQueue());
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  if (!qstash)
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );

  const body = (await request.json().catch(() => null)) as {
    paused?: unknown;
    parallelism?: unknown;
  } | null;
  if (!body || (body.paused === undefined && body.parallelism === undefined))
    return NextResponse.json(
      { error: "Body must set at least one of: paused, parallelism" },
      { status: 422 },
    );

  const patch: { paused?: boolean; parallelism?: number } = {};

  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean")
      return NextResponse.json(
        { error: "paused must be a boolean" },
        { status: 422 },
      );
    patch.paused = body.paused;
  }

  if (body.parallelism !== undefined) {
    const n = Number(body.parallelism);
    // 🛑 The ceiling is the Postgres pool, not a QStash limit: each concurrent receiver invocation
    // takes a connection, and starving the web app to drain a backlog trades one outage for another.
    // `getPoolConfig` reads `PLANETSCALE_POOL_MAX ?? 10`, so 10 is the honest maximum here.
    const max = Number(process.env.PLANETSCALE_POOL_MAX ?? 10);
    if (!Number.isInteger(n) || n < 1 || n > max)
      return NextResponse.json(
        {
          error: `parallelism must be an integer between 1 and ${max} (the Postgres pool size)`,
        },
        { status: 422 },
      );
    patch.parallelism = n;
  }

  await qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME }).upsert(patch);
  return NextResponse.json(await readQueue());
}
