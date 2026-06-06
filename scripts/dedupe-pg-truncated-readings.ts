#!/usr/bin/env tsx
/**
 * Remediate second-truncated DUPLICATE rows in PROD Postgres `point_readings`.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────────
 * The QStash observations pipeline dropped sub-second precision on the write path
 * through the queue. `lib/observations/publisher.ts` serialized measurementTime /
 * receivedTime via `formatTimestamp()` → `formatTime_fromJSDate()`
 * (lib/date-utils.ts), which builds the ISO string from year..SECOND with NO
 * milliseconds (e.g. `2025-01-15T20:30:00+10:00`). The receiver re-parsed with
 * `new Date(isoString)`, so any reading that travelled the QUEUE landed in PG with
 * a WHOLE-SECOND `measurement_time`. Turso's inline write and the historical
 * backfill used the full-ms `measurementTimeMs`, so they kept sub-second precision.
 *
 * For ms-precision vendors (e.g. Mondo, system_id=6) PG therefore accumulated BOTH
 * copies of a reading — the truncated `.000` (via the queue) and the original
 * `.SSS` (via inline/backfill) — as DISTINCT rows under the unique index
 * `pr_point_time_unique(system_id, point_id, measurement_time)`, because
 * `…:00.000 != …:00.611`. Whole-second-native vendors (e.g. Selectronic,
 * system_id=1) have no sub-second sibling, so the truncated copy simply collided
 * and was deduped — those rows are CORRECT and MUST NOT be touched.
 *
 * ── WHAT THIS SCRIPT DELETES ─────────────────────────────────────────────────
 * A row r is a TRUNCATED DUPLICATE (and is deleted) iff:
 *
 *   r.measurement_time = date_trunc('second', r.measurement_time)   -- r is whole-second
 *   AND EXISTS a sibling row s with the same (system_id, point_id) where
 *       date_trunc('second', s.measurement_time) = r.measurement_time
 *       AND s.measurement_time <> r.measurement_time                 -- a sub-second sibling exists
 *       AND s.value IS NOT DISTINCT FROM r.value                     -- and it is the SAME reading
 *
 * We DELETE r (the whole-second truncated copy) and KEEP s (the sub-second row that
 * matches Turso). The EXISTS clause guarantees a sole whole-second row with no
 * sub-second sibling (e.g. every Selectronic reading) is NEVER deleted.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *   • DRY-RUN BY DEFAULT. Without `--apply` the script only COUNTS and SAMPLES; it
 *     performs NO writes.
 *   • `--apply` IS DESTRUCTIVE — it DELETEs from PROD `point_readings` inside a
 *     transaction, then recomputes the affected 5m/1d aggregates.
 *   • Bounded by a measurement_time window (default 2026-06-04 .. 2026-06-08) so it
 *     never full-table scans. Override with `--from`/`--to` (YYYY-MM-DD, UTC).
 *   • Idempotent: after a clean `--apply`, a subsequent dry-run reports 0.
 *   • All values are passed as bound parameters; no value is string-interpolated.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   Dry-run (default):  tsx scripts/dedupe-pg-truncated-readings.ts
 *   Custom window:      tsx scripts/dedupe-pg-truncated-readings.ts --from 2026-06-04 --to 2026-06-08
 *   Apply (DESTRUCTIVE): tsx scripts/dedupe-pg-truncated-readings.ts --apply
 *
 * The parent launcher sets DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD +
 * NODE_ENV=production from PLANETSCALE_DATABASE_URL_MIGRATIONS; this script reuses
 * the exact pg.Pool setup from scripts/temp/recompute-day.ts.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { CalendarDate } from "@internationalized/date";
import * as schema from "@/lib/db/planetscale/schema";
import { db as turso } from "@/lib/db/turso";
import { systems as tSystems } from "@/lib/db/turso/schema";
import {
  recomputeAgg5mForIntervals,
  recomputeAgg1dForDay,
} from "@/lib/db/planetscale/aggregate-points-pg";
import {
  intervalEndForMs,
  FIVE_MIN_MS,
} from "@/lib/aggregation/point-aggregates";

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

const FROM_DAY = argValue("--from") ?? "2026-06-04";
const TO_DAY = argValue("--to") ?? "2026-06-08";

// Validate YYYY-MM-DD and build a [from 00:00:00Z, to 00:00:00Z) window (UTC).
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const [label, v] of [
  ["--from", FROM_DAY],
  ["--to", TO_DAY],
] as const) {
  if (!DAY_RE.test(v)) {
    console.error(`Invalid ${label}="${v}" — expected YYYY-MM-DD`);
    process.exit(1);
  }
}
const WIN_START = new Date(`${FROM_DAY}T00:00:00Z`);
const WIN_END = new Date(`${TO_DAY}T00:00:00Z`);
if (!(WIN_START < WIN_END)) {
  console.error(
    `--from (${FROM_DAY}) must be strictly before --to (${TO_DAY})`,
  );
  process.exit(1);
}

// ── pg pool (mirrors scripts/temp/recompute-day.ts exactly) ────────────────────
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 4,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000,
  connectionTimeoutMillis: 10000,
  query_timeout: 25000,
  statement_timeout: 25000,
});
const db = drizzle(pool, { schema }) as any;

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

// ── The dedupe predicate, as a parameterized WHERE clause ──────────────────────
// `r` is a truncated duplicate iff it is whole-second AND a sub-second sibling
// exists for the same (system_id, point_id) that truncates to the same second.
// $1 = WIN_START, $2 = WIN_END.
const TARGET_WHERE = `
  r.measurement_time >= $1
  AND r.measurement_time < $2
  AND r.measurement_time = date_trunc('second', r.measurement_time)
  AND EXISTS (
    SELECT 1
    FROM point_readings s
    WHERE s.system_id = r.system_id
      AND s.point_id = r.point_id
      AND s.measurement_time > r.measurement_time
      AND s.measurement_time < r.measurement_time + interval '1 second'
      AND s.value IS NOT DISTINCT FROM r.value
  )
`;
// The `s.value IS NOT DISTINCT FROM r.value` guard confirms `s` is the SAME reading
// re-serialized (the truncated copy carries the identical value — only the timestamp
// was truncated), not a coincidental distinct same-second reading. It can only ever
// withhold a deletion (safe direction), never broaden it: a true truncated dup always
// shares its sibling's value, while a genuine .000 reading whose same-second neighbour
// has a different value is preserved.
// Note on the EXISTS bound: a sub-second sibling `s` of the whole-second `r`
// satisfies date_trunc('second', s) = r AND s <> r exactly when
// r < s < r + 1 second. This sargable range lets PG use the (system_id,
// point_id, measurement_time) index instead of evaluating date_trunc per row.

async function windowCount(): Promise<number> {
  const res = await withRetry(
    () =>
      pool.query(
        `SELECT COUNT(*)::bigint AS n FROM point_readings
         WHERE measurement_time >= $1 AND measurement_time < $2`,
        [WIN_START, WIN_END],
      ),
    "window-count",
  );
  return Number(res.rows[0].n);
}

async function dryRun() {
  console.log("=== DRY-RUN (no writes) ===");

  // Per-system breakdown of what would be deleted.
  const breakdown = await withRetry(
    () =>
      pool.query(
        `SELECT r.system_id, COUNT(*)::bigint AS n
         FROM point_readings r
         WHERE ${TARGET_WHERE}
         GROUP BY r.system_id
         ORDER BY r.system_id`,
        [WIN_START, WIN_END],
      ),
    "breakdown",
  );

  let total = 0;
  console.log("\nTruncated duplicates to delete, per system:");
  if (breakdown.rows.length === 0) {
    console.log("  (none)");
  } else {
    for (const row of breakdown.rows) {
      const n = Number(row.n);
      total += n;
      console.log(`  system_id=${row.system_id}: ${n}`);
    }
  }
  console.log(`  TOTAL: ${total}`);

  // ~10 sample rows: the whole-second row + its sub-second sibling's time.
  const samples = await withRetry(
    () =>
      pool.query(
        `SELECT
           r.id,
           r.system_id,
           r.point_id,
           r.measurement_time AS truncated_time,
           (SELECT MIN(s.measurement_time)
              FROM point_readings s
             WHERE s.system_id = r.system_id
               AND s.point_id = r.point_id
               AND s.measurement_time > r.measurement_time
               AND s.measurement_time < r.measurement_time + interval '1 second'
               AND s.value IS NOT DISTINCT FROM r.value
           ) AS sibling_subsecond_time
         FROM point_readings r
         WHERE ${TARGET_WHERE}
         ORDER BY r.system_id, r.measurement_time, r.point_id
         LIMIT 10`,
        [WIN_START, WIN_END],
      ),
    "samples",
  );

  console.log(
    "\nSample rows (id, system_id, point_id, truncated_time, sibling_subsecond_time):",
  );
  if (samples.rows.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of samples.rows) {
      console.log(
        `  id=${r.id} sys=${r.system_id} point=${r.point_id} ` +
          `trunc=${(r.truncated_time as Date).toISOString()} ` +
          `sibling=${r.sibling_subsecond_time ? (r.sibling_subsecond_time as Date).toISOString() : "?"}`,
      );
    }
  }

  console.log(
    `\nWindow [${WIN_START.toISOString()} .. ${WIN_END.toISOString()}): ` +
      `would delete ${total} row(s). Re-run with --apply to perform the deletion.`,
  );
}

async function apply() {
  console.log("=== APPLY (DESTRUCTIVE — deletes from PROD point_readings) ===");
  console.log(
    `Window [${WIN_START.toISOString()} .. ${WIN_END.toISOString()})`,
  );

  const beforeCount = await windowCount();
  console.log(`point_readings in window BEFORE: ${beforeCount}`);

  // Affected sets, captured BEFORE the delete so the recompute reads correct raw.
  const affectedIntervalsBySystem = new Map<number, Set<number>>();
  const affectedDaysBySystem = new Map<number, Set<string>>();

  // Phase 1 — identify the target rows with a fast SELECT. The predicate's SELECT
  // side is index-friendly, whereas a single `DELETE … WHERE <correlated EXISTS>`
  // over the window timed out cross-Pacific. Capturing the rows up front also yields
  // the affected (system, interval/day) sets from exactly the rows we will delete.
  const targetRes = await withRetry(
    () =>
      pool.query(
        `SELECT r.id, r.system_id, r.point_id, r.measurement_time
         FROM point_readings r
         WHERE ${TARGET_WHERE}`,
        [WIN_START, WIN_END],
      ),
    "select-targets",
  );
  const deletedRows = targetRes.rows as Array<{
    id: number;
    system_id: number;
    point_id: number;
    measurement_time: Date;
  }>;
  console.log(`Rows matching predicate: ${deletedRows.length}`);

  if (deletedRows.length === 0) {
    console.log("Nothing to delete (already clean). Skipping recompute.");
    const afterCount = await windowCount();
    console.log(`point_readings in window AFTER: ${afterCount}`);
    return;
  }

  // Phase 2 — delete by PRIMARY KEY in batches (index-driven, fast) inside one
  // transaction (all-or-nothing). Each batch is well under the query timeout.
  const ids = deletedRows.map((r) => r.id);
  const client = await pool.connect();
  let totalDeleted = 0;
  try {
    await client.query("BEGIN");
    const DEL_BATCH = 500;
    for (let i = 0; i < ids.length; i += DEL_BATCH) {
      const batch = ids.slice(i, i + DEL_BATCH);
      const res = await client.query(
        `DELETE FROM point_readings WHERE id = ANY($1::int[])`,
        [batch],
      );
      totalDeleted += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("DELETE failed — transaction rolled back. No rows deleted.");
    throw e;
  } finally {
    client.release();
  }
  console.log(`Rows deleted: ${totalDeleted}`);

  // Build affected sets from the deleted rows. A deleted row's interval still has
  // its surviving sub-second sibling, so the 5m aggregate must be rebuilt to drop
  // the truncated copy's contribution (and the 1d that rolls it up).
  for (const r of deletedRows) {
    const ms = (r.measurement_time as Date).getTime();
    const sys = r.system_id;
    let ivSet = affectedIntervalsBySystem.get(sys);
    if (!ivSet) {
      ivSet = new Set<number>();
      affectedIntervalsBySystem.set(sys, ivSet);
    }
    ivSet.add(intervalEndForMs(ms));
    // A deleted row on an interval boundary is the previousLast source for the NEXT
    // interval's transform='d' delta — recompute that interval too (idempotent, cheap).
    ivSet.add(intervalEndForMs(ms) + FIVE_MIN_MS);
  }

  // Per-system breakdown of deletions.
  const perSystem = new Map<number, number>();
  for (const r of deletedRows) {
    perSystem.set(r.system_id, (perSystem.get(r.system_id) ?? 0) + 1);
  }
  console.log("Deleted per system:");
  for (const [sys, n] of [...perSystem.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  system_id=${sys}: ${n}`);
  }

  // Fetch timezone offsets from Turso `systems` to map intervals → local days and
  // to drive the 1d recompute (matches recompute-day.ts).
  const sysRows = await turso.select().from(tSystems);
  const sysById = new Map(sysRows.map((s) => [s.id, s]));

  // Compute affected local days per system from the deleted rows' intervals.
  for (const [sys, ivSet] of affectedIntervalsBySystem) {
    const sysRow = sysById.get(sys);
    if (!sysRow) {
      console.warn(
        `  ! system_id=${sys} not found in Turso systems — cannot map days; skipping 1d for it`,
      );
      continue;
    }
    const tzMin = sysRow.timezoneOffsetMin;
    let daySet = affectedDaysBySystem.get(sys);
    if (!daySet) {
      daySet = new Set<string>();
      affectedDaysBySystem.set(sys, daySet);
    }
    for (const ivEndMs of ivSet) {
      // The 1d aggregate's day window is (00:05 of D .. 00:00 of D+1], inclusive at the
      // trailing edge (see dayToUnixRangeForAggregation) — so an interval ending exactly
      // at local 00:00:00 of D+1 belongs to day D, not D+1. Subtract 1ms before reading
      // the local date so that boundary interval attributes to the correct (prior) day;
      // non-boundary intervals (always on :MM:00.000) are unaffected.
      const local = new Date(ivEndMs + tzMin * 60_000 - 1);
      const y = local.getUTCFullYear();
      const m = String(local.getUTCMonth() + 1).padStart(2, "0");
      const d = String(local.getUTCDate()).padStart(2, "0");
      daySet.add(`${y}-${m}-${d}`);
    }
  }

  // ── Recompute 5m per system for its affected intervals (chunked, retried) ──
  console.log("\nRecomputing 5m aggregates…");
  for (const [sys, ivSet] of affectedIntervalsBySystem) {
    const ends = [...ivSet].sort((a, b) => a - b);
    const CHUNK = 10;
    let done = 0;
    let upserted = 0;
    for (let i = 0; i < ends.length; i += CHUNK) {
      const chunk = ends.slice(i, i + CHUNK);
      const res = await withRetry(
        () => recomputeAgg5mForIntervals(db, sys, chunk),
        `5m sys${sys}@${i}`,
      );
      done += chunk.length;
      upserted += res.rowsUpserted;
    }
    console.log(
      `  sys${sys}: recomputed ${ends.length} 5m interval(s), upserted ${upserted} row(s)`,
    );
  }

  // ── Recompute 1d per (system, affected day) ──
  console.log("\nRecomputing 1d aggregates…");
  for (const [sys, daySet] of affectedDaysBySystem) {
    const sysRow = sysById.get(sys);
    if (!sysRow) continue;
    for (const dayStr of [...daySet].sort()) {
      const [y, m, d] = dayStr.split("-").map(Number);
      const day = new CalendarDate(y, m, d);
      const r1d = await withRetry(
        () =>
          recomputeAgg1dForDay(
            db,
            { id: sys, timezoneOffsetMin: sysRow.timezoneOffsetMin },
            day,
          ),
        `1d sys${sys}@${dayStr}`,
      );
      console.log(
        `  sys${sys} day=${dayStr}: upserted ${r1d.rowsUpserted} row(s) (tz=${sysRow.timezoneOffsetMin})`,
      );
    }
  }

  // ── Validation: window count before/after ──
  const afterCount = await windowCount();
  console.log("\n=== VALIDATION ===");
  console.log(`point_readings in window BEFORE: ${beforeCount}`);
  console.log(`point_readings in window AFTER:  ${afterCount}`);
  console.log(
    `Difference (expected = rows deleted): ${beforeCount - afterCount}`,
  );
  if (beforeCount - afterCount !== deletedRows.length) {
    console.warn(
      `  ! WARNING: before-after (${beforeCount - afterCount}) != deleted (${deletedRows.length}). ` +
        `Concurrent writes may have occurred in the window.`,
    );
  }
}

async function main() {
  console.log(
    `dedupe-pg-truncated-readings — mode=${APPLY ? "APPLY" : "DRY-RUN"} ` +
      `window=[${FROM_DAY} .. ${TO_DAY})`,
  );
  if (APPLY) {
    await apply();
  } else {
    await dryRun();
  }
  await pool.end();
  console.log("DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
