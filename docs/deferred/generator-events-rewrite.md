# Generator events API rewrite

> **Status:** deferred — known hack, recorded 2026-06-10.

`GET /api/system/[systemId]/generator-events` currently does an **unbounded full-history
fetch** plus **N+1 energy queries** (one per event). It was a deliberate shortcut, deferred
out of PR-12 during the Turso→PG readings cutover.

**Must be rewritten to a bounded time-range query (with batched energy lookups) before this
endpoint's data path is migrated to Postgres** — the current shape would be a full-table scan
against `point_readings` in PG.
