# Architecture Overview

> **Status:** current — last verified 2026-08-01, at the close of the config-v4 epic.
> Replaces the old `ARCHITECTURE.md` (deleted 2026-06-10; in git history), most of which
> described the pre-Postgres world. This is deliberately short: it orients you and points at
> the docs that own each area. For where the architecture is _heading_, read
> [engine-web-separation.md](engine-web-separation.md) — that doc is canonical for the data
> path and the engine/web split.

## What LiveOne is

A multi-vendor energy monitoring platform: it polls (or receives pushes from) solar inverter,
battery, EV, and electricity-market APIs, normalises everything into a **point-based data
model**, and serves dashboards with live values, time-series charts, and energy-flow
visualisations. An **Area** groups 1..N devices into a site, and is the unit most of the
product reasons about.

## Stack (as deployed)

- **App:** Next.js 15 (App Router), single Vercel deployment, region `syd1`. shadcn/ui,
  Chart.js + modular d3 for charts, TanStack React Query, Clerk for auth, Drizzle ORM, Jest.
- **DB:** PostgreSQL 17 on PlanetScale (`sydney` branch, `aws-ap-southeast-2`,
  3-node HA) — the sole store: serving store, config authority, and raw-durability outbox.
- **Queue:** Upstash QStash — decoupling transport for observations.
- **Cache:** Vercel KV (Upstash Redis) — latest point values, area subscription
  registry ([kv-store.md](kv-store.md)).
- **Cron:** Vercel Cron, 8 jobs (`vercel.json` is the schedule of record): minutely poll,
  outbox relay, derivations, daily aggregation, Sigenergy backfill, DB stats, queue monitor,
  and the weekly coverage repair.
- **On-site:** a Fly.io hub (`packages/usher`) fronts LAN-only push devices (DeepSea), which
  reach the app through `POST /api/gush`.

## The data path

```
vendor APIs ──poll (cron/minutely)──► vendor adapters ──► poll collector / publisher
                                                                │
                                              ┌─────────────────┴──────────────────┐
                                              ▼                                     ▼
                                     observations_outbox                     QStash enqueue
                                            (PG)                                    │
                                              │                                     ▼
                                     relay-outbox cron ──────────► /api/observations/receive
                                                                    (single writer, idempotent)
                                                                            │
                                                                            ▼
                                              PG: point_readings + agg_5m upsert
                                                  (agg_1d via daily cron)
                                                                            │
                                                                            ▼
                                              KV latest-values cache ──► dashboards
```

Key properties (invariants and semantics in [data-model.md](data-model.md)):

- **Collection never writes the serving store.** Polls publish `QueueMessage`s; the receiver
  materialises them. The queue is transport; the **outbox** is the durability anchor.
- Aggregation: raw → 5m (order-independent, recomputed as data arrives) → 1d (00:05 local).
- Push vendors enter via webhook instead of poll — `fusher` direct, `deepsea` via the Fly hub;
  5m-native vendors (Amber, Enphase, Sigenergy, OpenElectricity) upsert straight into the 5m table.
- Every vendor interaction is recorded as a **session** (UUIDv7) for observability.

## Vendor integration

Adapters live in `lib/vendors/<vendor>/`, registered in `lib/vendors/registry.ts`, sharing
`base-adapter.ts` / `types.ts`. Each adapter owns auth, fetching, mapping to point metadata,
and error normalisation.

| Vendor          | Mode                               | Notes                                                                                                                   |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| selectronic     | poll (minutely)                    | select.live; [../vendors/selectronic.md](../vendors/selectronic.md)                                                     |
| enphase         | poll (OAuth, 5m-native)            | [../vendors/enphase-integration.md](../vendors/enphase-integration.md)                                                  |
| fusher          | push webhook                       | Fronius pusher, renamed from `fronius` (alias kept); [../vendors/fronius-push-spec.md](../vendors/fronius-push-spec.md) |
| amber           | poll (5m-native)                   | Electricity market data; [../amber-sync-plan.md](../amber-sync-plan.md)                                                 |
| openelectricity | poll (5m-native, dynamic cadence)  | NEM regional emissions intensity/price/renewables; [../devices/open-electricity.md](../devices/open-electricity.md)     |
| sigenergy       | poll (5m-native)                   | Inverter/battery/EV charger; has a range-backfill primitive                                                             |
| deepsea         | push (LAN)                         | DSE7410 genset controller over Modbus, via the Fly hub → `/api/gush`                                                    |
| tesla           | poll (OAuth, charge-aware cadence) | EVs, plus the one command path (charge start/stop/limit); [../tesla.md](../tesla.md)                                    |
| mondo           | poll                               |                                                                                                                         |
| helper          | never polled                       | A derived, non-physical device inside an Area that owns computed points ([battery-provenance.md](battery-provenance.md)) |

The `composite` vendor was **retired**: a multi-device Area is not a vendor connection, so it has no
adapter. Anything that used to be a composite system is now an Area with members and bindings.

## Where each topic is documented

("Topic", not "Area" — an Area is a domain object here, see the glossary.)

| Topic                                                       | Doc                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| Direction of travel, ingest durability, engine/web split    | [engine-web-separation.md](engine-web-separation.md)                     |
| Data model semantics & invariants; point paths and metrics  | [data-model.md](data-model.md)                                           |
| Schema (columns/indexes)                                    | `lib/db/planetscale/schema.ts` (source of truth)                         |
| The three-layer split: devices → areas → dashboards         | [areas-and-dashboards.md](areas-and-dashboards.md)                       |
| API conventions & external contracts                        | [api.md](api.md)                                                         |
| Authorization model (ownership, access levels, share scope) | [authentication.md](authentication.md)                                   |
| KV cache keys & subscription registry                       | [kv-store.md](kv-store.md)                                               |
| Energy-flow (Sankey) matrix                                 | [energy-flow-matrix.md](energy-flow-matrix.md)                           |
| Metric-attributed flows (emissions/renewable/cost)          | [battery-provenance.md](battery-provenance.md)                           |
| Weekly gap self-heal for re-fetchable vendors               | [coverage-repair.md](coverage-repair.md)                                 |
| "Rest of house" load calculations                           | [load-calcs.md](load-calcs.md)                                           |
| Hero-number and unit typography on cards                    | [number-typography.md](number-typography.md)                             |
| Why the config layer looks like this (config-v4)            | [../plans/completed/config-v4-clean-sheet.md](../plans/completed/config-v4-clean-sheet.md) |
| What config-v4 cost and the traps it taught                 | [../plans/completed/config-v4-execution-plan.md](../plans/completed/config-v4-execution-plan.md) |
| Historical: the completed Turso→Postgres migration          | [../turso-pg-migration.md](../turso-pg-migration.md)                     |
| Queue payload formats                                       | [../observations-qstash-payloads.md](../observations-qstash-payloads.md) |
| Migration safety practices                                  | [../migrations.md](../migrations.md)                                     |

## Glossary

- **Device** — one monitored installation from one vendor (a vendor connection). Was called a
  "system"; `systems` was dropped in config-v4, and `?systemId=N` survives only as a URL alias
  resolved through `legacy_handles`.
- **Area** — a grouping of 1..N member devices, and the sole home for timezone, day offset and
  location. Every device has exactly one primary area; an "area of one" is the same machinery with
  one member. Areas are never polled and do not nest.
- **Point** — one metric stream (e.g. solar power). Identity is `points.id`, a uuid, whose wire form
  is the TypeID `pt_…`; addressed semantically by logical path (`source.solar/power`).
- **TypeID / rid** — every config row has a uuid whose wire form is a prefixed TypeID (`dv_` device,
  `pt_` point, `ar_` area, `db_` dashboard, `dx_` derivation, `bn_` binding). Below the seam the hot
  time-series tables key on a compact integer `rid`. **uuids above, rids below** — see
  [data-model.md](data-model.md).
- **Derivation** — config that computes a new signal from existing points: either a derived point in
  the normal readings pipeline (the HWS thermal model) or run/event periods in `derived_intervals`
  (generator run-tracking).
- **Dashboard** — a named composition; its structure is a recursive node tree of groups and cards in
  `dashboards.doc`.
- **Session** — one vendor communication attempt, success or failure, archiving the raw payload.
- **Observation / QueueMessage** — the published unit of collected data, materialised by the
  receiver.
- **Outbox** — durable PG copy of each `QueueMessage`, relayed to QStash.
- **5m-native** — vendor data that arrives as 5-minute intervals rather than instantaneous
  samples.
- **measurement vs received vs created time** — device clock vs fetch time vs PG ingest time.
