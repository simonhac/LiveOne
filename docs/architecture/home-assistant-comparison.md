# LiveOne vs. Home Assistant — architecture & object model

> **Status:** current as analysis — **refreshed 2026-07-28 for config-v4**. An analytical scorecard,
> not a spec; for design _decisions_ it is superseded by
> [config-v4-clean-sheet.md](../plans/config-v4-clean-sheet.md), which carries the HA-relationship
> choices forward.
>
> **LiveOne side** reflects the post-cutover **v4** model (the cutover ran 2026-07-26; Phases 0–11
> shipped, Phase 12 in flight). LiveOne is mid-migration, so the schema is ahead of the code in
> places — those rows are flagged **v3 residue**, and the gap list is marked ✅ closed / ⚠️ narrowed
> / ❌ open. Source of truth is `lib/db/planetscale/schema.ts` +
> `docs/architecture/{overview,data-model,points,areas-and-dashboards,engine-web-separation}.md`, and
> the current state-of-play is [config-v4-execution-plan.md](../plans/config-v4-execution-plan.md).
>
> **Home Assistant side** reflects the HA developer docs and core through **2026.7**. HA changes
> fast — treat HA specifics as indicative and re-check before relying on one.

## What changed in this revision

The previous revision described the **v3** model (`systems` / `point_info` / `(system_id, point_id)`
addressing / `point_readings_flow_1d` / no derivations). Config-v4 landed in between and moved four
of the scorecard's lines:

| Line                                 | Then (v3)                               | Now (v4)                                                                                |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------- |
| **Identity vs. address** (HA ahead)  | Fused into `(system_id, point_id)`      | **Largely closed** — `points.id` is a deterministic identity, `rid` the recorder key    |
| **Two derive mechanisms** (HA ahead) | `device_trackers` + a bespoke HWS model | **Narrowed** — one `derivations` table; kinds still code-typed, not user-composable     |
| **Flow matrix** (we're ahead)        | `point_readings_flow_1d`, energy only   | **Wider lead** — `flow_attr_1d` carries emissions / renewable / cost legs               |
| **Bindings** (we're ahead)           | FK-typed role→point edges               | **Wider lead** — + `priority` slot resolution, bind-time shape validation, CHECK for FK |

Still open exactly as before: Floor / Label / Category, the attributes dict, the config-flow
taxonomy, the helper ecosystem, and unit conversion. New on HA's side of the ledger since the last
revision: `mean_type` (arithmetic / circular) and `unit_class` in the recorder statistics API. New
on ours: dashboard revisions with optimistic concurrency, and fixed-offset day bucketing as an
endorsed decision rather than an accident.

## Why this doc exists

LiveOne's design deliberately borrows Home Assistant vocabulary — System/Device→Device,
Point→Entity, Area→Area, `area_bindings`→Energy-dashboard config — and the role registry
(`lib/roles/registry.ts`) literally carries `device_class` / `state_class` / `unit` per role against
a planned HA export bridge. Config-v4 made the debt explicit, listing its goal as _"inspired by Home
Assistant's best ideas (registries, areas, derived helpers, storage-mode dashboards) without its
limitations (single-home, no multi-tenancy, nesting-hostile editor)."_

So the two are worth comparing carefully: not to copy HA wholesale, but to know exactly where we
mirror it, where we diverge, and why. This doc is the honest scorecard.

## The one asymmetry that explains everything

A fair comparison separates the **object model** (where we map onto HA very cleanly — partly by
design) from the **runtime/storage architecture** (where we diverge because the _problem domains_
diverge):

- **Home Assistant is a real-time _control plane_ for one home.** Thousands of _heterogeneous_
  devices and **actuators** (lights, locks, switches), single-tenant, mostly local. It is
  **write/command-heavy** and **latency-sensitive** ("press button → light turns on"), so its source
  of truth is an **in-memory state machine**. Durable history (recorder/statistics) is a secondary,
  best-effort bolt-on — and its 5-minute tier is deliberately transient (purged at ~10 days).
- **LiveOne is a durable _observability/metrics pipeline_ for many sites.** A _narrow_, homogeneous
  signal set (power / energy / SOC / price / grid intensity), multi-tenant, cloud. It is
  **read/aggregate-heavy** and **durability-critical** (losing a reading is a data-integrity bug, not
  a missed light), with **almost no actuators** in the core loop. Source of truth is **durable
  Postgres**; KV is a derived fast-read.

The actuator caveat has narrowed slightly since the last revision: Tesla charge control is now a
real shipped command path (`POST /api/systems/[systemId]/tesla/command` — `charge_start` /
`charge_stop` / `set_charge_limit`, dispatched through the Fleet client's signer seam). But it is
_one route in the web tier_, not a command plane: there is no service registry, no uniform
invocation contract, and the engine Control API of `engine-web-separation.md` is still unbuilt.

Almost every difference below falls out of that asymmetry. Keep it in mind so the comparison stays
fair: HA "wins" on generality/identity/control because it must tame _heterogeneity_ and _control_ for
_end-users_ in _one_ home; LiveOne "wins" on durability/aggregation/attribution/sharing because it
must _not lose data_, _serve aggregates fast to many tenants_, and _partition access_.

## Language & stack

|                   | Home Assistant                                                                                                                                                                            | LiveOne                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Core language     | **Python**, entirely on **`asyncio`** (one event loop on the `hass` object; integrations are `async` coroutines, blocking I/O pushed to executor threads). Tracks recent Python releases. | **TypeScript** end-to-end                                                                                                                 |
| Frontend          | TypeScript / **Lit** (web components) — Lovelace                                                                                                                                          | TypeScript / **Next.js** (React)                                                                                                          |
| Runtime shape     | Long-lived **process you host** — can hold authoritative state in RAM                                                                                                                     | **Stateless serverless** (Vercel, region `syd1`) — no in-RAM authoritative state, so state lives in KV + Postgres                         |
| Time-series store | SQLite (default) / MariaDB / PostgreSQL via the _recorder_                                                                                                                                | PostgreSQL (PlanetScale) as the sole datastore; Vercel KV as a derived latest-value cache                                                 |
| Config store      | **JSON files under `.storage/`** (entity/device/area/floor/label/category registries, Lovelace docs, energy prefs), loaded into memory at boot                                            | **SQL tables in the same Postgres** (`devices`, `points`, `areas`, `area_bindings`, `derivations`, `dashboards`) with real FKs and CHECKs |
| Release cadence   | Monthly (`2026.7` at time of writing), with a published deprecation runway                                                                                                                | Continuous deploy from `main`                                                                                                             |
| Distribution      | Core / Supervisor / OS / Container + add-ons                                                                                                                                              | Single Vercel deployment                                                                                                                  |

Two structural consequences worth naming. **Runtime shape**: HA _can_ keep the current world in
memory and act on it instantly; we can't, so we lean on a durable store plus a fast cache. **Config
store**: HA's registries are JSON documents whose referential integrity is code-only and can drift;
ours are SQL rows that can't dangle — which buys us enforcement and costs us HA's zero-migration
schema evolution.

## Object-model mapping

Post-config-v4. "v3 residue" flags a row where the schema is already v4 but the code path isn't.

| LiveOne (v4)                                                                 | Home Assistant                                                             | Mapping quality                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices` (uuid, wire form `dv_…`; `rid` int; `vendor` + `vendor_site_id`)   | **Config entry + Device** _(fused)_                                        | **Merged — now deliberately.** v4 documents the non-adoption of HA's split (§4.1). _v3 residue: `systems` is still the code's config API._                                             |
| `points` (uuid `pt_…`; `rid` int)                                            | **Entity** (`unique_id` → `entity_id`)                                     | **Clean, and identity is now clean too** — see "Where HA is clearer" #1                                                                                                                |
| `points.id` = `uuidv5(vendor : vendor_site_id : physical_path)`              | entity **`unique_id`** (vendor-stable, non-user-configurable)              | **Clean** — both stable, vendor-derived, survive re-onboarding                                                                                                                         |
| `points.rid` → `point_readings(point_rid, measurement_time)`                 | `states_meta.metadata_id` / `statistics_meta.id`                           | **Convergent evolution** — the same "int surrogate in the hot tables" trick, reached independently                                                                                     |
| `points.physical_path` (`selectronic/solar_w`)                               | the vendor half of `unique_id`                                             | Clean                                                                                                                                                                                  |
| `points.logical_path` + `metric_type` (`source.solar` / `power`)             | `device_class` + `state_class`                                             | **Still leaky** — one path carries semantic type _and_ aggregation hint (the energy-role job moved out to bindings)                                                                    |
| `points.name` (editable) vs `default_name`                                   | entity-registry **name override** vs device-supplied name                  | Clean                                                                                                                                                                                  |
| `points.metric_type` / `unit`                                                | **`device_class`** + **`unit_of_measurement`** (+ `unit_class` converters) | Mostly clean — we still have no model-layer unit conversion (W↔kW)                                                                                                                     |
| `points.transform` (`d`=delta) + agg rules keyed on `metric_type`            | **`state_class`** (`measurement` / `total` / `total_increasing`)           | Same intent, different mechanism (theirs first-class, ours inferred)                                                                                                                   |
| `lib/roles/registry.ts` (carries `device_class`/`state_class`/`unit`)        | _(no native table)_ — Energy-dashboard role slots                          | **Explicitly HA-aware** — our bridge-in-waiting. v4 killed its SQL projection: the `roles` table is writer-less and dies in Phase 12; `area_bindings_role_check` holds the vocabulary. |
| `areas` (uuid `ar_…`; owns `day_offset_min`, `display_timezone`, `location`) | **Area** registry                                                          | **Much closer than in v3** — v4 made tz/location area-only (HA-style), and `kind` is gone. _v3 residue: `legacy_system_id` still present and load-bearing (Phase 13)._                 |
| `area_members` (area ↔ device, many-to-many)                                 | device's single `area_id`                                                  | **Ours is more general** — a device can belong to several areas; HA allows exactly one                                                                                                 |
| `area_bindings` (role→point edges + `priority`, shape-validated)             | Energy "preferences" (role→entity)                                         | Clean & direct; **ours FK+CHECK-enforced with per-slot priority, theirs JSON in `.storage`**                                                                                           |
| `derivations` / `derived_intervals`                                          | Helper integrations (Threshold, Integration, Utility Meter, …) + history   | Same intent — **one mechanism now**, but our kinds are code-typed (`run-detector`, `hws-model`) where HA's are user-composable                                                         |
| `dashboards.doc` (v4 recursive node tree) + `dashboard_revisions`            | **Lovelace** storage-mode dashboard (views / sections / cards)             | Close in shape; **ours adds revisions + `If-Match`/412**. _v3 residue: `descriptor` and `doc` are both NOT NULL and the only editor writes v3 (Phase 14)._                             |
| `share_tokens` (unified, one token → one dashboard) / `dashboard_grants`     | _(none — single-tenant; `require_admin` on a dashboard is the nearest)_    | No mapping                                                                                                                                                                             |
| `device_state` (1:1 with `devices`; per-poll health)                         | config-entry state + integration diagnostics                               | Ours is a first-class table; HA's equivalent is in-memory + diagnostics downloads                                                                                                      |
| `legacy_handles` (old int handle → v4 uuid, frozen)                          | _(none)_                                                                   | No mapping — our permanent compat shim (HA mints opaque IDs freely and never carried an int era)                                                                                       |
| KV latest cache + newest `point_readings`                                    | **State machine** `State` (in-memory)                                      | Functional analog (theirs authoritative in-RAM, ours a derived cache)                                                                                                                  |
| `point_readings` (raw, durable, SQL)                                         | recorder `states` table                                                    | Theirs is best-effort history, purged by default; ours is the source of truth, kept                                                                                                    |
| `point_readings_agg_5m` / `agg_1d`                                           | `statistics_short_term` (5m, ~10d) / `statistics` (hourly, indefinite)     | **Strikingly parallel**; semantics, cadence _and retention_ differ (see below)                                                                                                         |
| `point_readings_flow_attr_1d` (directional matrix + attributed metrics)      | _(none — energy dashboard computes flows at query time)_                   | No mapping — we materialize, HA derives on the fly                                                                                                                                     |
| `battery_provenance_daily` (per-day learned η / C / fold checkpoint)         | _(none)_                                                                   | No mapping — outside HA's problem entirely                                                                                                                                             |
| `sessions` (poll provenance, vendor response)                                | _(none)_                                                                   | No mapping — HA keeps no per-poll record                                                                                                                                               |
| `observations_outbox` + QStash + receiver                                    | event bus (`state_changed`) + recorder write                               | No mapping — **different reliability model**                                                                                                                                           |
| —                                                                            | **Floor** registry                                                         | **Absent in ours** (no floor tier)                                                                                                                                                     |
| —                                                                            | **Label** registry                                                         | **Absent in ours** — v4 kept it as a deferred seam                                                                                                                                     |
| —                                                                            | **Category** registry (function, orthogonal to Area)                       | **Absent in ours**                                                                                                                                                                     |
| `lib/vendors/*` adapters + registry                                          | **Integration + platform** (`manifest.json`, config-flow)                  | Clean structurally; HA `iot_class` ≈ our `dataSource` (poll/push/combined)                                                                                                             |

## Where Home Assistant is clearer / more general

Real design advantages, mostly orthogonal to the domain difference. Each is marked with where v4
left it.

1. **Three-way identity split — ✅ largely closed by config-v4.** HA separates _durable identity_
   (`unique_id`), _renameable address_ (`entity_id` = `domain.object_id`), and _device identity_
   (`identifiers`/`connections`). v3 fused identity and address into one composite integer. v4
   splits them three ways too: `points.id` is a deterministic `uuidv5(vendor : site : physical_path)`
   identity (re-onboarding a device reproduces the same ids), the TypeID `pt_…` is the public
   address, and `points.rid` is the internal recorder key. **What's still open:** we have no
   renameable _text_ address (HA's `sensor.kitchen_power`, rename-safe because `unique_id` is the
   registry key), and no cross-integration device dedup — HA's `connections` (MAC etc.) +
   `async_set_unique_id` can recognise that two integrations found the same physical box; nothing in
   ours can.
2. **`config entry → device → entity` containment — ⚠️ open, and now deliberately so.** One HA
   integration instance owns _many_ devices, each many entities, with cascade delete. v4 considered
   and declined the split: _"LiveOne's point namespace, credential scope, and polling unit are all
   1:1 with the vendor connection; a second table buys nothing until one connection yields multiple
   independently-addressable devices"_ (clean-sheet §4.1). The "one logical site spanning multiple
   physical devices" job that HA's containment does is carried by `areas` + `area_members` — which,
   unlike HA, is many-to-many in both directions. So this is now a **stated trade**, not an
   oversight; it becomes a real gap the day a single vendor connection yields several devices.
3. **Floor + Label + Category — ❌ still open.** Three grouping dimensions we lack: Floor
   (hierarchical: Floor → Area → device/entity), Label (orthogonal many-to-many tag on _any_ object)
   and Category (function — "Main Lighting" — orthogonal to Area's "where"). We have a single Area
   tier. v4 absorbed the identity half of
   [`identity-address-split-and-labels.md`](../plans/identity-address-split-and-labels.md) and
   explicitly parked the label half as a deferred seam.
4. **State = string + open-ended attributes dict — ❌ open.** Any HA integration attaches arbitrary
   supplementary data with no schema change. Our reading is fixed-column (`value` / `value_str` /
   `error` / `data_quality`) — more rigid, though that rigidity is what buys typed aggregation.
   (`devices.adapter_state` jsonb gives adapters a per-device escape hatch, but not a per-reading
   one.)
5. **Service/event decoupling — ⚠️ narrowed, still open.** `call_service` (imperative command) vs
   `state_changed`/event-bus (observation), uniform across 1000+ integrations. We now have exactly
   one real command path (Tesla charge control, above) — a bespoke route, not a registry. The
   FE→engine command pattern in `engine-web-separation.md` remains **direction of travel, not built**.
6. **Config-flow as a uniform onboarding contract — ❌ open.** `user` / `discovery` / `zeroconf` /
   `reauth` / `reconfigure` as standard steps, with `async_set_unique_id` dedup. Our add-device flow
   (`credentialFields`, `credentials`/`oauth-redirect`) is narrower with no discovery or reauth
   taxonomy — notable given that vendor tokens (Tesla, Enphase) do expire.
7. **The helper / template ecosystem — ⚠️ narrowed, still HA's crown jewel.** _Integration_ (Riemann
   sum, W→kWh), _Derivative_ (kWh→W), _Utility Meter_ (cycle/tariff), _Template_ (arbitrary typed
   Jinja sensor), _Group(sum)_ let users **compose new typed points purely through config**. v4's
   `derivations` closed the embarrassing half of this gap — run-tracking and the HWS thermal model
   are now one mechanism (`output='point'` → a derived point in the pipeline; `output='intervals'` →
   run periods) with typed `params` + `source_points` as data. But the **kinds** are still code
   (`run-detector`, `hws-model`): an engineer ships a new kind, where an HA user configures one. The
   derived points we run (`load.rest-of-house`, synthetic totals) remain code-defined.
8. **`device_class` ⊥ `state_class` ⊥ energy-role — ⚠️ partly closed.** HA keeps semantic type,
   aggregation behaviour, and energy-dashboard role as three separate axes. v4 pulled **role** out
   into its own axis (`area_bindings` with per-slot `priority` and bind-time shape validation), so
   the overload is down from three jobs to two: `logical_path` still carries semantic type _and_ the
   aggregation hint that `state_class` would carry, with `transform` + `metric_type` filling in.
9. **Unit conversion and mean semantics — ❌ open (and HA moved further ahead).** The Oct-2025
   recorder statistics API added `unit_class` (which converter applies, enabling display-unit changes
   without recompiling history) and replaced the `has_mean` boolean with `mean_type` — `arithmetic`,
   `circular` (for wind-direction-like quantities), or none; `has_mean` goes away in 2026.11. We have
   neither: units are a fixed string per point and `avg` is one thing.

## How ours maps onto theirs

Well at the **semantic layer** — because we deliberately borrowed the vocabulary and still carry
`device_class` / `state_class` / `unit` per role for an MQTT-Discovery export bridge. Point→Entity,
Area→Area, `area_bindings`→Energy preferences, `dashboards.doc`→Lovelace all translate directly, and
v4's TypeIDs give an exporter a stable public identity to key on.

Where we're **more constrained**:

- **The integer handle is dying but not dead.** `areas.legacy_system_id` is still the universal
  address in ~186 places (`/api/data?systemId=`, the KV keyspaces `latest:system:N` /
  `subscriptions:system:N`, capabilities, descriptors), and `AREA_HANDLE_BASE = 1_000_000` still
  allocates. Phase 13 kills it. Until then, "v4 addressing" is true of the config tables and not yet
  of the serve path.
- **`legacy_handles` + `dashboards.legacy_id` are permanent compatibility seams** HA never carries —
  it mints opaque IDs freely, while we froze the old integer space so `?systemId=N` and
  `/dashboard/id/{n}` resolve forever.
- **`devices` fuses config-entry + device**, so an HA export must choose; it cleanly models only
  single-device connections (see #2 above).
- **Vendor coupling leaks upward** via `physical_path`; HA hides vendor specifics behind the
  integration boundary so everything above the entity is vendor-agnostic. Our `logical_path`
  abstraction exists to recover this, but the physical path remains a first-class, uniquely-indexed
  column.
- **Composite provenance collapses** at `flow_attr_1d` (path-keyed `(area_id, day, source_path,
load_path)`, not point-keyed) so aggregated multi-point sources have a stable identity — at the cost
  of "which physical meter" no longer being recoverable from the flow row. But HA can't express
  "total solar across 3 inverters" as a first-class persisted entity without a Group helper that
  collapses provenance the same way — so this is a _fair trade_, not a pure deficiency.
- **Presentation is still dual-shape.** `dashboards` carries both `descriptor` (v3) and `doc` (v4)
  NOT NULL; all 19 render plugins are v3-shaped and reached through an adapter, and the only editor
  writes v3. HA has one dashboard shape. Phase 14 collapses ours.

## Where ours may be superior

Genuine wins — separating real architectural advantages from "different problem domain."

1. **Single-writer + transactional-outbox ingest durability — GENUINE WIN.** `observations_outbox`
   is committed _before_ the QStash enqueue; an idempotent single-writer receiver
   (`/api/observations/receive`) materializes it; the relay replays. At-least-once + rebuildable,
   across a network boundary, without a heavyweight log. **HA's pipeline is fire-and-forget
   in-process** — a `state_changed` the recorder misses (crash, DB stall) is simply _lost_. For a
   durable observability pipeline this is a real engineering advantage. (HA doesn't _need_ it — an
   in-memory control plane has different durability requirements.) See `engine-web-separation.md`.
2. **Typed aggregation with quality metadata, permanent 5-minute tier, and deterministic recompute —
   PARTLY a win.** Both downsample (us 5m + 1d; HA 5m + hourly). Three real differences:
   - _Retention._ HA's `statistics_short_term` is purged with the states table (default ~10 days);
     only the hourly tier is kept indefinitely. Ours is permanent — which is what makes rebuilding
     `flow_attr_1d` (built from 5m, deliberately, because daily averages cancel direction) and the
     provenance fold possible years later.
   - _Quality + order-independence._ Our agg rows carry `sample_count` / `error_count` /
     `data_quality` and **recompute order-independently** from raw on every insert, so backfill and
     out-of-order data heal cleanly; HA's statistics compile strictly forward in time and backfill is
     awkward.
   - _Honest caveat, and HA has extended its lead here._ HA's mean is **time-weighted** (ours is a
     plain sample mean, biased under irregular sampling), it has **counter-reset detection**
     (~10% tolerance in `total_increasing`), and since 2025.10 it also has **`mean_type`**
     (arithmetic vs circular) and **`unit_class`** conversion. Roughly parity on the core idea; HA is
     ahead on statistical refinement, we're ahead on durability and recomputability.
3. **Directional, metric-attributed energy-flow matrix — GENUINE WIN, and the lead widened.**
   `point_readings_flow_attr_1d` materializes `(area_id, day, source_path, load_path) → energy_kwh`
   **plus** the attributed legs — `emissions_g`, `renewable_kwh`, `cost_c` — with direction encoded by
   slot (battery charge→`load.battery`, discharge→`source.battery`; grid import→`source.grid`,
   export→`load.grid`), built from 5m data, with `estimated_kwh` as a confidence denominator and
   `finalized_at` marking the ~72h estimated→final cutoff. A multi-day range is a plain `SUM … GROUP
BY`. The legacy energy-only `point_readings_flow_1d` is retired; this is the sole matrix.
   HA computes the equivalent **energy** flows at query time and persists nothing, and its closest
   attribution feature is a grid fossil-fuel percentage from the Electricity Maps / CO₂ Signal
   integration — a headline number for the whole home, not a per-edge attribution you can ask _"what
   did it cost, how green was it, to charge the EV in July"_ of. See `energy-flow-matrix.md` and
   `battery-provenance.md`.
4. **Multi-tenant, capability-scoped sharing — outside HA's domain entirely, and now unified.** v4
   collapsed two token systems into one: `share_tokens` is one token → one dashboard, and
   `dashboard_grants` (admin/viewer) is per-dashboard membership. Scope is **derived live from the
   dashboard document on every read** (never snapshotted) — Dashboard → its nodes' refs → exactly
   those points. Least-privilege, FK-enforced, revocable. HA is single-tenant; the nearest thing is
   marking a dashboard admin-only.
5. **FK/CHECK-enforced typed bindings with deterministic slot resolution — WIN on rigour.**
   `area_bindings` are SQL rows with real FKs and a `CHECK` on the role vocabulary (the `roles`
   table, a second source of truth mirroring `lib/roles/registry.ts`, is being deleted precisely
   because the CHECK does the job). On top of that v4 added two things HA's energy preferences have
   no equivalent of: **`priority`-ordered per-slot resolution** (explicit binding → unique shape
   match → area-config producer → absent, with "two candidates, no binding" surfaced as a choice
   rather than silently picked) and **bind-time shape validation** (a point whose
   `(logical_path, metric_type)` doesn't fit the role is rejected). HA's prefs are one entity per
   slot in a JSON file, resolved by whatever the config UI wrote. (Tradeoff: HA's looseness buys
   zero-migration schema evolution — a fair trade, not strictly inferior. And HA closed a real
   usability gap in 2026.2, when the energy dashboard learned to take raw power sensors, inverted
   polarity, and separate charge/discharge sensors without template-sensor gymnastics.)
6. **Versioned dashboard documents — SMALL BUT REAL WIN.** `dashboard_revisions` keeps the last ~20
   whole-doc snapshots with `saved_by`/`saved_at`, and the v4 PUT is optimistic-concurrency-checked
   (`If-Match` → 412 on a stale revision). Two people editing the same dashboard can't silently
   clobber each other, and a bad edit is undoable across sessions. Lovelace's storage-mode document
   has neither — last write wins, no history.
7. **Fixed-offset day bucketing, decided rather than defaulted — DOMAIN WIN.** `areas.day_offset_min`
   is the canonical bucketing key (immutable except via an explicit re-bucket that regenerates
   `agg_1d` / `flow_attr_1d` / provenance), and `display_timezone` is formatting only. **Every day is
   exactly 24 hours**, so 5m→1d rollups stay idempotent and every daily comparison is honest — and it
   matches the domain, since AEMO settles the NEM in fixed AEST year-round. HA stores hourly
   statistics and computes local days at query time, inheriting 23/25-hour DST days. For a home
   automation system that's the right call; for energy accounting ours is.
8. **Engine/web separation + the rid seam — MIXED / domain-appropriate.** The cloud-scaling split
   (collection vs serving, single-writer contract, KV-as-engine-write / web-read) is something HA has
   no need for (one process, one box) — calling it "superior" is mostly a category error. The
   `uuid ↔ rid` seam is a genuine ergonomic win for join-heavy time-series (and, at `(point_rid,
time)`, 4 bytes per index entry _smaller_ than v3's `(system_id, point_id, time)`) — but it is
   convergent with, not ahead of, HA's `metadata_id`. Where we _are_ ahead is that ours is a
   lint-enforced boundary: above it everything speaks uuids, below it everything speaks rids.

**Honest deductions:** our command/control plane is one bespoke route where HA's service registry is
mature and uniform; our no-code composition is absent where HA's helper ecosystem is its crown jewel;
our plain-mean aggregation is worse than HA's time-weighted mean, and HA has since added circular
means and unit-class conversion we don't have; and we still carry an in-flight migration's dual
shapes (int handle + uuid, `descriptor` + `doc`) that HA never had to.

## Verdict

**Home Assistant is the more general and elegant _object model + control runtime_; LiveOne is the
more rigorous _durable, multi-tenant, aggregation-and-attribution-first data pipeline_.** Where we
re-implement HA's semantic layer we are a reasonable subset — and config-v4 made it a closer one,
closing the identity/address gap, unifying the derive mechanisms, and moving role out into its own
axis. Where we diverge we're not "behind" HA — we're solving a different problem, and the outbox,
aggregation, flow-attribution and sharing investments are genuine wins _for that problem_.

The remaining borrowings worth considering, in rough order of value-per-risk:

1. **Labels** (and possibly Categories) — an orthogonal tag dimension on any object. Parked as a
   deferred seam by config-v4; still the cheapest HA idea we haven't taken.
2. **A config-flow-style onboarding taxonomy** — specifically `reauth`, which we need anyway as
   vendor tokens expire.
3. **Unit classes** — model-layer conversion, so display units stop being baked into the point.
4. **Time-weighted means** in the 5-minute rollup — the one place HA's statistics are simply more
   correct than ours.
5. **User-composable derivation kinds** — the long pole, and the one that would turn `derivations`
   from an internal mechanism into a user-facing feature.

## Related docs

- [`../plans/config-v4-clean-sheet.md`](../plans/config-v4-clean-sheet.md) — the canonical rationale
  for the v4 model; §4.1 records the deliberate non-adoption of HA's config-entry/device split.
- [`../plans/config-v4-execution-plan.md`](../plans/config-v4-execution-plan.md) — what has landed and
  what is still v3; the authority for the "v3 residue" flags above.
- [`areas-and-dashboards.md`](areas-and-dashboards.md) — the Device→Area→Dashboard split and the
  existing HA bridge table (partly overturned by the clean sheet).
- [`points.md`](points.md) — the point model, paths, and identity.
- [`data-model.md`](data-model.md) — data semantics & invariants.
- [`engine-web-separation.md`](engine-web-separation.md) — ingest durability (outbox), engine/web
  split, the (planned) FE→engine command pattern.
- [`energy-flow-matrix.md`](energy-flow-matrix.md) — the directional Sankey matrix.
- [`battery-provenance.md`](battery-provenance.md) — the metric legs (emissions / renewable / cost)
  attached to those flows.

## Revision history

- **2026-07-28** — refreshed for config-v4 (post-cutover schema, derivations, TypeIDs, unified
  sharing, `flow_attr_1d`, dashboard revisions, fixed-offset days) and for HA through 2026.7
  (`mean_type` / `unit_class`, Category registry, 2026.2 energy-dashboard power-sensor support,
  short-term statistics retention).
- **2026-07-21** — original, written against the v3 model alongside the config-v4 clean sheet.
