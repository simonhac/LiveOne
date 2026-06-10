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

    // Per-minute ingestion counts over the last 24h, bucketed by insert time.
    const perMinute = async (
      table: "point_readings" | "point_readings_agg_5m",
    ) => {
      const res = await db.execute(sql`
        SELECT date_trunc('minute', created_at) AS minute, count(*)::int AS count
        FROM ${sql.raw(table)}
        WHERE created_at >= now() - interval '24 hours'
        GROUP BY 1
        ORDER BY 1
      `);
      const rows = (res.rows ?? []) as Array<{ minute: Date; count: number }>;
      return rows.map(
        (r): MinuteBucket => ({
          minute: new Date(r.minute).toISOString(),
          count: Number(r.count),
        }),
      );
    };

    const [raw, agg5m, summaryRes] = await Promise.all([
      perMinute("point_readings"),
      perMinute("point_readings_agg_5m"),
      db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM point_readings
             WHERE created_at >= now() - interval '24 hours') AS raw_24h,
          (SELECT count(*)::int FROM point_readings_agg_5m
             WHERE created_at >= now() - interval '24 hours') AS agg5m_24h,
          (SELECT count(*)::int FROM sessions
             WHERE created_at >= now() - interval '24 hours') AS sessions_24h,
          (SELECT count(DISTINCT system_id)::int FROM point_readings
             WHERE created_at >= now() - interval '24 hours') AS systems_24h,
          (SELECT max(created_at) FROM point_readings) AS last_ingested_at
      `),
    ]);

    const s = ((summaryRes.rows ?? [])[0] ?? {}) as {
      raw_24h: number;
      agg5m_24h: number;
      sessions_24h: number;
      systems_24h: number;
      last_ingested_at: Date | null;
    };

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
        raw24h: Number(s.raw_24h ?? 0),
        agg5m24h: Number(s.agg5m_24h ?? 0),
        sessions24h: Number(s.sessions_24h ?? 0),
        systems24h: Number(s.systems_24h ?? 0),
        lastIngestedAt: s.last_ingested_at
          ? new Date(s.last_ingested_at).toISOString()
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
