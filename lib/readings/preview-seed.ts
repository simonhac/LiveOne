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
 *   SEED_DAYS_DAILY      days of the tiny DAILY tables (agg_1d, flow_attr_1d, battery_provenance_daily) to copy (default 45)
 *
 * Usage:
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... npx tsx scripts/seed-preview-db.ts
 *
 * Idempotent: config is loaded only when the target is empty (preserves saved dashboards); the
 * time-series tables are truncated and reloaded every run.
 */
import { execFileSync as nodeExecFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SeedPreviewDatabaseOptions {
  sourceUrl: string;
  targetUrl: string;
  seedDays: number;
  seedDaysDaily: number;
  onProgress?: (message: string) => void;
}

export interface PreviewSeedRuntime {
  execFileSync: typeof nodeExecFileSync;
  unlinkSync: typeof unlinkSync;
  tmpdir: typeof tmpdir;
}

const DEFAULT_RUNTIME: PreviewSeedRuntime = {
  execFileSync: nodeExecFileSync,
  unlinkSync,
  tmpdir,
};

/**
 * libpq (psql) doesn't understand node-pg's `sslmode=no-verify`, nor a `sslrootcert=system` file
 * path — normalise both connection strings to a plain TLS connection passed via PG* env vars (keeps
 * the password out of argv / the process list).
 */
function pgEnv(url: string): Record<string, string> {
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
function slices(seedDays: number, seedDaysDaily: number) {
  return [
    ["sessions", `created_at >= ${utcDays(seedDays + 1)}`],
    // SEAM: preview COPY of the three hot stores; Phase 8 rewrites their table/key shapes here.
    ["point_readings", `measurement_time >= ${utcDays(seedDays)}`],
    ["point_readings_agg_5m", `interval_end >= ${utcDays(seedDays)}`],
    [
      "point_readings_agg_1d",
      `day >= to_char(${utcDays(seedDaysDaily)},'YYYY-MM-DD')`,
    ],
    [
      "point_readings_flow_attr_1d",
      `day >= to_char(${utcDays(seedDaysDaily)},'YYYY-MM-DD')`,
    ],
    [
      "battery_provenance_daily",
      `day >= to_char(${utcDays(seedDaysDaily)},'YYYY-MM-DD')`,
    ],
  ] satisfies Array<[string, string]>;
}

export async function seedPreviewDatabase(
  options: SeedPreviewDatabaseOptions,
  runtime: PreviewSeedRuntime = DEFAULT_RUNTIME,
): Promise<{ counts: string }> {
  const log = options.onProgress ?? console.log;
  const srcEnv = { ...process.env, ...pgEnv(options.sourceUrl) };
  const dstEnv = { ...process.env, ...pgEnv(options.targetUrl) };
  const seedSlices = slices(options.seedDays, options.seedDaysDaily);

  const psql = (env: NodeJS.ProcessEnv, statement: string): string =>
    String(
      runtime.execFileSync(
        "psql",
        ["-v", "ON_ERROR_STOP=1", "-tAc", statement],
        { env, encoding: "utf8" },
      ),
    ).trim();

  const copyTable = (table: string, where?: string): void => {
    const file = join(runtime.tmpdir(), `seed_${table}.bin`);
    const select = `\\copy (SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""}) TO '${file}' (FORMAT binary)`;
    const insert = `\\copy ${table} FROM '${file}' (FORMAT binary)`;
    try {
      runtime.execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-c", select], {
        env: srcEnv,
        stdio: ["ignore", "inherit", "inherit"],
      });
      runtime.execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-c", insert], {
        env: dstEnv,
        stdio: ["ignore", "inherit", "inherit"],
      });
    } finally {
      runtime.unlinkSync(file);
    }
  };

  log(
    `Seeding ${pgEnv(options.targetUrl).PGHOST} (user ${pgEnv(options.targetUrl).PGUSER}) — ` +
      `${options.seedDays}d readings, ${options.seedDaysDaily}d daily aggregates`,
  );

  // The branch is disposable: drop the readings->sessions FK so a partial time window can't dangle.
  const fk = psql(
    dstEnv,
    // SEAM: the raw store's legacy session FK disappears/rekeys at Phase 8.
    `SELECT conname FROM pg_constraint WHERE conrelid='point_readings'::regclass AND contype='f' AND confrelid='sessions'::regclass LIMIT 1`,
  );
  if (fk) {
    psql(dstEnv, `ALTER TABLE point_readings DROP CONSTRAINT "${fk}"`);
    log(`Dropped FK ${fk} (point_readings -> sessions)`);
  }

  // Config: only load if the target is empty (so re-runs preserve config + saved dashboards).
  const systemsCount = Number(psql(dstEnv, `SELECT count(*) FROM systems`));
  if (systemsCount === 0) {
    log("Config: loading (target is empty)…");
    for (const t of CONFIG_TABLES) copyTable(t);
  } else {
    log(`Config: present (${systemsCount} systems) — skipping`);
  }

  // Time-series: truncate + reload the slice every run.
  log("Time-series: truncating + reloading slice…");
  psql(dstEnv, `TRUNCATE ${seedSlices.map(([t]) => t).join(", ")}`);
  for (const [t, where] of seedSlices) copyTable(t, where);

  // Summary.
  const counts = psql(
    dstEnv,
    seedSlices
      .map(([t]) => `SELECT '${t}='||count(*) FROM ${t}`)
      .join(" UNION ALL "),
  );
  log("Done. Target slice counts:\n" + counts);
  return { counts };
}
