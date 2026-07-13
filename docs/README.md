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
- [architecture/home-assistant-comparison.md](architecture/home-assistant-comparison.md) — LiveOne vs Home Assistant: object-model mapping, where each is clearer, and where ours is superior (durable pipeline vs in-memory control plane)
- [architecture/areas-and-dashboards.md](architecture/areas-and-dashboards.md) — **foundation live** + roadmap: splits physical/semantic/presentation into Systems → Areas → Dashboards (HA-aligned, Apple-Home UX); composites are now areas-backed virtual systems. Roadmap: sharing hardening (done), the first-class/multi-area dashboards keystone (per-card `area_id` + default-dashboard), HA export
- [architecture/authentication.md](architecture/authentication.md) — Clerk, roles, API auth functions
- [architecture/kv-store.md](architecture/kv-store.md) — KV cache keys, subscription registry
- [sync-prod-to-dev.md](sync-prod-to-dev.md) — keeping `liveone-dev` fresh: the 2-hourly prod→dev DB top-up + KV rebuild-from-DB (`db:sync-dev-db` / `db:rebuild-dev-kv`)
- [architecture/load-calcs.md](architecture/load-calcs.md) — "rest of house" load calculation
- [architecture/energy-flow-matrix.md](architecture/energy-flow-matrix.md) — energy-flow (Sankey) matrix: logical systems, daily materialization, serving paths
- [architecture/battery-provenance.md](architecture/battery-provenance.md) — metric-attributed flows: emissions/renewable/cost traced through the battery (weighted-average blend), the "helper" derived-device-in-an-Area, the attribution rollup, and `?source=modern` on the Sankey endpoint
- [observations-qstash-payloads.md](observations-qstash-payloads.md) — queue message formats, receiver behaviour
- [migrations.md](migrations.md) — migration safety practices and lessons learned
- [amber-sync-plan.md](amber-sync-plan.md) — Amber sync/audit design
- [tesla.md](tesla.md) — Tesla vendor adapter spec
- [tesla-api-brief.md](tesla-api-brief.md) — Owner API → Fleet API re-platform decision brief (signing exemption, charge-control path)
- [old-database-admin.md](old-database-admin.md) — historical notes for rebuilding the stripped `/admin/readings` database admin tools
- vendors/ — [enphase-api.md](vendors/enphase-api.md) · [enphase-integration.md](vendors/enphase-integration.md) · [enphase-testing.md](vendors/enphase-testing.md) (historical — mock removed 2026-06-10) · [fronius-push-spec.md](vendors/fronius-push-spec.md) · [selectronic.md](vendors/selectronic.md)

## Operations

- [operations.md](operations.md) — monitoring signals & the Slack alert catalog (what each alert means + first triage)

## Plans (proposed — not yet started)

- [plans/timestamptz-migration.md](plans/timestamptz-migration.md) — migrate time-series time columns to `timestamptz` (needs schema-change approval)
- [plans/identity-address-split-and-labels.md](plans/identity-address-split-and-labels.md) — two HA-borrowings: split point identity from address (`point_uid`) + a Label orthogonal tag dimension (needs schema-change approval)

## Deferred work

- [deferred/postgres-integration-test-harness.md](deferred/postgres-integration-test-harness.md) — re-point legacy-seeded/flag-gated test suites to Postgres

## Records (append-only; never "stale")

- [project-history.md](project-history.md) — feature/architecture timeline
- incidents/ — [2025-11-11 migration 0035](incidents/2025-11-11-migration-0035-point-readings-corruption.md) · [2025-11-17 migration 0016](incidents/2025-11-17-migration-0016-point-info-corruption.md)
