/**
 * PlanetScale PostgreSQL Database Connection
 *
 * Separate Drizzle client for PlanetScale, used by the queue receiver
 * to insert observations and sessions.
 *
 * Gracefully degrades if not configured (returns null).
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Global singleton to persist across hot reloads
declare global {
  // eslint-disable-next-line no-var
  var __planetscalePool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __planetscaleDb: ReturnType<typeof drizzle> | undefined;
}

/**
 * Get the PlanetScale database URL.
 * Returns null if not configured.
 */
function getDatabaseUrl(): string | null {
  return process.env.PLANETSCALE_DATABASE_URL || null;
}

/**
 * Create or get the connection pool.
 * Returns null if not configured.
 */
function getPool(): Pool | null {
  const url = getDatabaseUrl();
  if (!url) {
    return null;
  }

  if (global.__planetscalePool) {
    return global.__planetscalePool;
  }

  const pool = new Pool({
    connectionString: url,
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
