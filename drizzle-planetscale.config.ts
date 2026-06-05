import type { Config } from "drizzle-kit";
import * as dotenv from "dotenv";

// Load local env so `npx drizzle-kit push` picks up the DB vars from .env.local.
dotenv.config({ path: ".env.local" });

/**
 * Drizzle Kit configuration for the Postgres database.
 *
 * Workflow (versioned migrations — see drizzle-planetscale/README.md):
 *   npm run db:pg:generate   # diff schema.ts -> a new migration in drizzle-planetscale/
 *   npm run db:pg:migrate    # apply pending migrations (tracked in drizzle.__drizzle_migrations)
 *
 * DO NOT run `drizzle-kit push` against the authoritative Postgres: it diffs and
 * applies destructively with no transaction/row-count validation (the migration-0016
 * failure mode). Use generate + migrate, with the CLAUDE.md migration checklist.
 *
 * Credentials come from EITHER PLANETSCALE_DATABASE_URL_MIGRATIONS (a single
 * connection string with DDL permissions) OR the discrete DB_* vars
 * (DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD).
 */
function resolveDbCredentials() {
  if (process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS) {
    return { url: process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS };
  }
  if (process.env.DB_HOST) {
    const sslDisabled = ["0", "false", "disable", "disabled"].includes(
      (process.env.DB_SSL ?? "").toLowerCase(),
    );
    return {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE ?? "",
      ssl: sslDisabled ? false : { rejectUnauthorized: false },
    };
  }
  // Nothing configured — drizzle-kit will surface a clear connection error.
  return { url: process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS ?? "" };
}

export default {
  schema: "./lib/db/planetscale/schema.ts",
  out: "./drizzle-planetscale",
  dialect: "postgresql",
  dbCredentials: resolveDbCredentials(),
  verbose: true,
  strict: true,
} satisfies Config;
