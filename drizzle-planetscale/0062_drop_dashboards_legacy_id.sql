-- `dashboards_legacy_id_unique` is a CONSTRAINT (config-transform stage 5d ran
-- `ADD CONSTRAINT … UNIQUE`), not a bare index. drizzle-kit models it as `uniqueIndex()` and so
-- generated `DROP INDEX`, which Postgres refuses while the index backs a constraint:
--   cannot drop index … because constraint … on table dashboards requires it
-- Hand-corrected to DROP CONSTRAINT, which takes the backing index with it. Measured against prod;
-- the generated form failed on its first statement, so nothing was applied.
ALTER TABLE "dashboards" DROP CONSTRAINT "dashboards_legacy_id_unique";--> statement-breakpoint
ALTER TABLE "dashboards" DROP COLUMN "legacy_id";
