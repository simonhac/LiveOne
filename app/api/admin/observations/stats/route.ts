/**
 * Admin API for Observations Ingestion Stats (Postgres side)
 *
 * GET /api/admin/observations/stats
 * Returns per-minute ingestion counts over the last 24h (bucketed by the true
 * Postgres insert time, point_readings.created_at) plus summary totals.
 *
 * Returns { configured: false } when PLANETSCALE_DATABASE_URL is not set, so the
 * dashboard can show a friendly "not wired up yet" state instead of erroring.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao } from "@/lib/readings";

interface MinuteBucket {
  minute: string; // ISO 8601, truncated to the minute (UTC)
  count: number;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  if (!planetscaleDb) {
    return NextResponse.json({ configured: false });
  }

  try {
    const db = planetscaleDb;
    // One shared 24h cutoff for every counter — the readings DAO takes epoch-ms; sessions reuses it.
    // (The old query evaluated now() per-subquery; a single cutoff is if anything more consistent.)
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const since = new Date(sinceMs);

    const toBuckets = (
      rows: { minuteMs: number; count: number }[],
    ): MinuteBucket[] =>
      rows.map((r) => ({
        minute: new Date(r.minuteMs).toISOString(),
        count: r.count,
      }));

    const [
      raw,
      agg5m,
      raw24h,
      agg5m24h,
      systems24h,
      lastIngestedMs,
      sessionsRes,
    ] = await Promise.all([
      ReadingsDao.createdAtHistogramSince("raw", sinceMs).then(toBuckets),
      ReadingsDao.createdAtHistogramSince("agg5m", sinceMs).then(toBuckets),
      ReadingsDao.countByCreatedAtSince("raw", sinceMs),
      ReadingsDao.countByCreatedAtSince("agg5m", sinceMs),
      ReadingsDao.distinctSystemsByRawCreatedAtSince(sinceMs),
      ReadingsDao.latestRawCreatedAtMs(),
      db.execute(
        sql`SELECT count(*)::int AS n FROM sessions WHERE created_at >= ${since}`,
      ),
    ]);
    const sessions24h = Number(
      ((sessionsRes.rows ?? [])[0] as { n?: number } | undefined)?.n ?? 0,
    );

    // Outbox relay backlog (Phase 4). Separate query, defaulting on error so a
    // not-yet-migrated outbox table degrades to nulls instead of 500-ing.
    let outbox: {
      backlog: number;
      oldestUnpublishedAt: string | null;
      published24h: number;
    } | null = null;
    try {
      const obRes = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM observations_outbox
             WHERE published_at IS NULL)                     AS backlog,
          (SELECT min(created_at) FROM observations_outbox
             WHERE published_at IS NULL)                     AS oldest_at,
          (SELECT count(*)::int FROM observations_outbox
             WHERE published_at >= now() - interval '24 hours') AS published_24h
      `);
      const o = ((obRes.rows ?? [])[0] ?? {}) as {
        backlog: number;
        oldest_at: Date | null;
        published_24h: number;
      };
      outbox = {
        backlog: Number(o.backlog ?? 0),
        oldestUnpublishedAt: o.oldest_at
          ? new Date(o.oldest_at).toISOString()
          : null,
        published24h: Number(o.published_24h ?? 0),
      };
    } catch (err) {
      console.error("[AdminObservations] outbox stats failed:", err);
    }

    return NextResponse.json({
      configured: true,
      now: new Date().toISOString(),
      windowHours: 24,
      perMinute: { raw, agg5m },
      summary: {
        raw24h,
        agg5m24h,
        sessions24h,
        systems24h,
        lastIngestedAt:
          lastIngestedMs != null
            ? new Date(lastIngestedMs).toISOString()
            : null,
      },
      outbox,
    });
  } catch (error) {
    console.error("[AdminObservations] GET stats error:", error);
    return NextResponse.json(
      { error: "Failed to query ingestion stats", detail: String(error) },
      { status: 500 },
    );
  }
}
