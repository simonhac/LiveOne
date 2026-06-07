#!/usr/bin/env tsx
/**
 * Rebuild PROD Postgres aggregates over a date window, after PG raw has been healed.
 *
 * ── WHAT ─────────────────────────────────────────────────────────────────────
 * For every active system, over [--from, --to):
 *   • RAW vendors  → recompute 5m from PG's OWN raw (`recomputeAgg5mForIntervals`), only for the
 *                    5m interval-ends that actually have raw in PG (bounded, indexed) — this is what
 *                    makes PG-computed aggregates match Turso once the raw holes are filled.
 *   • 5m-NATIVE    → re-copy Turso `point_readings_agg_5m` → PG (UPSERT) for the window, since PG
 *     (Amber/Enphase) can't recompute these (no raw); this heals the stale late-`updateUsage` intervals.
 *   • ALL vendors  → recompute each affected local day's 1d from PG 5m (`recomputeAgg1dForDay`).
 *
 * The 5m/1d math is the shared db-free module (lib/aggregation/point-aggregates.ts), so PG values
 * match Turso by construction — which scripts/reconcile-agg-values.ts then proves green.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *   • DRY-RUN BY DEFAULT — without --apply it reports the work (interval/day counts), no writes.
 *   • Every write is idempotent upsert (onConflictDoUpdate, keyed by business key). Re-runnable.
 *   • Bounded by system_id + a measurement_time/interval_end range; no full-table scans.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   Dry-run:  NODE_ENV=production ALLOW_PROD_DB_IN_DEV=true \
 *               npx tsx scripts/recompute-pg-range.ts --from 2026-06-01 --to 2026-06-08
 *   Apply:    …--from 2026-06-01 --to 2026-06-08 --apply
 *   System:   …--from 2026-06-01 --to 2026-06-08 --system 1 --apply
 *
 * Run AFTER scripts/gap-map-raw-readings.ts --apply (fill raw), then verify with
 * scripts/reconcile-agg-values.ts.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, gte, lt, asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { CalendarDate } from "@internationalized/date";
import * as pgSchema from "@/lib/db/planetscale/schema";
import { pointReadingsAgg5m as tA5 } from "@/lib/db/turso/schema-monitoring-points";
import { systems as tSystems } from "@/lib/db/turso/schema";
import {
  recomputeAgg5mForIntervals,
  recomputeAgg1dForDay,
} from "@/lib/db/planetscale/aggregate-points-pg";
import { isFiveMinuteNativeVendor } from "@/lib/vendors/native-intervals";

const DAY_MS = 86_400_000;
const FIVE_MIN_MS = 300_000;
const RECOMPUTE_CHUNK = 20; // 5m interval-ends per recompute batch
const COPY_CHUNK = 2_000; // rows per PG upsert when re-copying 5m-native
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
    return process.argv[i + 1];
  return undefined;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  tries = 6,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      console.log(`  ! retry ${label} (${i + 1}/${tries}): ${e?.message || e}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Local YYYY-MM-DD for an interval-end (ms), given a tz offset (minutes). The 00:00 boundary
 * belongs to the prior day (matches dayToUnixRangeForAggregation), so subtract 1ms. */
function localDayStr(intervalEndMs: number, tzMin: number): string {
  const local = new Date(intervalEndMs + tzMin * 60_000 - 1);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function main() {
  // CRITICAL: the recompute reads/writes `timestamp without time zone` (UTC) columns via JS Date
  // params (here AND inside recomputeAgg5mForIntervals/recomputeAgg1dForDay). node-postgres serializes
  // Date params in the CLIENT's local tz, so on a non-UTC machine the recompute would read the WRONG
  // 5m windows and corrupt aggregates. Force UTC (Node tzset()s on assign) before any Date/query.
  // ALSO run with `TZ=UTC` for belt-and-braces.
  process.env.TZ = "UTC";

  const fromStr = arg("from");
  const toStr = arg("to");
  const apply = process.argv.includes("--apply");
  const systemFilter = arg("system") ? Number(arg("system")) : undefined;

  if (!fromStr || !toStr || !DAY_RE.test(fromStr) || !DAY_RE.test(toStr)) {
    console.error(
      "Usage: recompute-pg-range.ts --from YYYY-MM-DD --to YYYY-MM-DD [--system N] [--apply]",
    );
    process.exit(1);
  }
  const fromMs = Date.parse(`${fromStr}T00:00:00Z`);
  const toMs = Date.parse(`${toStr}T00:00:00Z`);
  if (!(fromMs < toMs)) {
    console.error(
      `--from (${fromStr}) must be strictly before --to (${toStr})`,
    );
    process.exit(1);
  }

  const { db: turso } = await import("@/lib/db/turso");

  const url = process.env.PLANETSCALE_DATABASE_URL;
  const host = process.env.DB_HOST;
  const poolConfig = url
    ? { connectionString: url }
    : host
      ? {
          host,
          port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
          database: process.env.DB_DATABASE,
          user: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          ssl: ["0", "false", "disable", "disabled"].includes(
            (process.env.DB_SSL ?? "").toLowerCase(),
          )
            ? false
            : { rejectUnauthorized: false },
        }
      : null;
  if (!poolConfig) {
    console.error(
      "❌ Postgres not configured (PLANETSCALE_DATABASE_URL / DB_*).",
    );
    process.exit(1);
  }
  const pool = new Pool({
    ...poolConfig,
    max: 4,
    keepAlive: true,
    // NB: do NOT set statement_timeout here — the managed PG is PgBouncer-fronted (transaction
    // pooling) and rejects it as an "unsupported startup parameter". query_timeout is client-side.
    query_timeout: 60_000,
  });
  pool.on("error", () => {});
  // recompute functions are typed against the app's PgDb; this drizzle instance satisfies the
  // runtime contract (same node-postgres surface), so cast as the dedupe script does.
  const db = drizzle(pool, { schema: pgSchema }) as any;

  console.log("─".repeat(72));
  console.log(
    `Recompute PG aggregates over window   ${apply ? "APPLY" : "DRY-RUN"}`,
  );
  console.log(
    `  Window: ${fromStr} .. ${toStr} (UTC)${systemFilter != null ? `   system=${systemFilter}` : ""}`,
  );
  console.log("─".repeat(72));

  const sysRows = await turso
    .select({
      id: tSystems.id,
      vendorType: tSystems.vendorType,
      status: tSystems.status,
      timezoneOffsetMin: tSystems.timezoneOffsetMin,
    })
    .from(tSystems);
  const activeSystems = sysRows
    .filter((s) => s.status === "active")
    .filter((s) => systemFilter == null || s.id === systemFilter)
    .sort((a, b) => a.id - b.id);

  let total5mIntervals = 0;
  let total5mNativeCopied = 0;
  let total1dDays = 0;

  for (const s of activeSystems) {
    const native = isFiveMinuteNativeVendor(s.vendorType);
    const localDays = new Set<string>();

    if (native) {
      // ── 5m-native: re-copy Turso agg_5m → PG (upsert), window-scoped ──
      const tRows = await turso
        .select()
        .from(tA5)
        .where(
          and(
            sql`${tA5.systemId} = ${s.id}`,
            gte(tA5.intervalEnd, fromMs),
            lt(tA5.intervalEnd, toMs),
          ),
        )
        .orderBy(asc(tA5.intervalEnd));
      if (tRows.length === 0) continue;
      for (const r of tRows)
        localDays.add(localDayStr(r.intervalEnd, s.timezoneOffsetMin));

      if (apply) {
        const mapped = tRows.map((r) => ({
          systemId: r.systemId,
          pointId: r.pointId,
          intervalEnd: new Date(r.intervalEnd),
          sessionId: r.sessionId,
          avg: r.avg,
          min: r.min,
          max: r.max,
          last: r.last,
          delta: r.delta,
          valueStr: r.valueStr,
          sampleCount: r.sampleCount,
          errorCount: r.errorCount,
          dataQuality: r.dataQuality,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        }));
        for (let i = 0; i < mapped.length; i += COPY_CHUNK) {
          const chunk = mapped.slice(i, i + COPY_CHUNK);
          await withRetry(
            () =>
              db
                .insert(pgSchema.pointReadingsAgg5m)
                .values(chunk)
                .onConflictDoUpdate({
                  target: [
                    pgSchema.pointReadingsAgg5m.systemId,
                    pgSchema.pointReadingsAgg5m.pointId,
                    pgSchema.pointReadingsAgg5m.intervalEnd,
                  ],
                  set: {
                    sessionId: sql`excluded.session_id`,
                    avg: sql`excluded.avg`,
                    min: sql`excluded.min`,
                    max: sql`excluded.max`,
                    last: sql`excluded.last`,
                    delta: sql`excluded.delta`,
                    valueStr: sql`excluded.value_str`,
                    sampleCount: sql`excluded.sample_count`,
                    errorCount: sql`excluded.error_count`,
                    dataQuality: sql`excluded.data_quality`,
                    updatedAt: sql`now()`,
                  },
                }),
            `5m-native copy sys${s.id}@${i}`,
          );
        }
      }
      total5mNativeCopied += tRows.length;
      console.log(
        `system ${s.id} (${s.vendorType}, 5m-native): ${apply ? "copied" : "would copy"} ` +
          `${tRows.length.toLocaleString()} 5m row(s), ${localDays.size} day(s) for 1d`,
      );
    } else {
      // ── raw vendor: recompute 5m from PG raw, only for interval-ends that have raw ──
      const res = await pool.query(
        `SELECT DISTINCT (CEIL(EXTRACT(EPOCH FROM measurement_time) * 1000 / ${FIVE_MIN_MS}.0)
                          * ${FIVE_MIN_MS})::bigint AS ie
         FROM point_readings
         WHERE system_id = $1 AND measurement_time >= $2 AND measurement_time < $3
         ORDER BY ie`,
        [s.id, new Date(fromMs), new Date(toMs)],
      );
      const intervalEnds = res.rows.map((r) => Number(r.ie));
      if (intervalEnds.length === 0) continue;
      for (const ie of intervalEnds)
        localDays.add(localDayStr(ie, s.timezoneOffsetMin));

      if (apply) {
        for (let i = 0; i < intervalEnds.length; i += RECOMPUTE_CHUNK) {
          const chunk = intervalEnds.slice(i, i + RECOMPUTE_CHUNK);
          await withRetry(
            () => recomputeAgg5mForIntervals(db, s.id, chunk),
            `5m recompute sys${s.id}@${i}`,
          );
        }
      }
      total5mIntervals += intervalEnds.length;
      console.log(
        `system ${s.id} (${s.vendorType}): ${apply ? "recomputed" : "would recompute"} ` +
          `${intervalEnds.length.toLocaleString()} 5m interval(s), ${localDays.size} day(s) for 1d`,
      );
    }

    // ── 1d recompute for the affected local days (all vendors, from PG 5m) ──
    const days = [...localDays].sort();
    for (const dayStr of days) {
      if (apply) {
        const [y, m, d] = dayStr.split("-").map(Number);
        await withRetry(
          () =>
            recomputeAgg1dForDay(
              db,
              { id: s.id, timezoneOffsetMin: s.timezoneOffsetMin },
              new CalendarDate(y, m, d),
            ),
          `1d recompute sys${s.id}@${dayStr}`,
        );
      }
    }
    total1dDays += days.length;
  }

  console.log("─".repeat(72));
  console.log(
    `${apply ? "Done" : "Plan"}: 5m recomputed=${total5mIntervals.toLocaleString()} interval(s), ` +
      `5m-native copied=${total5mNativeCopied.toLocaleString()} row(s), ` +
      `1d=${total1dDays.toLocaleString()} (system,day) recompute(s).`,
  );
  if (!apply) console.log("Re-run with --apply to perform the recompute.");
  else
    console.log(
      "Next: scripts/reconcile-agg-values.ts --table=agg_5m and --table=agg_1d over the window.",
    );
  await pool.end();
}

main().catch((err) => {
  console.error("recompute-pg-range failed:", err);
  process.exit(1);
});
