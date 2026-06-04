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

  const pool = new Pool({
    ...config,
    // PgBouncer-friendly settings
    max: 10, // Max connections in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Log connection errors
  pool.on("error", (err) => {
    console.error("[PlanetScale] Pool error:", err);
  });

  if (process.env.NODE_ENV !== "production") {
    global.__planetscalePool = pool;
  }

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

  if (process.env.NODE_ENV !== "production") {
    global.__planetscaleDb = db;
  }

  return db;
})();

/**
 * Check if PlanetScale is configured and connected.
 */
export async function isPlanetscaleConfigured(): Promise<boolean> {
  if (!planetscaleDb) {
    return false;
  }

  try {
    // Simple query to test connection
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
