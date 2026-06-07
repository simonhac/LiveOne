#!/usr/bin/env tsx
/**
 * Map (and optionally fill) gaps in PROD Postgres raw `point_readings` vs Turso.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * The Turso→PG mirror is async/best-effort, so PG raw has holes wherever the queue
 * pipeline was down (the ~9 "mirror down" windows in 2026). Those holes make PG-computed
 * aggregates short on `sampleCount`, which the value reconciler flags RED. This tool finds
 * exactly which (system, UTC-day) buckets are short in PG, and — with --apply — copies the
 * missing raw rows straight from Turso (the source of truth) into PG.
 *
 * Scoped + indexed: every query is bounded by `system_id` + a `measurement_time` range, so it
 * uses the (system_id, measurement_time) index and never full-table scans. (5m-native systems —
 * Amber/Enphase — have no raw and simply report 0/0, so they drop out.)
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *   • DRY-RUN BY DEFAULT — without --apply it only COUNTS and reports; no writes.
 *   • --apply copies Turso→PG with onConflictDoNothing (first-write-wins), so it only ever
 *     ADDS missing rows; it never overwrites or deletes. Idempotent: re-run reports fewer gaps.
 *   • All values are bound parameters; nothing is string-interpolated into SQL.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   Read-only map:  NODE_ENV=production ALLOW_PROD_DB_IN_DEV=true \
 *                     npx tsx scripts/gap-map-raw-readings.ts --from 2026-01-01 --to 2026-06-08
 *   One system:     …--from 2026-06-01 --to 2026-06-08 --system 1
 *   Fill the holes: …--from 2026-06-01 --to 2026-06-08 --apply
 *
 * Reads Turso via @/lib/db/turso; reaches PG via PLANETSCALE_DATABASE_URL or DB_* (same as the
 * backfill). Pair with scripts/recompute-pg-range.ts (rebuild aggregates) then
 * scripts/reconcile-agg-values.ts (prove green).
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, gt, gte, lt, lte, asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { pointReadings as tPR } from "@/lib/db/turso/schema-monitoring-points";
import { systems as tSystems } from "@/lib/db/turso/schema";
import * as pgSchema from "@/lib/db/planetscale/schema";

const DAY_MS = 86_400_000;
const READ_PAGE = 5_000; // Turso rows read per page during --apply fill
const WRITE_CHUNK = 2_000; // rows per PG insert

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  // also support "--name value"
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
    return process.argv[i + 1];
  return undefined;
}

/** YYYY-MM-DD (UTC) for an epoch-day number. */
function dayStr(epochDay: number): string {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
}

async function main() {
  // PG `point_readings.measurement_time` is `timestamp without time zone` (UTC). node-postgres
  // serializes JS Date params in the CLIENT's local tz, so on a non-UTC machine Date-param filters
  // shift by the local offset and silently mis-bucket. Force UTC (Node calls tzset() on this assign,
  // so subsequent Date ops use UTC) before any query. ALSO run with `TZ=UTC` for belt-and-braces.
  process.env.TZ = "UTC";

  const fromStr = arg("from");
  const toStr = arg("to");
  const apply = process.argv.includes("--apply");
  const systemFilter = arg("system") ? Number(arg("system")) : undefined;

  if (!fromStr || !toStr || !DAY_RE.test(fromStr) || !DAY_RE.test(toStr)) {
    console.error(
      "Usage: gap-map-raw-readings.ts --from YYYY-MM-DD --to YYYY-MM-DD [--system N] [--apply]",
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

  const { db: turso, rawClient } = await import("@/lib/db/turso");

  // PG pool: prefer the connection string, else DB_* (mirrors backfill/dedupe).
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
  const pool = new Pool({ ...poolConfig, max: 4 });
  pool.on("error", () => {});
  const pg = drizzle(pool, { schema: pgSchema });

  console.log("─".repeat(72));
  console.log(
    `Gap-map raw point_readings: Turso vs Postgres   ${apply ? "APPLY (fills holes)" : "DRY-RUN"}`,
  );
  console.log(
    `  Window: ${fromStr} .. ${toStr} (UTC)${systemFilter != null ? `   system=${systemFilter}` : ""}`,
  );
  console.log("─".repeat(72));

  // Active systems (raw-bearing ones surface gaps; 5m-native report 0/0 and drop out).
  const sysRows = await turso
    .select({
      id: tSystems.id,
      vendorType: tSystems.vendorType,
      status: tSystems.status,
    })
    .from(tSystems);
  const activeSystems = sysRows
    .filter((s) => s.status === "active")
    .filter((s) => systemFilter == null || s.id === systemFilter)
    .sort((a, b) => a.id - b.id);

  // Per (system, UTC-day) counts via an indexed range scan in each store.
  async function tursoCountsByDay(
    systemId: number,
  ): Promise<Map<number, number>> {
    const res = await rawClient.execute({
      sql: `SELECT measurement_time / ${DAY_MS} AS day, COUNT(*) AS n
            FROM point_readings
            WHERE system_id = ? AND measurement_time >= ? AND measurement_time < ?
            GROUP BY day`,
      args: [systemId, fromMs, toMs],
    });
    const m = new Map<number, number>();
    for (const r of res.rows as any[]) m.set(Number(r.day), Number(r.n));
    return m;
  }
  async function pgCountsByDay(systemId: number): Promise<Map<number, number>> {
    const res = await pool.query(
      `SELECT (EXTRACT(EPOCH FROM measurement_time)::bigint * 1000 / ${DAY_MS}) AS day,
              COUNT(*)::bigint AS n
       FROM point_readings
       WHERE system_id = $1 AND measurement_time >= $2 AND measurement_time < $3
       GROUP BY day`,
      [systemId, new Date(fromMs), new Date(toMs)],
    );
    const m = new Map<number, number>();
    for (const r of res.rows) m.set(Number(r.day), Number(r.n));
    return m;
  }

  interface Deficit {
    systemId: number;
    epochDay: number;
    turso: number;
    pg: number;
    missing: number;
  }
  const deficits: Deficit[] = [];
  let grandMissing = 0;

  for (const s of activeSystems) {
    const [tMap, pMap] = await Promise.all([
      tursoCountsByDay(s.id),
      pgCountsByDay(s.id),
    ]);
    if (tMap.size === 0) continue; // no raw for this system in window (5m-native / idle)
    const days = [...tMap.keys()].sort((a, b) => a - b);
    const sysDeficits: Deficit[] = [];
    for (const d of days) {
      const t = tMap.get(d) ?? 0;
      const p = pMap.get(d) ?? 0;
      if (p < t) {
        const def = {
          systemId: s.id,
          epochDay: d,
          turso: t,
          pg: p,
          missing: t - p,
        };
        sysDeficits.push(def);
        deficits.push(def);
        grandMissing += def.missing;
      }
    }
    if (sysDeficits.length > 0) {
      console.log(
        `\nsystem ${s.id} (${s.vendorType}) — ${sysDeficits.length} day(s) short, ` +
          `${sysDeficits.reduce((a, d) => a + d.missing, 0).toLocaleString()} rows missing:`,
      );
      for (const d of sysDeficits) {
        console.log(
          `  ${dayStr(d.epochDay)}: turso=${d.turso.toLocaleString()} pg=${d.pg.toLocaleString()} missing=${d.missing.toLocaleString()}`,
        );
      }
    }
  }

  if (deficits.length === 0) {
    console.log(
      "\n✅ No PG raw deficits in the window. PG raw ⊇ Turso raw here.",
    );
    await pool.end();
    return;
  }

  const affectedSystems = [...new Set(deficits.map((d) => d.systemId))].sort(
    (a, b) => a - b,
  );
  const minDay = dayStr(Math.min(...deficits.map((d) => d.epochDay)));
  const maxDay = dayStr(Math.max(...deficits.map((d) => d.epochDay)));
  console.log("\n" + "─".repeat(72));
  console.log(
    `TOTAL: ${grandMissing.toLocaleString()} raw rows missing across ${deficits.length} ` +
      `(system,day) bucket(s); systems [${affectedSystems.join(", ")}]; days ${minDay} .. ${maxDay}`,
  );
  console.log(
    `Suggested recompute window after fill: --from ${minDay} --to ${dayStr(Math.max(...deficits.map((d) => d.epochDay)) + 1)}`,
  );

  if (!apply) {
    console.log(
      "\nRe-run with --apply to copy the missing rows from Turso into Postgres.",
    );
    await pool.end();
    return;
  }

  // ── Fill: copy each deficit (system, day) slice Turso → PG (do-nothing on conflict) ──
  console.log(
    "\n=== APPLY — copying missing raw rows (onConflictDoNothing) ===",
  );
  let totalInserted = 0;
  for (const d of deficits) {
    const dayStartMs = d.epochDay * DAY_MS;
    const dayEndMs = dayStartMs + DAY_MS;
    let cursorId = -1;
    let insertedForDay = 0;
    for (;;) {
      const rows = await turso
        .select()
        .from(tPR)
        .where(
          and(
            gt(tPR.id, cursorId),
            gte(tPR.measurementTimeMs, dayStartMs),
            lt(tPR.measurementTimeMs, dayEndMs),
            sql`${tPR.systemId} = ${d.systemId}`,
          ),
        )
        .orderBy(asc(tPR.id))
        .limit(READ_PAGE);
      if (rows.length === 0) break;
      cursorId = rows[rows.length - 1].id;
      const mapped = rows.map((r) => ({
        systemId: r.systemId,
        pointId: r.pointId,
        sessionId: r.sessionId,
        measurementTime: new Date(r.measurementTimeMs),
        receivedTime: new Date(r.receivedTimeMs),
        value: r.value,
        valueStr: r.valueStr,
        error: r.error,
        dataQuality: r.dataQuality,
        createdAt: new Date(r.receivedTimeMs), // backfill marker (keeps off the live-ingest chart)
      }));
      for (let i = 0; i < mapped.length; i += WRITE_CHUNK) {
        const chunk = mapped.slice(i, i + WRITE_CHUNK);
        const res = await pg
          .insert(pgSchema.pointReadings)
          .values(chunk)
          .onConflictDoNothing()
          .returning({ id: pgSchema.pointReadings.id });
        insertedForDay += res.length;
      }
    }
    totalInserted += insertedForDay;
    console.log(
      `  system ${d.systemId} ${dayStr(d.epochDay)}: inserted ${insertedForDay.toLocaleString()} ` +
        `of ${d.missing.toLocaleString()} missing`,
    );
  }
  console.log("─".repeat(72));
  console.log(`✓ Inserted ${totalInserted.toLocaleString()} raw rows total.`);
  console.log(
    "Next: scripts/recompute-pg-range.ts --apply over the suggested window, then reconcile.",
  );
  await pool.end();
}

main().catch((err) => {
  console.error("gap-map failed:", err);
  process.exit(1);
});
