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
import { isProduction } from "@/lib/env";

// Global singleton to persist across hot reloads
declare global {
  // eslint-disable-next-line no-var
  var __planetscalePool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __planetscaleDb: ReturnType<typeof drizzle> | undefined;
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
    return { connectionString: url };
  }

  const host = process.env.DB_HOST;
  if (host) {
    const sslDisabled = ["0", "false", "disable", "disabled"].includes(
      (process.env.DB_SSL ?? "").toLowerCase(),
    );
    return {
      host,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      // Managed Postgres requires TLS. Default to encrypted-without-strict-CA,
      // which works across providers; set DB_SSL=disable for a local server.
      ssl: sslDisabled ? false : { rejectUnauthorized: false },
    };
  }

  return null;
}

/** The host[:port] a PoolConfig points at, for the prod-in-dev guard. */
function hostOf(config: PoolConfig): string | undefined {
  if (typeof config.connectionString === "string") {
    try {
      return new URL(config.connectionString).host;
    } catch {
      return undefined;
    }
  }
  if (config.host) {
    return config.port ? `${config.host}:${config.port}` : config.host;
  }
  return undefined;
}

/**
 * Guard a shared PlanetScale dev branch from clobbering production: outside
 * production, refuse to connect if the resolved host is the declared production
 * host. Inert until `PLANETSCALE_PRODUCTION_HOST` is set (so the guard can be
 * armed in dev by recording the prod host — a hostname, not a credential).
 * `ALLOW_PROD_DB_IN_DEV=true` is an explicit escape hatch.
 */
function assertNotProdDbInDev(config: PoolConfig): void {
  if (isProduction()) return;
  const prodHost = process.env.PLANETSCALE_PRODUCTION_HOST;
  if (!prodHost) return;
  if (process.env.ALLOW_PROD_DB_IN_DEV === "true") return;
  const host = hostOf(config);
  if (host && host.toLowerCase().includes(prodHost.toLowerCase())) {
    throw new Error(
      `[PlanetScale] Refusing to use the PRODUCTION database (${host}) outside production. ` +
        `Point PLANETSCALE_DATABASE_URL at the dev branch, or set ALLOW_PROD_DB_IN_DEV=true to override.`,
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

  assertNotProdDbInDev(config);

  if (global.__planetscalePool) {
    return global.__planetscalePool;
  }

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
