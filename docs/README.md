# Docs index

> Conventions: every doc carries a status line (`current` / `historical record` / `plan`).
> Hand-written docs hold **semantics, invariants, and decisions** — the _why_. The _what_
> (schema columns, route lists) lives in code; docs point at it rather than duplicating it.
> Deleted docs live in git history; we don't keep an archive directory.

## Canonical (read these first)

- [architecture/overview.md](architecture/overview.md) — orientation: stack, data path, vendor table, glossary
- [architecture/engine-web-separation.md](architecture/engine-web-separation.md) — **direction of travel**: ingest durability (outbox), engine/web split; locked decisions
- [architecture/data-model.md](architecture/data-model.md) — data semantics & invariants; schema source of truth is `lib/db/planetscale/schema.ts`
- [turso-pg-migration.md](turso-pg-migration.md) — Turso→Postgres migration state, phases, runbooks
- [architecture/api.md](architecture/api.md) — API conventions, external contracts, route inventory

## Reference

- [architecture/points.md](architecture/points.md) — point model: paths, identity, composite rules
- [architecture/authentication.md](architecture/authentication.md) — Clerk, roles, API auth functions
- [architecture/kv-store.md](architecture/kv-store.md) — KV cache keys, subscription registry
- [architecture/load-calcs.md](architecture/load-calcs.md) — "rest of house" load calculation
- [architecture/energy-flow-matrix.md](architecture/energy-flow-matrix.md) — energy-flow (Sankey) matrix: logical systems, daily materialization, serving paths
- [observations-qstash-payloads.md](observations-qstash-payloads.md) — queue message formats, receiver behaviour
- [migrations.md](migrations.md) — migration safety practices and lessons learned
- [amber-sync-plan.md](amber-sync-plan.md) — Amber sync/audit design
- [tesla.md](tesla.md) — Tesla vendor adapter spec
- [backfill-turso-to-postgres.md](backfill-turso-to-postgres.md) — re-runnable Turso→PG backfill tool
- vendors/ — [enphase-api.md](vendors/enphase-api.md) · [enphase-integration.md](vendors/enphase-integration.md) · [enphase-testing.md](vendors/enphase-testing.md) (historical — mock removed 2026-06-10) · [fronius-push-spec.md](vendors/fronius-push-spec.md) · [selectronic.md](vendors/selectronic.md)

## Deferred work

- [deferred/generator-events-rewrite.md](deferred/generator-events-rewrite.md) — bounded-range rewrite owed before its PG migration
- [deferred/history-api-unification-plan.md](deferred/history-api-unification-plan.md) — unify composite/non-composite history paths
- [deferred/postgres-integration-test-harness.md](deferred/postgres-integration-test-harness.md) — re-point Turso-seeded/flag-gated test suites to Postgres (Phase 5)

## Records (append-only; never "stale")

- [project-history.md](project-history.md) — feature/architecture timeline
- [why-not-all-data-has-been-going-into-pg.md](why-not-all-data-has-been-going-into-pg.md) — root-cause analysis of PG mirror gaps
- incidents/ — [2025-11-11 migration 0035](incidents/2025-11-11-migration-0035-point-readings-corruption.md) · [2025-11-17 migration 0016](incidents/2025-11-17-migration-0016-point-info-corruption.md)

## Removed 2026-06-10 (in git history if needed)

`ARCHITECTURE.md` (pre-PG; replaced by overview.md), `SCHEMA.md` + `DEPRECATED_SCHEMA.md`
(replaced by data-model.md + Drizzle schema), `API.md` (replaced by slim api.md),
`to-clean/` (executed/superseded plans), `fronius-modbus-vs-solar-api.md` (Modbus rejected),
`energy-analysis-2025-11-27.md` (one-off report).
