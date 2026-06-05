#!/usr/bin/env tsx
/**
 * Value-level aggregate reconciliation: Turso vs Postgres.
 *
 * The backfill's `--verify` mode only compares per-day *counts* of business keys
 * (and assumes Postgres ⊆ Turso). That cannot prove the *values* match — two
 * tables can hold identical keys with completely different avg/min/max/last/delta.
 * Once Postgres computes its own aggregates (decision A), we need to prove the
 * PG-computed values equal Turso's before trimming the Turso-side publishers.
 *
 * This script joins agg_5m / agg_1d rows by their business key across both DBs
 * over a bounded window and reports value mismatches beyond a tolerance. It is
 * READ-ONLY.
 *
 * Keys:
 *   agg_5m : (system_id, point_id, interval_end)  — Turso ms-int vs PG timestamp (compared as epoch ms)
 *   agg_1d : (system_id, point_id, day)           — text YYYY-MM-DD in both
 *
 * Exit code: non-zero if any VALUE mismatch is found (rows present in BOTH that
 * differ). Rows present in only one DB are reported but do NOT fail — the live
 * tail legitimately lags in PG (queue) and historical recompute may not be run yet.
 *
 * Usage:
 *   npx tsx scripts/reconcile-agg-values.ts --table=agg_5m --days=2
 *   npx tsx scripts/reconcile-agg-values.ts --table=agg_1d --from=2026-01-01 --to=2026-06-01
 *   npx tsx scripts/reconcile-agg-values.ts --table=agg_5m --system=1 --days=7 --tolerance=1e-6
 *   NODE_ENV=production npx tsx scripts/reconcile-agg-values.ts --table=agg_5m --days=1
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, gte, lt, lte, eq, type SQL } from "drizzle-orm";
import {
  pointReadingsAgg5m as tursoAgg5m,
  pointReadingsAgg1d as tursoAgg1d,
} from "@/lib/db/turso/schema-monitoring-points";
import {
  pointReadingsAgg5m as pgAgg5m,
  pointReadingsAgg1d as pgAgg1d,
} from "@/lib/db/planetscale/schema";

type Table = "agg_5m" | "agg_1d";

/** The numeric value columns we reconcile (plus the sampling counts). */
const VALUE_FIELDS = [
  "avg",
  "min",
  "max",
  "last",
  "delta",
  "sampleCount",
  "errorCount",
] as const;
type ValueField = (typeof VALUE_FIELDS)[number];
type ValueRow = Record<ValueField, number | null>;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/** YYYY-MM-DD for an epoch-ms value, in UTC. */
function dayUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Two values are equal if both null, or both numbers within tolerance. The
 * tolerance is relative with a floor of 1, so small magnitudes still allow a
 * tiny absolute slack (float representation differences between SQLite real and
 * Postgres double precision).
 */
function near(
  a: number | null,
  b: number | null,
  field: ValueField,
  tol: number,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  // Counts must match exactly.
  if (field === "sampleCount" || field === "errorCount") return a === b;
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

function pick(row: Record<string, unknown>): ValueRow {
  const out = {} as ValueRow;
  for (const f of VALUE_FIELDS) out[f] = (row[f] as number | null) ?? null;
  return out;
}

async function main() {
  const table = (arg("table") ?? "agg_5m") as Table;
  if (table !== "agg_5m" && table !== "agg_1d") {
    throw new Error(`--table must be agg_5m or agg_1d (got "${table}")`);
  }
  const tol = Number(arg("tolerance") ?? "1e-6");
  const limit = Number(arg("limit") ?? "25");
  const system = arg("system") ? Number(arg("system")) : undefined;
  const all = process.argv.includes("--all");

  // Window: --from/--to (YYYY-MM-DD, UTC) override --days (default 2). --all = no window.
  const days = Number(arg("days") ?? "2");
  const nowMs = Date.now();
  const fromStr = arg("from");
  const toStr = arg("to");
  const fromMs = fromStr
    ? Date.parse(`${fromStr}T00:00:00Z`)
    : nowMs - days * 86_400_000;
  const toMs = toStr ? Date.parse(`${toStr}T00:00:00Z`) : nowMs;

  const { db: turso } = await import("@/lib/db/turso");
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  if (!planetscaleDb) {
    console.error(
      "❌ PLANETSCALE_DATABASE_URL not set — cannot reach Postgres.",
    );
    process.exit(1);
  }

  console.log("─".repeat(64));
  console.log(`Reconcile ${table} values: Turso vs Postgres`);
  console.log(
    `  Window:    ${all ? "ALL" : `${dayUTC(fromMs)} .. ${dayUTC(toMs)}`}` +
      (system != null ? `   system=${system}` : ""),
  );
  console.log(`  Tolerance: ${tol} (relative, floor 1)`);
  console.log("─".repeat(64));

  // Build a key -> values map for each DB, then compare the union of keys.
  const tMap = new Map<string, ValueRow>();
  const pMap = new Map<string, ValueRow>();

  if (table === "agg_5m") {
    const tWhere: (SQL | undefined)[] = all
      ? []
      : [gte(tursoAgg5m.intervalEnd, fromMs), lt(tursoAgg5m.intervalEnd, toMs)];
    if (system != null) tWhere.push(eq(tursoAgg5m.systemId, system));
    const tRows = await turso
      .select()
      .from(tursoAgg5m)
      .where(and(...tWhere.filter(Boolean)));
    for (const r of tRows)
      tMap.set(`${r.systemId}:${r.pointId}:${r.intervalEnd}`, pick(r));

    const pWhere: (SQL | undefined)[] = all
      ? []
      : [
          gte(pgAgg5m.intervalEnd, new Date(fromMs)),
          lt(pgAgg5m.intervalEnd, new Date(toMs)),
        ];
    if (system != null) pWhere.push(eq(pgAgg5m.systemId, system));
    const pRows = await planetscaleDb
      .select()
      .from(pgAgg5m)
      .where(and(...pWhere.filter(Boolean)));
    for (const r of pRows)
      pMap.set(
        `${r.systemId}:${r.pointId}:${r.intervalEnd.getTime()}`,
        pick(r),
      );
  } else {
    const fromDay = fromStr ?? dayUTC(fromMs);
    const toDay = toStr ?? dayUTC(toMs);
    const tWhere: (SQL | undefined)[] = all
      ? []
      : [gte(tursoAgg1d.day, fromDay), lte(tursoAgg1d.day, toDay)];
    if (system != null) tWhere.push(eq(tursoAgg1d.systemId, system));
    const tRows = await turso
      .select()
      .from(tursoAgg1d)
      .where(and(...tWhere.filter(Boolean)));
    for (const r of tRows)
      tMap.set(`${r.systemId}:${r.pointId}:${r.day}`, pick(r));

    const pWhere: (SQL | undefined)[] = all
      ? []
      : [gte(pgAgg1d.day, fromDay), lte(pgAgg1d.day, toDay)];
    if (system != null) pWhere.push(eq(pgAgg1d.systemId, system));
    const pRows = await planetscaleDb
      .select()
      .from(pgAgg1d)
      .where(and(...pWhere.filter(Boolean)));
    for (const r of pRows)
      pMap.set(`${r.systemId}:${r.pointId}:${r.day}`, pick(r));
  }

  // Compare the union of keys.
  let compared = 0;
  let matched = 0;
  let onlyTurso = 0;
  let onlyPg = 0;
  const mismatches: string[] = [];

  const allKeys = new Set([...tMap.keys(), ...pMap.keys()]);
  for (const key of allKeys) {
    const t = tMap.get(key);
    const p = pMap.get(key);
    if (!t) {
      onlyPg++;
      continue;
    }
    if (!p) {
      onlyTurso++;
      continue;
    }
    compared++;
    const bad = VALUE_FIELDS.filter((f) => !near(t[f], p[f], f, tol));
    if (bad.length === 0) {
      matched++;
    } else if (mismatches.length < limit) {
      const detail = bad
        .map((f) => `${f}: turso=${t[f]} pg=${p[f]}`)
        .join(", ");
      mismatches.push(`  ${key}  →  ${detail}`);
    }
  }
  const valueMismatches = compared - matched;

  console.log(`Turso rows: ${tMap.size}   Postgres rows: ${pMap.size}`);
  console.log(`Compared (in both): ${compared}`);
  console.log(`  ✓ value-matched:  ${matched}`);
  console.log(`  ✗ value-mismatch: ${valueMismatches}`);
  console.log(
    `Presence-only (not a failure): only-in-Turso=${onlyTurso} (live tail / un-recomputed), only-in-Postgres=${onlyPg}`,
  );
  if (mismatches.length > 0) {
    console.log(`\nFirst ${mismatches.length} value mismatches:`);
    console.log(mismatches.join("\n"));
  }
  console.log("─".repeat(64));

  if (valueMismatches > 0) {
    console.error(
      `❌ ${valueMismatches} value mismatches — PG-computed aggregates do NOT match Turso.`,
    );
    process.exit(1);
  }
  console.log("✅ All overlapping rows match within tolerance.");
}

main().catch((err) => {
  console.error("Reconcile failed:", err);
  process.exit(1);
});
