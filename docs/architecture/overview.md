# Architecture Overview

> **Status:** current — last verified 2026-06-10.
> Replaces the old `ARCHITECTURE.md` (deleted 2026-06-10; in git history), most of which
> described the pre-Postgres world. This is deliberately short: it orients you and points at
> the docs that own each area. For where the architecture is _heading_, read
> [engine-web-separation.md](engine-web-separation.md) — that doc is canonical for the data
> path and the engine/web split.

## What LiveOne is

A multi-vendor energy monitoring platform: it polls (or receives pushes from) solar inverter,
battery, EV, and electricity-market APIs, normalises everything into a **point-based data
model**, and serves dashboards with live values, time-series charts, and energy-flow
visualisations. Virtual **composite systems** combine points across real systems.

## Stack (as deployed)

- **App:** Next.js 15 (App Router), single Vercel deployment, region `syd1`. shadcn/ui,
  Recharts, Clerk for auth, Drizzle ORM, Jest.
- **DB:** PostgreSQL 17 on PlanetScale (`sydney` branch, `aws-ap-southeast-2`,
  3-node HA) — the sole store: serving store, config authority, and raw-durability outbox.
- **Queue:** Upstash QStash — decoupling transport for observations.
- **Cache:** Vercel KV (Upstash Redis) — latest point values, composite subscription
  registry ([kv-store.md](kv-store.md)).
- **Cron:** Vercel Cron (minutely poll, daily aggregation, outbox relay, monitors).

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
- Push vendors (`fusher`) enter via webhook instead of poll; 5m-native vendors (Amber,
  Enphase) upsert straight into the 5m table.
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
| tesla           | poll (OAuth, charge-aware cadence) | EVs; [../tesla.md](../tesla.md)                                                                                         |
| mondo           | poll                               |                                                                                                                         |
| composite       | never polled                       | Virtual aggregation ([data-model.md](data-model.md))                                                                    |

## Where each area is documented

| Area                                                     | Doc                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Direction of travel, ingest durability, engine/web split | [engine-web-separation.md](engine-web-separation.md)                     |
| Data model semantics & invariants                        | [data-model.md](data-model.md)                                           |
| Schema (columns/indexes)                                 | `lib/db/planetscale/schema.ts` (source of truth)                         |
| API conventions & route inventory                        | [api.md](api.md)                                                         |
| Points model (paths, identity, composite rules)          | [points.md](points.md)                                                   |
| Auth (Clerk, roles, API auth functions)                  | [authentication.md](authentication.md)                                   |
| KV cache keys & registry                                 | [kv-store.md](kv-store.md)                                               |
| "Rest of house" load calculations                        | [load-calcs.md](load-calcs.md)                                           |
| Historical: the completed Turso→Postgres migration       | [../turso-pg-migration.md](../turso-pg-migration.md)                     |
| Queue payload formats                                    | [../observations-qstash-payloads.md](../observations-qstash-payloads.md) |
| Migration safety practices                               | [../migrations.md](../migrations.md)                                     |

## Glossary

- **System** — one monitored installation from one vendor; **composite system** — virtual
  system aggregating points from others.
- **Point** — one metric stream (e.g. solar power); identified by `(system_id, point_id)`,
  addressed by logical path (`source.solar/power`).
- **Session** — one vendor communication attempt, success or failure.
- **Observation / QueueMessage** — the published unit of collected data, materialised by the
  receiver.
- **Outbox** — durable PG copy of each `QueueMessage`, relayed to QStash.
- **5m-native** — vendor data that arrives as 5-minute intervals rather than instantaneous
  samples.
- **measurement vs received vs created time** — device clock vs fetch time vs PG ingest time.
