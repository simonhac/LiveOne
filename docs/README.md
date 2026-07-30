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
- [architecture/home-assistant-comparison.md](architecture/home-assistant-comparison.md) — LiveOne vs Home Assistant: object-model mapping, where each is clearer, and where ours is superior (durable pipeline vs in-memory control plane). **Refreshed 2026-07-28** for config-v4 and HA 2026.7
- [architecture/areas-and-dashboards.md](architecture/areas-and-dashboards.md) — the three-layer split (physical `devices`/`points` → semantic `areas`/bindings/`derivations` → presentation `dashboards`), per-role slot resolution, the v4 node-tree document, sharing scope invariants, and the decisions config-v4 **overturned** (the integer handle, lazy areas, dual dashboard shapes). **Rewritten 2026-07-28** for config-v4
- [architecture/number-typography.md](architecture/number-typography.md) — how a hero number binds to its unit on dashboard cards: the tight (`83%`, `40.0°C`) vs hair-spaced-and-muted (`0.0 kW`) split and why, compound units, the no-space-character rule; `classifyUnit` + `<Value>`/`<Stat>` are the source of truth
- [architecture/authentication.md](architecture/authentication.md) — Clerk, roles, API auth functions
- [architecture/kv-store.md](architecture/kv-store.md) — KV cache keys, subscription registry
- [sync-prod-to-dev.md](sync-prod-to-dev.md) — keeping `liveone-dev` fresh: the 2-hourly prod→dev DB top-up + KV rebuild-from-DB (`db:sync-dev-db` / `db:rebuild-dev-kv`)
- [architecture/load-calcs.md](architecture/load-calcs.md) — "rest of house" load calculation
- [architecture/energy-flow-matrix.md](architecture/energy-flow-matrix.md) — energy-flow (Sankey) matrix: logical systems, daily materialization, serving paths
- [architecture/battery-provenance.md](architecture/battery-provenance.md) — metric-attributed flows: emissions/renewable/cost traced through the battery (weighted-average blend), the "helper" derived-device-in-an-Area, the attribution rollup, and `?source=modern` on the Sankey endpoint
- [observations-qstash-payloads.md](observations-qstash-payloads.md) — queue message formats, receiver behaviour
- [architecture/coverage-repair.md](architecture/coverage-repair.md) — **weekly self-heal** for re-fetchable vendors (Amber/OpenElectricity/Sigenergy): two-stage generic gap-find → per-vendor backfill; the provider contract, invariants (scoped recompute, progress-based landing, Amber-unconditional-fetch, OE emissions-intensity excluded), and per-vendor recoverable windows
- [migrations.md](migrations.md) — migration safety practices and lessons learned
- [amber-sync-plan.md](amber-sync-plan.md) — Amber sync/audit design
- [tesla.md](tesla.md) — Tesla vendor adapter spec
- [tesla-api-brief.md](tesla-api-brief.md) — Owner API → Fleet API re-platform decision brief (signing exemption, charge-control path)
- [old-database-admin.md](old-database-admin.md) — historical notes for rebuilding the stripped `/admin/readings` database admin tools
- vendors/ — [enphase-api.md](vendors/enphase-api.md) · [enphase-integration.md](vendors/enphase-integration.md) · [enphase-testing.md](vendors/enphase-testing.md) (historical — mock removed 2026-06-10) · [fronius-push-spec.md](vendors/fronius-push-spec.md) · [selectronic.md](vendors/selectronic.md)

## Operations

- [operations.md](operations.md) — monitoring signals & the Slack alert catalog (what each alert means + first triage)
- [performance/dashboard-fetch-waterfall.md](performance/dashboard-fetch-waterfall.md) — reusable fetch-waterfall benchmark: PROD baseline + post-merge + CPU-tier runs, the Server-Timing phase decomposition (post-#199), and the **cross-region Sydney-vs-Italy** finding (the ~600ms/request floor is `fra1→syd1` network, not app code). Turnkey Sydney re-run harness at `scripts/perf/sydney-lambda/`

## Plans (proposed — not yet started)

- [plans/config-v4-execution-plan.md](plans/config-v4-execution-plan.md) — 🔴 **IN FLIGHT, not proposed** — the config-v4 **execution** plan (the clean-sheet below holds the _why_; this holds the _what's left_). **Phases 0–12 shipped** — registry cutover completed 2026-07-30, `systems`/`point_info`/`polling_status` **dropped**. **Phase 13 next** (kill the integer handle), then 14 (v4-native presentation). Carries the **Traps and rules** list — read it before touching a migration
- [plans/config-v4-phase13-prs.md](plans/config-v4-phase13-prs.md) — **Phase 13 in orchestrator detail**: the six PRs that kill the integer handle, each with a measured inventory, ordered steps, its own proof, and a DO-NOT list. Corrects two errors in the execution plan's one-page version (the synthesis can't be deleted first; `getViewableSystem` no longer exists). Includes the DO-NOT-RENAME list for the `systems`→`devices` sweep — vendor-literal fields, QStash/KV persisted keys, and `subsystem`, which a blind sed corrupts
- [plans/config-v4-clean-sheet.md](plans/config-v4-clean-sheet.md) — **the clean-sheet config model**: one TypeID space (integer handle retired), `systems`→`devices`, eager areas (tz/location area-only, fixed-offset days endorsed), per-role bindings with deterministic slot resolution, trackers generalized to `derivations`, recursive group/card dashboard docs (tile=small card) with whole-doc PUT + revisions, one share-token semantics, one-time cutover migration. **Supersedes** info-producers-consumers + identity-address-split-and-labels and parts of areas-and-dashboards
- [architecture/live-dashboard-roadmap.md](architecture/live-dashboard-roadmap.md) — **SSR-first dashboard load** (Superphase 1: server-render the shell + SSR-prefetch data + precompute `/api/history`), then a phased roadmap to move all device polling to Fly (never-drop-a-poll durability) + an SSE live lane feeding React Query. Includes the adversarial "never drop a poll" **bug register**. Motivated by the [fetch-waterfall](performance/dashboard-fetch-waterfall.md) measurements
- [plans/info-producers-consumers.md](plans/info-producers-consumers.md) — _superseded by config-v4-clean-sheet.md_ — typed-shape **info producers & consumers**: advertise/seek/auto-connect on shape-agreement + explicit Area wiring with priority; kept for the seam map + battery-provenance first-consumer analysis
- [plans/battery-provenance-ops-hardening.md](plans/battery-provenance-ops-hardening.md) — **battery energy provenance** correctness bugs (modern `flow_attr_1d` energy leg diverging from the legacy `flow_1d` Sankey; the `recompute-provenance` API dropping a boundary day per batch — both root-caused & FIXED on this branch) + scoped ops-ergonomics follow-ups (a legacy↔modern consistency monitor, an activate/verify operation, handle→areaId lookup) — surfaced during the 2026-07-13 Daylesford reprice
- [plans/battery-provenance-merge-handoff.md](plans/battery-provenance-merge-handoff.md) — **merge handoff** for the `battery-energy-provenance` branch: pre-merge gates (tests, replay byte-identity, card gallery) + post-merge choreography (deploy verification, the one-time Daylesford re-backfill + 184.2 kWh acceptance, Kinkora `exportTariff`, the ops-hardening "Do" list, unblocking info-producers P2)
- [plans/run-period-provenance.md](plans/run-period-provenance.md) — **per-run cost / CO₂ / renewable share** on `derived_intervals`, accumulated by the recompute rather than derived at render time (which is what dissolved the "one fold per run" blocker). _Shipped for `generator`; the remaining work is the **load-side** provider (EV/pump), which needs a per-interval blended load-path intensity that doesn't exist yet_
- [plans/timestamptz-migration.md](plans/timestamptz-migration.md) — migrate time-series time columns to `timestamptz` (needs schema-change approval)
- [plans/identity-address-split-and-labels.md](plans/identity-address-split-and-labels.md) — _superseded by config-v4-clean-sheet.md_ — split point identity from address (`point_uid`) + a Label orthogonal tag dimension; kept as the argument record
- [plans/ha-parity-and-leapfrog.md](plans/ha-parity-and-leapfrog.md) — **twelve ranked enhancements** measured against Home Assistant, tagged _parity_ (close a real gap: point category, labels, time-weighted means, sub-metering containment, unit classes, generated groups, reauth, composable derivations) or _leapfrog_ (use what HA structurally can't: coverage/confidence surfacing, attribution as a product, a portfolio tier, and pushing recomputed history **into** HA via its statistics-import API). Proposal only — no schema change approved

## Deferred work

- [deferred/postgres-integration-test-harness.md](deferred/postgres-integration-test-harness.md) — re-point legacy-seeded/flag-gated test suites to Postgres

## Records (append-only; never "stale")

- [project-history.md](project-history.md) — feature/architecture timeline
- incidents/ — [2025-11-11 migration 0035](incidents/2025-11-11-migration-0035-point-readings-corruption.md) · [2025-11-17 migration 0016](incidents/2025-11-17-migration-0016-point-info-corruption.md) · [2025-11-26 Amber import channel collision](incidents/2025-11-26-amber-import-channel-collision.md) · [2026-06-16 prod down — migration not applied](incidents/2026-06-16-prod-down-default-dashboard-migration-not-applied.md) · [2026-07-25 prod→dev sync connection dropouts](incidents/2026-07-25-prod-dev-sync-connection-dropouts.md)
