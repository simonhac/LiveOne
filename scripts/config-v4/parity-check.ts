#!/usr/bin/env tsx
/**
 * config-v4 parity check (Phase 7). Compares the pre-transform composite `_old` tables against the
 * rid-keyed twins + registry integrity, on a rehearsal branch. Non-zero exit on any red.
 *
 * Everything is a SERVER-SIDE aggregate: a per-column content check is `sum` of a per-row md5 hash
 * (order-independent, bounded memory — never materializes 15M rows client-side, so ~0 egress and no OOM
 * from a giant string_agg). The hash includes the mapped key (point_rid vs the old system_id/point_id →
 * point_info.rid), so it proves the rid re-key is correct row-by-row, not just that the multisets match.
 *
 * Usage (on the branch, AFTER config-transform.ts --commit):
 *   PLANETSCALE_DATABASE_URL="<branch url>" REHEARSAL_BRANCH_ID="<branch id>" \
 *     npx tsx scripts/config-v4/parity-check.ts
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { assertRehearsalTarget } from "./guard";

// Order-independent, bounded-memory content checksum over the listed columns (returned as text for exact
// compare). `('x'||<16 hex>)::bit(64)::bigint` folds each row's md5 to a signed 64-bit int; sum() → numeric.
const CK = (cols: string) =>
  `sum(('x' || substr(md5(ROW(${cols})::text), 1, 16))::bit(64)::bigint)::text`;

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail: string }[] = [];

async function main() {
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const db = requirePlanetscaleDb();
  assertRehearsalTarget();
  const scalar = async (text: string) => {
    const rows = (await db.execute(sql.raw(text))).rows as Record<
      string,
      unknown
    >[];
    return rows.length ? String(Object.values(rows[0])[0] ?? "∅") : "∅";
  };

  // compare two scalar queries; SKIP (not FAIL) if a table is missing (e.g. run before the swap).
  const cmp = async (name: string, aSql: string, bSql: string) => {
    try {
      const [a, b] = [await scalar(aSql), await scalar(bSql)];
      results.push({
        name,
        status: a === b ? "PASS" : "FAIL",
        detail: a === b ? a : `old=${a} new=${b}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        name,
        status: /does not exist/.test(msg) ? "SKIP" : "FAIL",
        detail: msg.split("\n")[0],
      });
    }
  };
  const expect = async (name: string, aSql: string, want: string) => {
    try {
      const a = await scalar(aSql);
      results.push({
        name,
        status: a === want ? "PASS" : "FAIL",
        detail: a === want ? a : `got=${a} want=${want}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        name,
        status: /does not exist/.test(msg) ? "SKIP" : "FAIL",
        detail: msg.split("\n")[0],
      });
    }
  };

  // ── HOT: row counts + per-column content (P1 + C2), _old vs twin ───────────────
  const prNew =
    "point_rid, measurement_time, received_time, value, value_str, error, data_quality, session_id, created_at";
  const prOld =
    "pi.rid, pr.measurement_time, pr.received_time, pr.value, pr.value_str, pr.error, pr.data_quality, pr.session_id, pr.created_at";
  await cmp(
    "P1 point_readings rowcount",
    "SELECT count(*)::text FROM point_readings_old",
    "SELECT count(*)::text FROM point_readings",
  );
  await cmp(
    "C2 point_readings content",
    `SELECT ${CK(prOld)} FROM point_readings_old pr JOIN point_info pi ON pi.system_id=pr.system_id AND pi.id=pr.point_id`,
    `SELECT ${CK(prNew)} FROM point_readings`,
  );

  const a5New =
    "point_rid, interval_end, session_id, avg, min, max, last, delta, value_str, sample_count, error_count, data_quality, created_at, updated_at";
  const a5Old =
    "pi.rid, a.interval_end, a.session_id, a.avg, a.min, a.max, a.last, a.delta, a.value_str, a.sample_count, a.error_count, a.data_quality, a.created_at, a.updated_at";
  await cmp(
    "P1 agg_5m rowcount",
    "SELECT count(*)::text FROM point_readings_agg_5m_old",
    "SELECT count(*)::text FROM point_readings_agg_5m",
  );
  await cmp(
    "C2 agg_5m content",
    `SELECT ${CK(a5Old)} FROM point_readings_agg_5m_old a JOIN point_info pi ON pi.system_id=a.system_id AND pi.id=a.point_id`,
    `SELECT ${CK(a5New)} FROM point_readings_agg_5m`,
  );

  const a1New =
    "point_rid, day, avg, min, max, last, delta, sample_count, error_count, created_at, updated_at";
  const a1Old =
    "pi.rid, a.day, a.avg, a.min, a.max, a.last, a.delta, a.sample_count, a.error_count, a.created_at, a.updated_at";
  await cmp(
    "P1 agg_1d rowcount",
    "SELECT count(*)::text FROM point_readings_agg_1d_old",
    "SELECT count(*)::text FROM point_readings_agg_1d",
  );
  await cmp(
    "C2/P4 agg_1d content (incl. day)",
    `SELECT ${CK(a1Old)} FROM point_readings_agg_1d_old a JOIN point_info pi ON pi.system_id=a.system_id AND pi.id=a.point_id`,
    `SELECT ${CK(a1New)} FROM point_readings_agg_1d`,
  );

  // ── REGISTRY: counts + points non-key fidelity + rid-set match ─────────────────
  await cmp(
    "devices == systems",
    "SELECT count(*)::text FROM systems",
    "SELECT count(*)::text FROM devices",
  );
  await cmp(
    "points == point_info",
    "SELECT count(*)::text FROM point_info",
    "SELECT count(*)::text FROM points",
  );
  await cmp(
    "device_state == polling_status",
    "SELECT count(*)::text FROM polling_status",
    "SELECT count(*)::text FROM device_state",
  );
  await cmp(
    "area_members == area_devices(mapped)",
    "SELECT count(*)::text FROM area_devices ad JOIN legacy_handles lh ON lh.handle=ad.system_id AND lh.device_id IS NOT NULL",
    "SELECT count(*)::text FROM area_members",
  );
  // points carry point_info's attributes verbatim (rid + all non-key cols); proves transform/metric fidelity.
  const ptNew =
    "rid, physical_path, logical_path, metric_type, unit, name, default_name, subsystem, transform, active";
  const ptOld =
    "rid, physical_path_tail, logical_path_stem, metric_type, metric_unit, display_name, point_name, subsystem, transform, active";
  await cmp(
    "C9 points attribute fidelity",
    `SELECT ${CK(ptOld)} FROM point_info`,
    `SELECT ${CK(ptNew)} FROM points`,
  );
  await cmp(
    "points.rid set == point_info.rid",
    "SELECT sum(rid)::text FROM point_info",
    "SELECT sum(rid)::text FROM points",
  );
  await expect(
    "every device has an area-of-one",
    "SELECT count(*)::text FROM devices WHERE primary_area_id IS NULL",
    "0",
  );

  // ── CONFIG (stage 5) — SKIP cleanly until stage 5 lands ────────────────────────
  await expect(
    "5a area_bindings.point_id backfilled",
    "SELECT count(*)::text FROM area_bindings WHERE point_id IS NULL",
    "0",
  );
  await expect(
    "5c dashboards.doc populated",
    "SELECT count(*)::text FROM dashboards WHERE doc IS NULL",
    "0",
  );

  // ── report ─────────────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("\n=== config-v4 parity ===");
  for (const r of results) {
    const mark = r.status === "PASS" ? "✅" : r.status === "SKIP" ? "⚪" : "❌";
    console.log(`  ${mark} ${pad(r.name, 38)} ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log(
    `\n${results.length - failed.length - skipped.length} pass, ${failed.length} fail, ${skipped.length} skip`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
