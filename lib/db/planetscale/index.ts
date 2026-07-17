/**
 * PlanetScale PostgreSQL Database Connection
 *
 * Separate Drizzle client for PlanetScale, used by the queue receiver
 * to insert observations and sessions.
 *
 * Gracefully degrades if not configured (returns null).
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";
import { isProduction, envLabel } from "@/lib/env";

// Global singleton to persist across hot reloads
declare global {
  // eslint-disable-next-line no-var
  var __planetscalePool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __planetscaleDb: ReturnType<typeof drizzle> | undefined;
}

/** disable-ish ssl signal (DB_SSL or a URL `sslmode`): "disable" / "false" / "0" / "disabled". */
function isSslDisabled(value: string | null | undefined): boolean {
  return ["0", "false", "disable", "disabled"].includes(
    (value ?? "").toLowerCase(),
  );
}

/**
 * Build the Postgres connection config from env.
 *
 * Accepts EITHER a single connection string (PLANETSCALE_DATABASE_URL) OR the
 * discrete fields DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD.
 * Returns null if neither is configured.
 */
function getPoolConfig(): PoolConfig | null {
  const url = process.env.PLANETSCALE_DATABASE_URL;
  if (url) {
    // Parse the URL ourselves and set TLS explicitly instead of letting
    // node-postgres' bundled pg-connection-string interpret the ssl params.
    // It can't handle `sslrootcert=system` (the Node "use the OS trust store"
    // value) — it tries to `open('system')` as a file → ENOENT and the
    // connection dies. Managed Postgres here connects encrypted-without-strict-CA
    // (same as the DB_* path below), so strip the URL's ssl params and apply that
    // explicitly. `sslmode=disable` (or DB_SSL=disable) still opts out, for a
    // local plaintext server.
    try {
      const u = new URL(url);
      const sslDisabled =
        isSslDisabled(u.searchParams.get("sslmode")) ||
        isSslDisabled(process.env.DB_SSL);
      for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"]) {
        u.searchParams.delete(p);
      }
      return {
        connectionString: u.toString(),
        ssl: sslDisabled ? false : { rejectUnauthorized: false },
      };
    } catch {
      // Not a parseable URL — hand it to pg as-is and let it surface the error.
      return { connectionString: url };
    }
  }

  const host = process.env.DB_HOST;
  if (host) {
    return {
      host,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      // Managed Postgres requires TLS. Default to encrypted-without-strict-CA,
      // which works across providers; set DB_SSL=disable for a local server.
      ssl: isSslDisabled(process.env.DB_SSL)
        ? false
        : { rejectUnauthorized: false },
    };
  }

  return null;
}

/**
 * A connection's identity (`user@host[:port]`) for the prod-in-dev guard.
 *
 * Must include the USERNAME, not just the host: PlanetScale puts every branch of
 * every database on the same shared regional gateway host (e.g.
 * `aws-ap-southeast-2-1.pg.psdb.cloud`), and encodes the actual branch in the
 * role/username (`postgres.<branch-id>`). The hostname alone cannot tell prod
 * from liveone-dev — the username can.
 */
function connectionIdentity(config: PoolConfig): string | undefined {
  if (typeof config.connectionString === "string") {
    try {
      const u = new URL(config.connectionString);
      return `${u.username}@${u.host}`;
    } catch {
      return config.connectionString;
    }
  }
  if (config.host) {
    const hostPort = config.port
      ? `${config.host}:${config.port}`
      : config.host;
    return `${config.user ?? ""}@${hostPort}`;
  }
  return undefined;
}

/**
 * Assert the DB connection matches the environment, both directions, using the
 * prod-identity token `PLANETSCALE_PROD_BRANCH_ID` — a prod-unique fragment of
 * `user@host`. On PlanetScale's shared regional host that's the prod BRANCH ID,
 * which appears in the prod username but not in liveone-dev's. Inert until set.
 *
 *  - dev/preview: must NOT be on the prod DB → throw (fail-CLOSED). Escape hatch:
 *    `ALLOW_PROD_DB_IN_DEV=true`.
 *  - production: MUST be on the prod DB → if not, that's drift (a stale token, or
 *    prod pointed at the wrong DB). Log + best-effort alert, but DON'T throw —
 *    fail-OPEN, because a stale token must never take prod down.
 */
function assertDbEnvironmentMatches(config: PoolConfig): void {
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID;
  if (!prodToken) return;

  const identity = connectionIdentity(config);
  const onProdDb =
    !!identity && identity.toLowerCase().includes(prodToken.toLowerCase());

  if (isProduction()) {
    // Drift detection. Fail-open: alert loudly, keep prod running.
    if (!onProdDb) {
      const msg =
        `[PlanetScale] DRIFT: production is NOT connected to the declared prod ` +
        `database (identity=${identity ?? "?"}, expected token=${prodToken}). ` +
        `Check PLANETSCALE_PROD_BRANCH_ID and the prod DB_* / PLANETSCALE_DATABASE_URL.`;
      console.error(msg);
      const webhook = process.env.OBSERVATIONS_ALERT_WEBHOOK_URL;
      if (webhook) {
        // Shared-webhook policy: every message carries its environment (lib/env.ts).
        void fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `🔴 [${envLabel()}] ${msg}` }),
        }).catch(() => {});
      }
    }
    return;
  }

  // dev/preview. Fail-closed: refuse to touch prod.
  if (process.env.ALLOW_PROD_DB_IN_DEV === "true") return;
  if (onProdDb) {
    throw new Error(
      `[PlanetScale] Refusing to use the PRODUCTION database (${identity}) outside production. ` +
        `Point PLANETSCALE_DATABASE_URL at liveone-dev, or set ALLOW_PROD_DB_IN_DEV=true to override.`,
    );
  }
}

/**
 * Create or get the connection pool.
 * Returns null if not configured.
 */
function getPool(): Pool | null {
  const config = getPoolConfig();
  if (!config) {
    return null;
  }

  if (global.__planetscalePool) {
    return global.__planetscalePool;
  }

  // Run once per pool creation (not on memoized returns) so the prod drift alert
  // doesn't repeat; in dev the throw fires before any pool is memoized anyway.
  assertDbEnvironmentMatches(config);

  const pool = new Pool({
    ...config,
    // `max` is the PER-INSTANCE connection cap. The real budget is
    // max × concurrent warm server instances ≤ the Postgres connection limit,
    // so keep it env-tunable for Sydney/cutover sizing (default unchanged).
    max: Number(process.env.PLANETSCALE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Log connection errors
  pool.on("error", (err) => {
    console.error("[PlanetScale] Pool error:", err);
  });

  // Memoize on `global` in ALL environments. This was previously guarded by
  // NODE_ENV !== "production", so warm production Lambdas — and every
  // isPlanetscaleConfigured() call, which re-invokes getPool() — allocated a
  // fresh Pool, multiplying connections without bound. One pool per instance
  // is correct everywhere.
  global.__planetscalePool = pool;

  return pool;
}

/**
 * PlanetScale Drizzle database instance.
 * Returns null if PLANETSCALE_DATABASE_URL is not set.
 */
export const planetscaleDb = (() => {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  if (global.__planetscaleDb) {
    return global.__planetscaleDb;
  }

  const db = drizzle(pool, { schema });

  // Memoize unconditionally (see getPool) so a warm instance reuses one client.
  global.__planetscaleDb = db;

  return db;
})();

/**
 * Postgres is the sole store, so almost every read/write path requires a configured
 * connection. This returns the non-null Drizzle client or throws a clear error — the
 * replacement for the old `if (!planetscaleDb)` fallback guards.
 */
export function requirePlanetscaleDb(): NonNullable<typeof planetscaleDb> {
  if (!planetscaleDb) {
    throw new Error(
      "[PlanetScale] Database is not configured (PLANETSCALE_DATABASE_URL / DB_* unset)",
    );
  }
  return planetscaleDb;
}

/**
 * Check if PlanetScale is configured and connected.
 */
export async function isPlanetscaleConfigured(): Promise<boolean> {
  if (!planetscaleDb) {
    return false;
  }

  try {
    // Reuses the memoized pool (getPool no longer allocates a second one).
    const pool = getPool();
    if (!pool) return false;

    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch (error) {
    console.error("[PlanetScale] Connection test failed:", error);
    return false;
  }
}

// Export schema
export * from "./schema";
export { schema };
