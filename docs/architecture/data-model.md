# Data Model

> **Status:** current — last verified 2026-06-10.
> This doc covers **semantics and invariants only**. For columns, types, and indexes, the
> Drizzle schema is the source of truth — do not duplicate it here:
>
> - **PostgreSQL:** `lib/db/planetscale/schema.ts` (well-commented; read it)

## Stores and their roles

| Store                                                               | Role                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL** (PlanetScale, `sydney` branch, `aws-ap-southeast-2`) | The sole store. Serving store for readings/aggregates/sessions, config authority, and raw-durability outbox.                                      |
| **Vercel KV** (Upstash Redis)                                       | Cache for latest point values and the composite subscription registry. See [kv-store.md](kv-store.md).                                            |
| **QStash**                                                          | Decoupling transport for observations (NOT a durability anchor — that's the outbox). See [engine-web-separation.md](engine-web-separation.md) §6. |

## Table inventory (PG)

| Table                   | One-liner                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systems`               | One row per monitored physical system (a vendor connection). Owner, vendor, status, timezone, metadata. (Multi-device "composite" areas have NO `systems` row — see below.) |
| `polling_status`        | Per-system collection health (last poll/success/error, streaks, counters).                                                                                                  |
| `users`                 | Per-user preferences (default system). Identity itself lives in Clerk.                                                                                                      |
| `user_systems`          | User↔system access grants (`owner`/`admin`/`viewer`).                                                                                                                      |
| `sessions`              | One row per vendor communication session. UUIDv7 text PKs (historical ids are stringified ints).                                                                            |
| `point_info`            | Point registry: identity, physical/logical paths, metric type/unit, display config.                                                                                         |
| `point_readings`        | Raw time-series, one row per point per measurement time.                                                                                                                    |
| `point_readings_agg_5m` | 5-minute aggregates (avg/min/max/last/delta).                                                                                                                               |
| `point_readings_agg_1d` | Daily aggregates, keyed by local-time `day` (YYYY-MM-DD).                                                                                                                   |
| `share_tokens`          | View-only share links (3-word phrases) scoped to an owner's systems.                                                                                                        |
| `observations_outbox`   | Transactional outbox: durable copy of each poll's `QueueMessage`, drained to QStash by the relay cron.                                                                      |

## Invariants

These are load-bearing; don't violate them without updating
[engine-web-separation.md](engine-web-separation.md) first.

1. **The receiver is the single writer of the serving store.** Collection code never writes
   `point_readings` or the aggregates directly — polls publish `QueueMessage`s (via the outbox
   and/or direct enqueue) and `/api/observations/receive` materialises them. Idempotent by
   design: re-delivery is safe.
2. **The outbox carries the message, not the rows.** `observations_outbox.payload` is the same
   `QueueMessage` that goes on the queue, republished verbatim by `app/api/cron/relay-outbox`.
   A direct point-readings write at poll time is explicitly rejected (locked decision,
   2026-06-10).
3. **Point identity** is `(system_id, point_id)`; `point_id` is sequential per system.
   Readings dedup on the unique `(system_id, point_id, measurement_time)`. Points are lazily
   created when first observed; per-system uniqueness on `physical_path_tail` and on
   `(logical_path_stem, metric_type)`.
4. **Aggregation ladder:** raw → 5m (recomputed order-independently as data arrives, safe for
   parallel queue consumption) → 1d (cron at 00:05 local). 5m-native vendors (Amber, Enphase)
   upsert straight into the 5m table; aggregates inherit raw holes.
5. **Almost no FKs in PG.** The receiver inserts without FK validation for performance; the
   one exception is `point_readings.session_id → sessions(id)` (safe because the session row
   is co-enqueued ahead of its readings).

## Semantics

### Timestamps & timezones

- PG uses **native UTC `timestamp` columns** (no timezone). `share_tokens` keeps epoch-ms
  `bigint`s deliberately (the code compares against `Date.now()`).
- `point_readings` carries three times: `measurement_time` (device clock), `received_time`
  (when we fetched it), `created_at` (when it landed in PG — distinguishes live ingestion
  from backfill).
- `systems.timezone_offset_min` is the **fixed standard offset** (e.g. 600 = AEST), no DST —
  used for day boundaries in daily aggregation. `systems.display_timezone` is the IANA zone
  for UI display and **does** observe DST.
- Daily aggregation buckets by local day: `> 00:00 local` to `<= 24:00 local`, keyed as
  YYYY-MM-DD text.

### Units & precision

- Power: Watts (float in point tables).
- Energy: kWh, 3 decimal places (5m-interval energies in Wh where vendor-native).
- Battery SoC: percent, 1 decimal place.

### Data quality

`point_readings.data_quality` ∈ `good` (default) / `error` / `estimated` / `interpolated`.
Readings can carry `value` (numeric), `value_str` (e.g. tariff codes), or `error`.

### Multi-device areas (formerly "composite systems")

A **multi-device Area** groups several physical systems' points into one view (the former "composite").
It is **not** a `systems` row — it is an **areas-backed virtual system**: `SystemsManager` synthesizes one
on demand (runtime `vendor_type = 'composite'`, never polled, no credentials, no nesting), keyed on
`areas.legacy_system_id` (its stable integer handle). Membership and the role→point mapping live in the
**semantic layer**, not `systems.metadata` (that JSON blob is retired):

- **`area_devices`** — the Area's 1..N member devices.
- **`area_bindings`** — typed role→point **overrides**; when present they _select_ the Area's points,
  otherwise the Area defaults to the **union** of its members' own points.

A single-device Area (the former "identity area") is the same machinery with one member and no bindings.
The KV subscription registry maps source points → subscribing handles so latest-value updates fan out. See
[areas-and-dashboards.md](areas-and-dashboards.md) for the full model and [points.md](points.md) for path
grammar.

### Vendor credentials

Stored in **Clerk private metadata** under the owning user — not in the database (locked
decision 2026-06-06). See [authentication.md](authentication.md).

## Legacy: pre-points `readings*` tables

The original fixed-column tables (`readings`, `readings_agg_5m`, `readings_agg_1d`) were
deprecated Nov 2025 and superseded by the point tables. They were never migrated to Postgres
and were retired with the former SQLite store; their full schema is preserved in git
(`docs/DEPRECATED_SCHEMA.md`, deleted 2026-06-10).
