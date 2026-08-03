# Data Model

> **Status:** current — last verified 2026-08-01, at the close of the config-v4 epic.
> This doc covers **semantics and invariants only**. For columns, types, and indexes, the
> Drizzle schema is the source of truth — do not duplicate it here:
>
> - **PostgreSQL:** `lib/db/planetscale/schema.ts` (well-commented; read it)
>
> The config layer was rebuilt over 2026-07-22 → 2026-08-01 (config-v4). The _why_ is
> [../plans/completed/config-v4-clean-sheet.md](../plans/completed/config-v4-clean-sheet.md); the record of what was done and
> what it cost is [../plans/completed/config-v4-execution-plan.md](../plans/completed/config-v4-execution-plan.md), which
> also carries the **Traps and rules** list — read that before touching a migration.

## Stores and their roles

| Store                                                               | Role                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL** (PlanetScale, `sydney` branch, `aws-ap-southeast-2`) | The sole store. Serving store for readings/aggregates/sessions, config authority, and raw-durability outbox.                                      |
| **Vercel KV** (Upstash Redis)                                       | Cache for latest point values and the composite subscription registry. See [kv-store.md](kv-store.md).                                            |
| **QStash**                                                          | Decoupling transport for observations (NOT a durability anchor — that's the outbox). See [engine-web-separation.md](engine-web-separation.md) §6. |

## Table inventory (PG)

Grouped by the three layers config-v4 established. `lib/db/planetscale/schema.ts` is the source of
truth for every column; these are roles, not schemas.

**Physical — the device/point registry**

| Table          | One-liner                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices`      | One row per monitored device (a vendor connection). Owner, vendor, status, `primary_area_id`, config.                                                                                             |
| `points`       | Point registry: identity, physical/logical paths, metric type/unit, display name. `control` jsonb: NULL = read-only sensor (almost every row), non-NULL = a writable point that accepts commands. |
| `device_state` | Per-device collection health (last poll/success/error, streaks, counters). State, never config.                                                                                                   |

**Semantic — grouping and derivation**

| Table               | One-liner                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `areas`             | A site/grouping. Owns timezone, day offset and location. Every device has exactly one.                                                              |
| `area_members`      | An area's 1..N member devices, `(area_id, device_id, ordinal)`.                                                                                     |
| `area_bindings`     | Typed role→point **overrides**; absent means the area defaults to the union of its members' points.                                                 |
| `derivations`       | Persisted derived series (run tracking, HWS model), generalizing the former per-feature tracker tables.                                             |
| `derived_intervals` | Materialized run/interval records produced by a derivation, with per-interval statistics and provenance.                                            |
| `automations`       | Charge/limit rules scoped to an area: `mode='once'` (self-disarming, this session) or `'standing'`, with a jsonb trigger/action pair. TypeID `au_`. |

**Presentation**

| Table                 | One-liner                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `dashboards`          | A named view. Structure lives in the v4 node-tree `doc` (jsonb) — see below.                          |
| `dashboard_revisions` | Append-only history of `doc` writes, for optimistic concurrency and rollback.                         |
| `dashboard_grants`    | Per-user access to a dashboard.                                                                       |
| `share_tokens`        | View-only share links (3-word phrases), scoped to ONE dashboard (`dashboard_id`) — never to a device. |

**Time series and plumbing**

| Table                         | One-liner                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `point_readings`              | Raw time-series, one row per point per measurement time.                                                                                                    |
| `point_readings_agg_5m`       | 5-minute aggregates (avg/min/max/last/delta).                                                                                                               |
| `point_readings_agg_1d`       | Daily aggregates, keyed by local-time `day` (YYYY-MM-DD).                                                                                                   |
| `point_readings_flow_attr_1d` | Per local-day directional flow matrix (the Sankey/attribution store). Area-keyed by uuid.                                                                   |
| `battery_provenance_daily`    | Daily blended battery inventory + attribution. Area-keyed by uuid.                                                                                          |
| `sessions`                    | One row per vendor communication session, archiving the raw payload.                                                                                        |
| `point_commands`              | Audit trail of every command dispatched at a writable point: who asked, what was sent, the vendor outcome. Append-only in practice; rows complete in place. |
| `observations_outbox`         | Transactional outbox: durable copy of each poll's `QueueMessage`, drained to QStash by the relay cron.                                                      |
| `users`                       | Per-user preferences. Identity itself lives in Clerk.                                                                                                       |
| `legacy_handles`              | The permanent integer-handle → `device_id`/`area_id` map. A sanctioned shim — see below.                                                                    |

## Identity: TypeIDs above, rids below

- **Every config row has a UUID `id`.** The wire/URL form is a **TypeID** — `prefix_` +
  Crockford-base32 of that uuid, 26 chars. **The database never stores the prefix.** Prefixes are
  locked: `dv` device, `pt` point, `ar` area, `db` dashboard, `dx` derivation, `bn` binding,
  `au` automation.
  `lib/ids/` is the single source of truth, and its seven codecs are branded so that passing a `dv_` where
  an `ar_` is expected is a **compile error**.
- **Points are the exception to "v7": their id is _deterministic_.** `points.id` is
  `uuidv5(vendorType : vendorSiteId : physicalPath)` (`lib/identifiers/point-uid.ts`), with a v7
  fallback only on collision. That is what makes re-onboarding a device reproduce the same point ids,
  and why point ids mean the same row in prod and `liveone-dev` while area/dashboard ids do not.
- **The hot path uses an internal integer `rid`** (`points.rid`, `devices.rid`) — HA-recorder style.
  Re-keying `point_readings` on `(point_rid, time)` is _smaller_ than the `(system_id, point_id, time)`
  it replaced. `devices.rid` deliberately preserves the old `systems.id` values, so `sessions` and
  `observations_outbox` migrated by column rename and old logs stay greppable.
- 🛑 **The seam rule — uuids above, rids below.** `lib/registry/registry-cache.ts` is the only owner of
  uuid↔rid↔address; `lib/readings/schema-internal.ts` the only importer of the hot tables;
  `lib/readings/dao.ts` the only place SQL is written against them. Everything above the seam — API
  routes, capabilities, dashboards, KV, Sankey, provenance — speaks uuids only. **Enforced, not merely
  documented**: `no-restricted-imports` in `.eslintrc.json` plus `scripts/check-readings-boundary.mjs`.
  This is permanent.

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
3. **Point identity is `points.id` (a uuid)**, and the sequential per-device address is gone —
   the `"systemId.pointIndex"` ref grammar and its five `max(index)+1` allocators died with
   config-v4 Phase 12. Below the seam, readings key on `(point_rid, measurement_time)` — that pair
   is the `point_readings` primary key, and it is what dedups on re-delivery. Points are still
   lazily created when first observed, with per-**device** uniqueness on `physical_path` and on
   `(logical_path, metric_type)`; `mintPoint` is the sole allocator, upserting on
   `points_device_physical_path_unique`.
4. **Aggregation ladder:** raw → 5m (recomputed order-independently as data arrives, safe for
   parallel queue consumption) → 1d (cron at 00:05 local). 5m-native vendors (Amber, Enphase)
   upsert straight into the 5m table; aggregates inherit raw holes.
5. **Few FKs on the hot path, real FKs across the registry.** The receiver's insert path is
   deliberately thin — `point_readings` carries only `point_rid → points.rid` and
   `session_id → sessions(id)` (safe because the session row is co-enqueued ahead of its
   readings), and the aggregate tables carry none. The config layer is the opposite: config-v4
   replaced the old FK-less integer joins with hard references (`points.device_id`,
   `devices.primary_area_id`, `area_members.device_id`), which is what makes an orphaned row a
   loud failure rather than a silent empty result.
   ⚠️ **Removing an FK turns any join onto the replacement key into a silent filter.** Prefer a
   replacement join that is itself FK-backed and NOT NULL.

## Semantics

### Timestamps & timezones

- PG uses **native UTC `timestamp` columns** (no timezone) — including `share_tokens`, whose epoch-ms
  `bigint` columns were dropped by migration 0037 (config-v4 Phase 10).
- `point_readings` carries three times: `measurement_time` (device clock), `received_time`
  (when we fetched it), `created_at` (when it landed in PG — distinguishes live ingestion
  from backfill).
- Timezone, day offset and location resolve on the **Area**, never the device — see
  [Time: fixed-offset days](#time-fixed-offset-days) below.

### Points: paths and metrics

Every point carries **two** addresses, and the distinction is load-bearing.

| Field           | Separator | Set by         | Purpose                                                 | Example               |
| --------------- | --------- | -------------- | ------------------------------------------------------- | --------------------- |
| `physical_path` | `/`       | Vendor adapter | The vendor's own identifier. Collection and dedup only. | `selectronic/solar_w` |
| `logical_path`  | `.`       | Vendor adapter | Semantic classification. Nullable if unclassified.      | `source.solar`        |

`logical_path` + `/` + `metric_type` gives the **full logical path** — `source.solar/power` — and
that string is the one the rest of the system is keyed by: KV latest-value hash fields, Sankey node
identity, `series=` glob patterns, role shape-matching. The physical path never leaves the collector.

**Stem conventions.** First segment is the flow type (`source`, `bidi`, `load`), second the equipment
(`solar`, `battery`, `grid`), and any further segments are qualifiers:

```
source.solar          source.solar.local     source.solar.remote
bidi.battery          bidi.grid
load                  load.hws               load.ev
```

Two hierarchies get special treatment in the flow pipeline and are documented in
[energy-flow-matrix.md](energy-flow-matrix.md) §Directional model — don't re-derive them: the solar
**leaves** are preferred over the bare total with a synthetic `source.solar.residual` for the
remainder, and a master `load` with children becomes a **budget** whose sinks are the children plus
exactly one complement (`load.rest-of-house`), never both the master and its children.

**Metric types.** The metric type determines how a point aggregates and whether it needs a transform:

| Metric type   | Units     | Aggregation         | Transform   |
| ------------- | --------- | ------------------- | ----------- |
| `power`       | W         | avg, min, max, last | `n` (none)  |
| `energy`      | Wh        | delta (sum)         | `d` (delta) |
| `soc`         | %         | avg, min, max, last | `n`         |
| `proportion`  | %         | avg                 | `n`         |
| `rate`        | cents/kWh | avg                 | `n`         |
| `value`       | cents     | delta (sum)         | `d` (delta) |
| `code`        | —         | last (`value_str`)  | `n`         |
| `temperature` | °C        | avg, min, max       | `n`         |

The **delta transform** (`transform = 'd'`) is what turns a vendor's cumulative running total into a
per-interval change — a meter reading 1000 Wh then 1250 Wh contributes 250 Wh to the interval. Get it
wrong on an energy point and the aggregates report the odometer instead of the trip. None of this is
recoverable from `schema.ts`, which only knows `metric_type text`.

### Units & precision

- Power: Watts (float in point tables).
- Energy: kWh, 3 decimal places (5m-interval energies in Wh where vendor-native).
- Battery SoC: percent, 1 decimal place.

### Data quality

`point_readings.data_quality` is an **open string**, not a closed enum: `good` is the default written by
most collectors, but vendors write their own vocabulary — Amber abbreviates to a single char
(`abbreviateQuality`, `lib/vendors/amber/amber-readings-batch.ts`), OpenElectricity writes `actual`.
⚠️ **Do not test it for equality against `"good"`** — use `isSettledQuality` (`lib/data-quality.ts`),
which is what gates settled-vs-estimated presentation. Readings can carry `value` (numeric), `value_str`
(e.g. tariff codes), or `error`.

### Areas

An **Area** is a grouping of 1..N member devices. There is no `kind` column and no single-vs-multi
special case: an "area of one" is the same machinery with one member and no bindings. An Area is never
polled, has no credentials and does not nest.

- **`area_members`** — the Area's member devices, `(area_id, device_id → devices.id, ordinal)`.
- **`area_bindings`** — typed role→point **overrides**; when present they _select_ the Area's points,
  otherwise the Area defaults to the **union** of its members' own points.

An Area is served **area-natively** as its own row (`ServingSubject`, `lib/dashboard/subject.ts`). Before
config-v4 Phase 13, a multi-device Area was _synthesized_ on demand into a device-shaped object with a
runtime `vendor_type = 'area'`; that synthesis is deleted.

🛑 **Eager areas — every device has exactly one `primary_area_id` (NOT NULL), and areas-of-one are kept
forever.** Deleting them was the tidier model and was **rejected**: `point_readings_flow_attr_1d` and
`battery_provenance_daily` are keyed by area uuid, so deleting an area-of-one destroys history. They are
filtered out of the picker at render time instead. The area — not the device — is the sole home for
timezone and location.

🛑 **Never put `ON DELETE CASCADE` on `point_readings_flow_attr_1d.area_id`.** Its plain `NO ACTION` FK
(`lib/db/planetscale/schema.ts`, the `pointReadingsFlowAttr1d` definition) is the **data-loss firewall**:
Postgres _refuses_ to delete an area that still has flow rows. Today's area delete is soft, so the
firewall is not currently load-bearing — which is exactly why it is easy to loosen by accident. Any
future hard-delete path must pre-check `SELECT 1 FROM point_readings_flow_attr_1d WHERE area_id = $1
LIMIT 1` and refuse if present. The same rule applied to the retired `point_readings_flow_1d` and is the
reason no flow table has ever cascaded. (`area_members` _does_ cascade; that is deliberate and does not
loosen this — membership is config, flow rows are history.)

🛑 **Handle precedence is device-first, forever.** An integer handle can legitimately name both a device
and an Area (handle 13 does). `?systemId=N` resolves **device-first** — that is the behaviour-preserving
order, and it is written down at the top of `lib/dashboard/subject.ts`. The area-native reading of a
colliding handle is reachable only through an explicit `ar_…`. An explicit `?areaId=` is authorized
against the **Area's** own scope before it is served: the Area is a superset of the device sharing its
handle, so a post-hoc leg swap after the grant would be an escalation.

⚠️ **`PUT …/members` is a full replace with exactly one carve-out** — a `vendor='helper'` member is
server-managed (the provenance writer mints and binds it) and is **never** evicted by omission. A client
that read `members`, filtered to its picker's real devices and PUT that back would otherwise delete the
area's blend bindings and blank its provenance card until the next daily recompute. Documented at
`app/api/v4/areas/[id]/members/route.ts`.

The KV subscription registry maps source points → subscribing areas/devices so latest-value updates fan
out. See [areas-and-dashboards.md](areas-and-dashboards.md) for the full model and
[Points: paths and metrics](#points-paths-and-metrics) above for the path grammar.

### The v4 dashboard document

A dashboard's structure is a **recursive node tree** in `dashboards.doc` (jsonb) — groups containing
groups or cards, to a depth cap of 4. There is exactly one shape; the v3 `descriptor` column, the
rewriter and the adapter were all deleted in config-v4 Phase 14 (migration 0054). Edits are a
**whole-doc `PUT` with optimistic concurrency** (`If-Match` on `revision`), with every write appended to
`dashboard_revisions`.

- **Store choices and structure only.** Display names, headers, capability sets, availability, default
  layout and timezone are **derived at render, never stored**. This is what keeps docs small and
  rename-proof.
- 🛑 **The security invariant: scope-bearing references live ONLY in envelope fields (`node.area`,
  `node.device`) — never inside `config`.** Share-scope derivation and the authoring no-escalation check
  are one type-agnostic tree walk over fixed positions. A future or unknown card type therefore cannot
  smuggle a reference the scope resolver does not see: a ref buried in `config` grants nothing, and the
  card simply 403s on fetch. **Do not add a scope-bearing ref to a card's `config`** — that is the one
  change that would silently break sharing.
- **Validation is asymmetric on purpose.** The envelope is strict (zod; malformed ⇒ 422, never
  persisted) and node ids are server-assigned `n_…`. But `type` is an **open string, warn-not-reject**:
  an unknown card type persists with its opaque `config` intact and renders a labelled placeholder, so
  an older validator cannot destroy a newer client's config. Known types get strict per-type `config`
  schemas, and references are **always** strict.
- ⚠️ **Rename-proofing covers labels, not `type`.** The bullet above says display names are derived, so
  renaming one is free — but a card `type` **is** persisted, so renaming _it_ is a document-data
  change. Old documents keep the old string and (by the warn-not-reject rule) degrade to a visible
  placeholder rather than erroring. Ship the document rewrite with the rename:
  [migrations.md § Data & config-document migrations](../migrations.md#data--config-document-migrations).
- ⚠️ Because node ids are server-assigned within the doc being normalized, **a group produced in
  isolation arrives carrying ids that may already exist in the target doc.** Strip ids when appending a
  subtree, or the `PUT` is rejected for duplicate node ids. (The first append is unaffected, so a
  single-append test will not catch it.)

### Time: fixed-offset days

`areas.timezone_offset_min` is the **fixed standard offset** (e.g. 600 = AEST), no DST.
`areas.day_offset_min` is the canonical day-bucketing key — backfilled equal to the timezone offset and
immutable thereafter except via an explicit re-bucket operation, so that a site's historical day
boundaries cannot move under it. `areas.display_timezone` is the IANA zone used for UI display, and it
**does** observe DST. Daily aggregation buckets by local day: `> 00:00 local` to `<= 24:00 local`, keyed
as YYYY-MM-DD text.

### Permanent shims — sanctioned, not debt

These look like leftovers and are not. **Do not "clean them up".**

| Thing                                              | Why it stays                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `legacy_handles`                                   | Resolves `?systemId=N` → device/area **forever**. New areas still mint a handle into it.         |
| `dashboards.legacy_id`                             | The only cross-environment-stable dashboard key; post-cutover `dashboards.id` is minted per env. |
| The `?systemId=N` query alias                      | Kept so existing links and bookmarks never break.                                                |
| Slug URLs and 3-word share-token phrases           | Human-facing addresses; deliberately not TypeIDs.                                                |
| `lib/ids/`                                         | The TypeID codec seam itself.                                                                    |
| `lib/registry/{registry-cache,device-registry}.ts` | The uuid↔rid↔address owner — the seam rule's implementation.                                   |
| `scripts/check-readings-boundary.mjs`              | The permanent seam wall.                                                                         |
| `scripts/utils/verify-areas-drift-key.ts`          | The **only** remaining alarm on the prod→dev `areas` drift key — see below.                      |

🛑 **The drift-key alarm is load-bearing.** Dropping `areas_legacy_system_unique` (migration 0052)
removed a backstop: before it, a missed `areas` drift key **aborted** the prod→dev sync on that index.
After it, the same miss exits 0 and lands prod's row **alongside** the drifted dev row — the same
logical area under two uuids, silently. This is an accepted, permanent downgrade. **Run
`scripts/utils/verify-areas-drift-key.ts` after any change to the sync's `areas` `idDrift` leg.**

### Postgres error shapes through PlanetScale

🛑 **You cannot detect a constraint violation the obvious way.** Two independent facts compose:

1. **Drizzle ≥0.44 re-throws every failed query as a `DrizzleQueryError`** whose own `code` is
   `undefined`; the pg error is on `.cause`. So `err.code === "23505"` **never matches**.
2. **PlanetScale's Postgres proxy strips `schema`, `table`, `column`, `dataType` and `constraint` from
   every error response** — measured against genuine `pg_constraint`-backed PRIMARY KEYs, not just
   unique indexes. Only `severity`, `code`, `detail`, `file`, `line` and `routine` survive.

Consequence: **no migration can fix this.** Restating a `uniqueIndex(...)` as a named constraint changes
nothing, because the field is stripped either way. The only field naming the violated unique is the
server's `message`. Use **`lib/db/pg-error.ts`**, which walks the cause chain and matches on `message`
(preferring `constraint` when a stock Postgres does supply it, so the helper stays correct off
PlanetScale). `isUniqueViolationOn` is deliberately **strict** — an undeterminable name rethrows — so a
409 branch cannot fire on the wrong unique. `detail` is not usable: it names only the _columns_, which
aliases between two indexes over the same column set.

This was live for months. Both dashboard write paths were returning a bare **500 with an empty body**
where they intended a 409, a share-token retry loop was decorative (its `continue` was unreachable), and
`mintPoint` **threw on the ingest path** instead of falling back to a random uid.

### Vendor credentials

Stored in **Clerk private metadata** under the owning user — not in the database (locked
decision 2026-06-06). See [authentication.md](authentication.md).

## Legacy: pre-points `readings*` tables

The original fixed-column tables (`readings`, `readings_agg_5m`, `readings_agg_1d`) were
deprecated Nov 2025 and superseded by the point tables. They were never migrated to Postgres
and were retired with the former SQLite store; their full schema is preserved in git
(`docs/DEPRECATED_SCHEMA.md`, deleted 2026-06-10).
