#!/usr/bin/env tsx
/**
 * READ-ONLY pre-flight audit for the PlanetScale Postgres FK rebuild.
 *
 * Reports, against whatever Postgres the env points at:
 *   1. The foreign-key constraints that already exist (ground truth, not guesses).
 *   2. Approximate row counts per table (context for how heavy each VALIDATE is).
 *   3. Orphan counts for every constraint we PROPOSE to add — i.e. child rows
 *      whose parent is missing. A constraint can only be added (and VALIDATEd)
 *      when its orphan count is 0; non-zero means backfill / NOT-VALID-tolerate /
 *      clean first (decision #4 in the FK-rebuild plan).
 *
 * This script issues ONLY SELECTs. It writes nothing and is safe to run against
 * production. It does not add, validate, or drop any constraint.
 *
 * Connection: reads .env.local. The discrete DB_HOST/DB_PORT/DB_DATABASE/
 * DB_USERNAME/DB_PASSWORD fields there point at prod PG (the node-pg pool can't
 * parse the sslmode=verify-full connection string, hence the discrete fields).
 * Same path the reconciler/seed scripts use.
 *
 * IMPORTANT NAMING NOTE: in the Drizzle schema the point_info per-system point
 * key is the TS field `index` but the DB COLUMN is "id" (point_info PK is the
 * composite (system_id, id)). All readings->point_info checks below join on
 * point_info.id, NOT a column called "index".
 *
 * Usage:
 *   npx tsx scripts/audit-pg-fk-orphans.ts
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";

type Row = Record<string, unknown>;

async function main() {
  const { planetscaleDb } = await import("@/lib/db/planetscale");

  if (!planetscaleDb) {
    console.error(
      "❌ Postgres is not configured (no PLANETSCALE_DATABASE_URL and no DB_HOST). " +
        "Set the discrete DB_* fields in .env.local. Aborting.",
    );
    process.exit(1);
  }

  const target = process.env.DB_HOST
    ? `${process.env.DB_HOST}:${process.env.DB_PORT ?? 5432}/${process.env.DB_DATABASE ?? ""}`
    : "(PLANETSCALE_DATABASE_URL)";

  const db = planetscaleDb;

  async function q(query: string): Promise<Row[]> {
    const res: any = await db.execute(sql.raw(query));
    return (res.rows ?? res) as Row[];
  }
  // count(*) queries return one row {n: "<bigint-as-string>"}
  async function count(query: string): Promise<number> {
    const rows = await q(query);
    return Number((rows[0] as any)?.n ?? 0);
  }

  console.log("═".repeat(72));
  console.log("PG FK-REBUILD PRE-FLIGHT AUDIT  (READ-ONLY — writes nothing)");
  console.log(`  Target Postgres: ${target}`);
  console.log("═".repeat(72));

  // ── 1. Existing FK constraints ───────────────────────────────────────────
  console.log("\n## 1. Foreign-key constraints that ALREADY exist in PG\n");
  try {
    const fks = await q(`
      SELECT conrelid::regclass::text AS table_name,
             conname,
             pg_get_constraintdef(oid) AS def,
             convalidated AS validated
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      ORDER BY 1, 2;
    `);
    if (fks.length === 0) {
      console.log("  (none)");
    } else {
      for (const r of fks) {
        const validated = r.validated ? "VALID" : "NOT VALID";
        console.log(`  • ${r.table_name}.${r.conname}  [${validated}]`);
        console.log(`      ${r.def}`);
      }
    }
  } catch (e) {
    console.log(`  ! failed to read pg_constraint: ${(e as Error).message}`);
  }

  // ── 2. Approximate row counts (context) ──────────────────────────────────
  console.log("\n## 2. Approximate row counts per table (planner estimate)\n");
  try {
    const counts = await q(`
      SELECT relname, n_live_tup
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY n_live_tup DESC;
    `);
    for (const r of counts) {
      console.log(
        `  ${String(r.relname).padEnd(28)} ${String(r.n_live_tup).padStart(12)}`,
      );
    }
  } catch (e) {
    console.log(
      `  ! failed to read pg_stat_user_tables: ${(e as Error).message}`,
    );
  }

  // ── 3. Orphan checks per PROPOSED constraint ─────────────────────────────
  // Each entry: a constraint we plan to add, its parent-missing orphan query,
  // and whether it's expected to be tiny (config) or a heavy scan (readings).
  console.log("\n## 3. Orphan counts for PROPOSED constraints (expect 0)\n");

  const exactChecks: { id: string; label: string; query: string }[] = [
    {
      id: "#1",
      label: "polling_status.system_id → systems.id  [CASCADE]",
      query: `SELECT count(*) AS n FROM polling_status ps
              LEFT JOIN systems s ON s.id = ps.system_id WHERE s.id IS NULL`,
    },
    {
      id: "#2",
      label: "user_systems.system_id → systems.id  [CASCADE]",
      query: `SELECT count(*) AS n FROM user_systems us
              LEFT JOIN systems s ON s.id = us.system_id WHERE s.id IS NULL`,
    },
    {
      id: "#3",
      label: "users.default_system_id → systems.id  [SET NULL] (non-null only)",
      query: `SELECT count(*) AS n FROM users u
              LEFT JOIN systems s ON s.id = u.default_system_id
              WHERE u.default_system_id IS NOT NULL AND s.id IS NULL`,
    },
    {
      id: "#4",
      label: "sessions.system_id → systems.id  [NO ACTION]",
      query: `SELECT count(*) AS n FROM sessions se
              LEFT JOIN systems s ON s.id = se.system_id WHERE s.id IS NULL`,
    },
    {
      id: "#5",
      label: "point_info.system_id → systems.id  [NO ACTION]",
      query: `SELECT count(*) AS n FROM point_info pi
              LEFT JOIN systems s ON s.id = pi.system_id WHERE s.id IS NULL`,
    },
  ];

  // Informational only — these FKs are NOT being added (Clerk-mirror lag), but
  // knowing the drift is useful.
  const infoChecks: { id: string; label: string; query: string }[] = [
    {
      id: "(skip)",
      label: "user_systems.clerk_user_id → users.clerk_user_id  (NOT adding)",
      query: `SELECT count(*) AS n FROM user_systems us
              LEFT JOIN users u ON u.clerk_user_id = us.clerk_user_id
              WHERE u.clerk_user_id IS NULL`,
    },
    {
      id: "(skip)",
      label:
        "share_tokens.owner_clerk_user_id → users.clerk_user_id  (NOT adding)",
      query: `SELECT count(*) AS n FROM share_tokens st
              LEFT JOIN users u ON u.clerk_user_id = st.owner_clerk_user_id
              WHERE u.clerk_user_id IS NULL`,
    },
  ];

  const verdicts: { id: string; label: string; orphans: number }[] = [];

  for (const c of [...exactChecks]) {
    try {
      const n = await count(c.query);
      verdicts.push({ id: c.id, label: c.label, orphans: n });
      const mark = n === 0 ? "✅" : "⚠️ ";
      console.log(`  ${mark} ${c.id} ${c.label} — orphans: ${n}`);
    } catch (e) {
      console.log(
        `  ❌ ${c.id} ${c.label} — query failed: ${(e as Error).message}`,
      );
    }
  }

  console.log("\n   (informational — relationships we are NOT constraining)\n");
  for (const c of infoChecks) {
    try {
      const n = await count(c.query);
      console.log(`     ${c.label} — would-be orphans: ${n}`);
    } catch (e) {
      console.log(`     ${c.label} — query failed: ${(e as Error).message}`);
    }
  }

  // ── 4. Heavy composite checks: readings/agg → point_info(system_id, id) ───
  console.log(
    "\n## 4. Composite readings/agg → point_info(system_id, id)  [NO ACTION]\n" +
      "   (full scans — may take a while on point_readings)\n",
  );

  const compositeChecks: { id: string; label: string; table: string }[] = [
    { id: "#6", label: "point_readings → point_info", table: "point_readings" },
    {
      id: "#7",
      label: "point_readings_agg_5m → point_info",
      table: "point_readings_agg_5m",
    },
    {
      id: "#8",
      label: "point_readings_agg_1d → point_info",
      table: "point_readings_agg_1d",
    },
  ];

  for (const c of compositeChecks) {
    try {
      const groups = await q(`
        SELECT a.system_id, a.point_id, count(*) AS n
        FROM ${c.table} a
        WHERE NOT EXISTS (
          SELECT 1 FROM point_info pi
          WHERE pi.system_id = a.system_id AND pi.id = a.point_id
        )
        GROUP BY a.system_id, a.point_id
        ORDER BY n DESC
        LIMIT 100;
      `);
      const total = groups.reduce((acc, r) => acc + Number((r as any).n), 0);
      const mark = total === 0 ? "✅" : "⚠️ ";
      console.log(
        `  ${mark} ${c.id} ${c.label} — orphan rows: ${total} across ${groups.length} (system_id, point_id) pair(s)`,
      );
      for (const r of groups.slice(0, 20)) {
        console.log(
          `        system_id=${r.system_id} point_id=${r.point_id} → ${r.n} rows`,
        );
      }
      verdicts.push({ id: c.id, label: c.label, orphans: total });
    } catch (e) {
      console.log(
        `  ❌ ${c.id} ${c.label} — query failed: ${(e as Error).message}`,
      );
    }
  }

  // Existing session FK — report residual orphans (should be 0, it's VALIDATEd)
  console.log("\n## 5. Existing point_readings.session_id → sessions.id\n");
  try {
    const n = await count(`
      SELECT count(*) AS n FROM point_readings pr
      WHERE pr.session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = pr.session_id)`);
    console.log(
      `  ${n === 0 ? "✅" : "⚠️ "} residual session orphans: ${n} (FK already enforced)`,
    );
  } catch (e) {
    console.log(`  ! query failed: ${(e as Error).message}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(72));
  console.log(
    "VERDICT — constraints ready to add now (0 orphans) vs needing work",
  );
  console.log("═".repeat(72));
  const ready = verdicts.filter((v) => v.orphans === 0);
  const attention = verdicts.filter((v) => v.orphans > 0);
  console.log(`\n  READY (${ready.length}):`);
  for (const v of ready) console.log(`    ✅ ${v.id} ${v.label}`);
  console.log(`\n  NEEDS ATTENTION (${attention.length}):`);
  if (attention.length === 0) console.log("    (none) 🎉");
  for (const v of attention)
    console.log(`    ⚠️  ${v.id} ${v.label} — ${v.orphans} orphan row(s)`);
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
