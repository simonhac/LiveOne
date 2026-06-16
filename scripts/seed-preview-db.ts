/**
 * Seed a (disposable) PlanetScale Postgres PREVIEW branch with ALL config + the last N days of
 * time-series, by streaming filtered binary COPYs from a source (prod) into the target (branch).
 *
 * PlanetScale Postgres has no copy-on-write data branches, so a fresh branch is schema-only; this
 * gives it just enough data to render (charts read the 5m/1d aggregates). Pair with
 * `scripts/utils/rebuild-dev-kv-from-db.ts` (rebuild the dev: KV cache from the seeded branch) for
 * live-style power cards.
 *
 * Requires `psql` on PATH. Env:
 *   SOURCE_DATABASE_URL  read-only prod connection (e.g. .env.local PLANETSCALE_DATABASE_URL_MIGRATIONS)
 *   TARGET_DATABASE_URL  the preview branch (e.g. `vercel env pull` PLANETSCALE_DATABASE_URL)
 *   SEED_DAYS            days of raw/5m readings + sessions to copy (default 10 — the heavy tables)
 *   SEED_DAYS_DAILY      days of the tiny DAILY aggregates (agg_1d, flow_1d) to copy (default 45)
 *
 * Usage:
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... npx tsx scripts/seed-preview-db.ts
 *
 * Idempotent: config is loaded only when the target is empty (preserves saved dashboards); the
 * time-series tables are truncated and reloaded every run.
 */
import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED_DAYS = Number(process.env.SEED_DAYS ?? 10);
const SEED_DAYS_DAILY = Number(process.env.SEED_DAYS_DAILY ?? 45);
const source = required("SOURCE_DATABASE_URL");
const target = required("TARGET_DATABASE_URL");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * libpq (psql) doesn't understand node-pg's `sslmode=no-verify`, nor a `sslrootcert=system` file
 * path — normalise both connection strings to a plain TLS connection passed via PG* env vars (keeps
 * the password out of argv / the process list).
 */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, "") || "postgres",
    PGSSLMODE: "require",
  };
}
const SRC_ENV = { ...process.env, ...pgEnv(source) };
const DST_ENV = { ...process.env, ...pgEnv(target) };

function psql(env: NodeJS.ProcessEnv, sql: string): string {
  return execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-tAc", sql], {
    env,
    encoding: "utf8",
  }).trim();
}

/** Stream `SELECT * FROM table [WHERE ...]` from source into target via a temp binary file. */
function copyTable(table: string, where?: string) {
  const file = join(tmpdir(), `seed_${table}.bin`);
  const sel = `\\copy (SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""}) TO '${file}' (FORMAT binary)`;
  const ins = `\\copy ${table} FROM '${file}' (FORMAT binary)`;
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-c", sel], {
    env: SRC_ENV,
    stdio: ["ignore", "inherit", "inherit"],
  });
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-c", ins], {
    env: DST_ENV,
    stdio: ["ignore", "inherit", "inherit"],
  });
  unlinkSync(file);
}

// All config tables (small; full copy). Order matters for FKs: systems first.
const CONFIG_TABLES = [
  "systems",
  "point_info",
  "users",
  "user_systems",
  "polling_status",
  "share_tokens",
];

// Time-series tables -> WHERE clause. The high-frequency tables use the short SEED_DAYS window;
// the tiny per-day aggregates use the much longer SEED_DAYS_DAILY window (cheap, and powers the 30D
// chart/Sankey going back further). Sessions get a +1 day margin so the point_readings session_id
// FK window is covered. measurement_time / interval_end are UTC.
const utcDays = (n: number) =>
  `(now() at time zone 'UTC') - interval '${n} days'`;
const SLICES: Array<[string, string]> = [
  ["sessions", `created_at >= ${utcDays(SEED_DAYS + 1)}`],
  ["point_readings", `measurement_time >= ${utcDays(SEED_DAYS)}`],
  ["point_readings_agg_5m", `interval_end >= ${utcDays(SEED_DAYS)}`],
  [
    "point_readings_agg_1d",
    `day >= to_char(${utcDays(SEED_DAYS_DAILY)},'YYYY-MM-DD')`,
  ],
  [
    "point_readings_flow_1d",
    `day >= to_char(${utcDays(SEED_DAYS_DAILY)},'YYYY-MM-DD')`,
  ],
];

async function main() {
  console.log(
    `Seeding ${pgEnv(target).PGHOST} (user ${pgEnv(target).PGUSER}) — ` +
      `${SEED_DAYS}d readings, ${SEED_DAYS_DAILY}d daily aggregates`,
  );

  // The branch is disposable: drop the readings->sessions FK so a partial time window can't dangle.
  const fk = psql(
    DST_ENV,
    `SELECT conname FROM pg_constraint WHERE conrelid='point_readings'::regclass AND contype='f' AND confrelid='sessions'::regclass LIMIT 1`,
  );
  if (fk) {
    psql(DST_ENV, `ALTER TABLE point_readings DROP CONSTRAINT "${fk}"`);
    console.log(`Dropped FK ${fk} (point_readings -> sessions)`);
  }

  // Config: only load if the target is empty (so re-runs preserve config + saved dashboards).
  const systemsCount = Number(psql(DST_ENV, `SELECT count(*) FROM systems`));
  if (systemsCount === 0) {
    console.log("Config: loading (target is empty)…");
    for (const t of CONFIG_TABLES) copyTable(t);
  } else {
    console.log(`Config: present (${systemsCount} systems) — skipping`);
  }

  // Time-series: truncate + reload the slice every run.
  console.log("Time-series: truncating + reloading slice…");
  psql(DST_ENV, `TRUNCATE ${SLICES.map(([t]) => t).join(", ")}`);
  for (const [t, where] of SLICES) copyTable(t, where);

  // Summary.
  const counts = psql(
    DST_ENV,
    SLICES.map(([t]) => `SELECT '${t}='||count(*) FROM ${t}`).join(
      " UNION ALL ",
    ),
  );
  console.log("Done. Target slice counts:\n" + counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
