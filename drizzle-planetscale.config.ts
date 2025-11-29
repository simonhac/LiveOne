import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit configuration for PlanetScale PostgreSQL
 *
 * Usage:
 *   npx drizzle-kit push --config=drizzle-planetscale.config.ts
 *   npx drizzle-kit generate --config=drizzle-planetscale.config.ts
 *
 * Requires PLANETSCALE_DATABASE_URL_MIGRATIONS env var (with DDL permissions)
 */
export default {
  schema: "./lib/db/planetscale/schema.ts",
  out: "./drizzle-planetscale",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS!,
  },
  verbose: true,
  strict: true,
} satisfies Config;
