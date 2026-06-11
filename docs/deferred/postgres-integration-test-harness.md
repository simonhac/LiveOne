# Re-point test harnesses to Postgres (Turso decommissioned)

> **Status:** deferred — recorded during Phase 5 Turso removal, 2026-06-11.

Phase 5 deleted the Turso client (`@/lib/db/turso`), the migration seams
(`lib/db/config-shadow.ts`, `lib/db/readings-serve.ts`), and the staged-migration flags
(`CONFIG_*`, `READINGS_READS_FROM_PG`, `AGG_COMPUTE_IN_PG`, `WRITE_OUTBOX`). Several tests
seeded/mocked Turso or exercised those flags. The pure-deletion and import-swap cases were
fixed in place; the cases below were **skipped** (not deleted) because a faithful re-point
depends on source contracts that settle as part of the Phase 5 source rewrite — once those
land, un-skip and re-pin against the real Postgres behaviour.

## Skipped suites and why

- **`lib/__tests__/session-manager.test.ts` → `describe.skip` "SessionManager.createSession
  (UUIDv7 / text id)".** These asserted the exact record written via
  `db.insert(sessions).values(...)` on the **Turso** client. `createSession` no longer writes
  Turso; the authoritative write goes to Postgres / the publish path, whose mockable shape is
  part of the source rewrite. The UUIDv7 minting is unchanged and the graceful-degrade read
  suite still runs. **To do:** re-point the write-capture mock to `@/lib/db/planetscale` (or the
  publish collector) and re-assert id persistence.

- **`app/api/observations/__tests__/receive.test.ts` → `describe.skip` "processQueueMessage (5m
  conflict mode depends on vendor)"; the trailing flag-gated `AGG_COMPUTE_IN_PG` describe was
  removed.** With `AGG_COMPUTE_IN_PG` retired, the receiver's raw-vendor-5m + all-1d trim is now
  **unconditional** (the prod flag-on behaviour became permanent), so "raw vendor 5m
  first-write-wins" and "1d stays upsert" no longer hold. **To do:** re-pin to the unconditional
  intake matrix — raw-vendor 5m dropped (no `agg_5m` insert); any 1d dropped; 5m-native 5m
  upserts; raw + sessions unchanged. (The transaction-ordering / dual-shape describe is
  unaffected and still runs.)

- **`lib/point/__tests__/point-manager-agg5m-publish-gate.test.ts` — rewritten, not skipped.**
  The `AGG_COMPUTE_IN_PG` flag matrix was replaced with the surviving _unconditional_ gate
  (`skip publish ⇔ !isFiveMinuteNativeVendor`). The Turso upsert mock was removed (Phase 5 drops
  the Turso write from `insertPointReadingsAgg5m`). Listed here for traceability only.

## Re-pointed (no longer Turso), for the record

- **`app/api/system/__tests__/point.integration.test.ts`** — the point lookup was re-pointed
  from the Turso `db` to `@/lib/db/planetscale` (`planetscaleDb`) + the PG `pointInfo` schema. The
  PG schema mirrors the same fields the seed reads (`systemId`, `index`, `displayName`, `active`,
  `transform`), so it was a drop-in `.select().from().where().limit()` swap rather than a skip.
