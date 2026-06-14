# Docs index

> Conventions: every doc carries a status line (`current` / `historical record` / `plan`).
> Hand-written docs hold **semantics, invariants, and decisions** — the _why_. The _what_
> (schema columns, route lists) lives in code; docs point at it rather than duplicating it.
> Deleted docs live in git history; we don't keep an archive directory.

## Canonical (read these first)

- [architecture/overview.md](architecture/overview.md) — orientation: stack, data path, vendor table, glossary
- [architecture/engine-web-separation.md](architecture/engine-web-separation.md) — **direction of travel**: ingest durability (outbox), engine/web split; locked decisions
- [architecture/data-model.md](architecture/data-model.md) — data semantics & invariants; schema source of truth is `lib/db/planetscale/schema.ts`
- [turso-pg-migration.md](turso-pg-migration.md) — historical record of the completed Turso→Postgres migration (phases, runbooks)
- [architecture/api.md](architecture/api.md) — API conventions, external contracts, route inventory

## Devices (vendor/system integrations)

- [devices/README.md](devices/README.md) — **anatomy of a device integration**: the shared building blocks every adapter follows + the device-doc template and add-a-device checklist
- [devices/open-electricity.md](devices/open-electricity.md) — OpenElectricity (NEM): regional emissions intensity / spot price / renewable proportion (poll, 5m-native, dynamic cadence)

## Reference

- [architecture/points.md](architecture/points.md) — point model: paths, identity, composite rules
- [architecture/areas-and-dashboards.md](architecture/areas-and-dashboards.md) — **proposed** redesign: split physical/semantic/presentation into Systems → Areas → Dashboards (HA-aligned, Apple-Home UX); replaces composite-as-system
- [architecture/authentication.md](architecture/authentication.md) — Clerk, roles, API auth functions
- [architecture/kv-store.md](architecture/kv-store.md) — KV cache keys, subscription registry
- [architecture/load-calcs.md](architecture/load-calcs.md) — "rest of house" load calculation
- [architecture/energy-flow-matrix.md](architecture/energy-flow-matrix.md) — energy-flow (Sankey) matrix: logical systems, daily materialization, serving paths
- [observations-qstash-payloads.md](observations-qstash-payloads.md) — queue message formats, receiver behaviour
- [migrations.md](migrations.md) — migration safety practices and lessons learned
- [amber-sync-plan.md](amber-sync-plan.md) — Amber sync/audit design
- [tesla.md](tesla.md) — Tesla vendor adapter spec
- [tesla-api-brief.md](tesla-api-brief.md) — Owner API → Fleet API re-platform decision brief (signing exemption, charge-control path)
- [old-database-admin.md](old-database-admin.md) — historical notes for rebuilding the stripped `/admin/readings` database admin tools
- vendors/ — [enphase-api.md](vendors/enphase-api.md) · [enphase-integration.md](vendors/enphase-integration.md) · [enphase-testing.md](vendors/enphase-testing.md) (historical — mock removed 2026-06-10) · [fronius-push-spec.md](vendors/fronius-push-spec.md) · [selectronic.md](vendors/selectronic.md)

## Plans (proposed — not yet started)

- [plans/chart-card-generalization.md](plans/chart-card-generalization.md) — merge the two chart components (EnergyChart lines + SitePowerChart stacked-areas) into one instance-id'd `chart` card so a dashboard can show either or both; next phase after the P1–P7 card-uniformity work
- [plans/composite-fast-cache.md](plans/composite-fast-cache.md) — make a newly-mapped composite point's card appear instantly on save (prototyped + reverted)
- [plans/timestamptz-migration.md](plans/timestamptz-migration.md) — migrate time-series time columns to `timestamptz` (needs schema-change approval)

## Deferred work

- [deferred/generator-events-rewrite.md](deferred/generator-events-rewrite.md) — bounded-range rewrite owed before its PG migration
- [deferred/history-api-unification-plan.md](deferred/history-api-unification-plan.md) — unify composite/non-composite history paths
- [deferred/postgres-integration-test-harness.md](deferred/postgres-integration-test-harness.md) — re-point legacy-seeded/flag-gated test suites to Postgres

## Records (append-only; never "stale")

- [project-history.md](project-history.md) — feature/architecture timeline
- incidents/ — [2025-11-11 migration 0035](incidents/2025-11-11-migration-0035-point-readings-corruption.md) · [2025-11-17 migration 0016](incidents/2025-11-17-migration-0016-point-info-corruption.md)

## Removed 2026-06-10 (in git history if needed)

`ARCHITECTURE.md` (pre-PG; replaced by overview.md), `SCHEMA.md` + `DEPRECATED_SCHEMA.md`
(replaced by data-model.md + Drizzle schema), `API.md` (replaced by slim api.md),
`to-clean/` (executed/superseded plans), `fronius-modbus-vs-solar-api.md` (Modbus rejected),
`energy-analysis-2025-11-27.md` (one-off report).
