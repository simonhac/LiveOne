# Old Database Admin

Status: historical record.

This document records the old `/admin/readings` database admin surface that was stripped back after the Turso/SQLite decommission. Use it as a map for rebuilding a smaller Postgres-native tool, not as a target to restore wholesale.

## What It Did

The page was a catch-all operations panel for the Turso-era database:

- Showed database environment/provider status, table record counts, created/updated ranges, SQLite size estimates, and growth rates.
- Displayed cache timestamps for `SystemsManager`, `PointManager`, and precomputed DB stats.
- Opened a toolbox with actions to recreate daily aggregates, refresh database size snapshots, invalidate in-process caches, and clear latest-readings KV cache.
- In development, opened a sync modal that previewed and streamed a production Turso to local SQLite sync.
- Polled the storage endpoint every 10 seconds so cache/stat state appeared live.

## Files To Mine

These files held the old UI and API behavior. If they have been deleted or reduced, mine them from git history before the strip-back commit.

- `app/admin/readings/page.tsx` - admin auth gate and wiring for the old client UI.
- `app/admin/readings/StorageTools.tsx` - main client UI for database tables, cache status, toolbox actions, sync orchestration, and polling.
- `app/admin/readings/SyncModal.tsx` - streaming sync progress modal and stage log UI.
- `app/api/admin/storage/route.ts` - old SQLite/Turso storage stats response and `force-reload-caches` POST action.
- `app/api/admin/sync-database/route.ts` - streamed dev database sync endpoint.
- `app/api/admin/sync-database/stages.ts` - old sync stage definitions and progress messages.
- `app/api/cron/db-stats/route.ts` - SQLite `dbstat` snapshot calculation and historical backfill action.
- `app/api/cron/daily/route.ts` and `lib/aggregation/daily-points.ts` - daily aggregate regeneration entry point and current Postgres aggregation implementation.
- `app/api/admin/latest/route.ts` - latest-readings cache clearing action that is still useful independently.
- `lib/systems-manager.ts` and `lib/point/point-manager.ts` - cache invalidation APIs used by the old admin action.

## Rebuild Notes

A replacement should be Postgres-native and narrower:

- Use Postgres catalog functions such as `pg_database_size`, `pg_total_relation_size`, and `pg_stat_user_tables` rather than reviving SQLite `dbstat` snapshots.
- Keep cache invalidation as an explicit admin action if operators still need it.
- Treat dev seeding as a new Postgres-to-dev workflow; do not reuse the Turso sync route shape without rethinking safety and data scope.
- Keep long-running operations streamed or job-backed, but separate them from the storage overview so the page remains reliable.
- Prefer a clear retired/empty state over returning `success: true` for actions that no longer do anything.
