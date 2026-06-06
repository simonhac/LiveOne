#!/usr/bin/env tsx
/**
 * Restore sub-second precision to the residual whole-second Mondo (sys6) raw rows that
 * the QStash pipeline wrote BEFORE the ms-precision fix deployed (~2026-06-06 07:58Z).
 *
 * Those rows have NO ms sibling (the backfill's ms coverage didn't reach them), so the
 * dedupe script correctly left them — they are the sole copy of a real reading, just at
 * second precision. Turso has the exact-ms version. This UPDATES each PG whole-second
 * row's measurement_time/received_time to Turso's exact ms IN PLACE (no insert/delete,
 * preserves session_id; the 5m bucket is unchanged so aggregates do not move).
 *
 * Matched by (point_id, same second) — Mondo polls every ~2 min so there is ≤1 reading
 * per second per point — with a value sanity check (1e-6 relative tolerance).
 *
 * DRY-RUN by default; --apply performs the UPDATEs. Timestamps are set with
 * `to_timestamp(epoch) AT TIME ZONE 'UTC'` (tz-independent). Idempotent.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, gt, gte, lt, sql } from "drizzle-orm";
import * as schema from "@/lib/db/planetscale/schema";
import { pointReadings as pPR } from "@/lib/db/planetscale/schema";
import { db as turso } from "@/lib/db/turso";
import { pointReadings as tPR } from "@/lib/db/turso/schema-monitoring-points";

const SYS = 6;
const APPLY = process.argv.includes("--apply");
const WIN_START_MS = Date.parse("2026-06-05T00:00:00Z");
const WIN_END_MS = Date.parse("2026-06-06T08:00:00Z");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 4,
  keepAlive: true,
  connectionTimeoutMillis: 10000,
  query_timeout: 60000,
  statement_timeout: 60000,
});
const db = drizzle(pool, { schema }) as any;

const near = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

async function main() {
  console.log(`restore-sys6-precision — mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Turso ms readings → map (point:second) → { ms, rms, value }
  const tRows = await turso
    .select({
      pt: tPR.pointId,
      t: tPR.measurementTimeMs,
      rt: tPR.receivedTimeMs,
      v: tPR.value,
    })
    .from(tPR)
    .where(
      and(
        eq(tPR.systemId, SYS),
        gt(tPR.measurementTimeMs, WIN_START_MS - 1000),
        lt(tPR.measurementTimeMs, WIN_END_MS),
      ),
    );
  const tByKey = new Map<
    string,
    { ms: number; rms: number; v: number | null }
  >();
  for (const r of tRows)
    tByKey.set(`${r.pt}:${Math.floor((r.t as number) / 1000)}`, {
      ms: r.t as number,
      rms: r.rt as number,
      v: r.v,
    });

  // PG whole-second sys6 rows in the window (Drizzle reads timestamps as UTC).
  const pRows = await db
    .select({
      id: pPR.id,
      pt: pPR.pointId,
      mt: pPR.measurementTime,
      v: pPR.value,
    })
    .from(pPR)
    .where(
      and(
        eq(pPR.systemId, SYS),
        gte(pPR.measurementTime, new Date(WIN_START_MS)),
        lt(pPR.measurementTime, new Date(WIN_END_MS)),
        sql`measurement_time = date_trunc('second', measurement_time)`,
      ),
    );

  const updates: Array<{ id: number; ms: number; rms: number }> = [];
  let noMatch = 0;
  let valueMismatch = 0;
  for (const p of pRows) {
    const sec = Math.floor((p.mt as Date).getTime() / 1000);
    const t = tByKey.get(`${p.pt}:${sec}`);
    if (!t) {
      noMatch++;
      continue;
    }
    if (
      !(
        (p.v == null && t.v == null) ||
        (p.v != null && t.v != null && near(p.v as number, t.v))
      )
    ) {
      valueMismatch++;
      continue;
    }
    updates.push({ id: p.id as number, ms: t.ms, rms: t.rms });
  }

  console.log(`PG whole-second sys6 rows in window: ${pRows.length}`);
  console.log(
    `  → matched & to restore: ${updates.length}   no-Turso-match: ${noMatch}   value-mismatch(skipped): ${valueMismatch}`,
  );
  for (const u of updates.slice(0, 5)) {
    console.log(`  sample id=${u.id} → mt=${new Date(u.ms).toISOString()}`);
  }

  if (!APPLY) {
    console.log("DRY-RUN: no writes. Re-run with --apply.");
    await pool.end();
    process.exit(0);
  }
  if (updates.length === 0) {
    console.log("Nothing to restore.");
    await pool.end();
    process.exit(0);
  }

  let done = 0;
  const BATCH = 500;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    // UPDATE … FROM (VALUES …) — set ms timestamps tz-independently.
    const params: any[] = [];
    const tuples = batch
      .map((u, j) => {
        params.push(u.id, u.ms / 1000, u.rms / 1000);
        return `($${j * 3 + 1}::int, $${j * 3 + 2}::float8, $${j * 3 + 3}::float8)`;
      })
      .join(", ");
    await pool.query(
      `UPDATE point_readings p
         SET measurement_time = to_timestamp(v.mt_s) AT TIME ZONE 'UTC',
             received_time    = to_timestamp(v.rt_s) AT TIME ZONE 'UTC'
       FROM (VALUES ${tuples}) AS v(id, mt_s, rt_s)
       WHERE p.id = v.id`,
      params,
    );
    done += batch.length;
    console.log(`  updated ${done}/${updates.length}`);
  }

  await pool.end();
  console.log("DONE");
  process.exit(0);
}
main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
