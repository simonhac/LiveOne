# LiveOne vs. Home Assistant — architecture & object model

> **Status:** current as analysis — **rewritten 2026-07-28** (second pass: deeper HA verification,
> LiveOne restated as finished config-v4). An analytical scorecard, not a spec.
>
> **LiveOne side** describes **config-v4 as designed and delivered**. The cutover ran 2026-07-26 and
> Phases 0–11 have shipped and Phase 12 is under way (`roles`, `user_systems` and `area_devices`
> dropped in migrations 0044–0046); Phases 12–14 finish the last of it (drop `systems`/`point_info`,
> kill the integer handle, collapse the two dashboard shapes). This doc describes the **settled end
> state** rather than tracking the migration — for what is live _today_ see
> [config-v4-execution-plan.md](../plans/config-v4-execution-plan.md); for _why_ the model is shaped
> this way see [config-v4-clean-sheet.md](../plans/config-v4-clean-sheet.md), which supersedes this
> doc on all design decisions. Schema truth is `lib/db/planetscale/schema.ts`.
>
> **Home Assistant side** re-verified against the HA developer docs, user docs and release notes
> through **2026.7**. HA changes fast; each non-obvious HA claim below names the release or doc it
> came from so the next refresh can re-check it cheaply.

## Why this doc exists

LiveOne deliberately borrows Home Assistant vocabulary — Device→Device, Point→Entity, Area→Area,
`area_bindings`→Energy-dashboard config — and the role registry (`lib/roles/registry.ts`) carries
`device_class` / `state_class` / `unit` per role against a planned HA export bridge. Config-v4 made
the debt explicit, stating its goal as _"inspired by Home Assistant's best ideas (registries, areas,
derived helpers, storage-mode dashboards) without its limitations (single-home, no multi-tenancy,
nesting-hostile editor)"_ — and it cites HA's sections-view layout and HA's nesting mistakes as
direct precedents for the v4 document model.

So the two are worth comparing carefully: not to copy HA wholesale, but to know exactly where we
mirror it, where we diverge, and why. This doc is the honest scorecard — including where the honest
answer moved against us.

## The one asymmetry that explains everything

A fair comparison separates the **object model** (where we map onto HA cleanly — partly by design)
from the **runtime/storage architecture** (where we diverge because the _problem domains_ diverge):

- **Home Assistant is a real-time _control plane_ for one home.** Thousands of _heterogeneous_
  devices and **actuators** (lights, locks, switches), single-tenant, mostly local. It is
  **write/command-heavy** and **latency-sensitive** ("press button → light turns on"), so its source
  of truth is an **in-memory state machine**. Durable history is a secondary concern: the recorder
  purges `states` and `statistics_short_term` after ~10 days by default, keeping only hourly
  long-term statistics indefinitely.
- **LiveOne is a durable _observability and attribution pipeline_ for many sites.** A _narrow_,
  homogeneous signal set (power / energy / SOC / price / grid intensity), multi-tenant, cloud. It is
  **read/aggregate-heavy** and **durability-critical** (losing a reading is a data-integrity bug, not
  a missed light), with **almost no actuators**. Source of truth is **durable Postgres**, retained in
  full at every tier; KV is a derived fast-read.

The actuator caveat is narrower than it used to be: Tesla charge control ships as a real command path
(`POST /api/systems/[id]/tesla/command` — `charge_start` / `charge_stop` / `set_charge_limit`, through
the Fleet client's signer seam). But it is _one route in the web tier_, not a command plane — no
service registry, no uniform invocation contract, and the engine Control API in
`engine-web-separation.md` is still unbuilt.

Almost every difference below falls out of that asymmetry. Keep it in mind so the comparison stays
fair: HA "wins" on generality, identity, semantic vocabulary and control because it must tame
_heterogeneity_ and _control_ for _end-users_ in _one_ home; LiveOne "wins" on durability,
recomputability, attribution and multi-tenant sharing because it must _not lose data_, _serve
aggregates fast to many tenants_, and _partition access for real_.

## Language & stack

|                   | Home Assistant                                                                                                                                                                            | LiveOne                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core language     | **Python**, entirely on **`asyncio`** (one event loop on the `hass` object; integrations are `async` coroutines, blocking I/O pushed to executor threads). Tracks recent Python releases. | **TypeScript** end-to-end                                                                                                                                 |
| Frontend          | TypeScript / **Lit** (web components) — Lovelace                                                                                                                                          | TypeScript / **Next.js** (React)                                                                                                                          |
| Runtime shape     | Long-lived **process you host** — can hold authoritative state in RAM                                                                                                                     | **Stateless serverless** (Vercel, `syd1`) — no in-RAM authoritative state, so state lives in KV + Postgres                                                |
| Time-series store | SQLite (default) / MariaDB / PostgreSQL via the _recorder_, with default purge                                                                                                            | PostgreSQL (PlanetScale) as the sole datastore, retained at every tier; Vercel KV as a derived latest-value cache                                         |
| Config store      | **JSON documents under `.storage/`** (entity / device / area / floor / label / category registries, Lovelace docs, energy prefs), loaded into memory at boot                              | **SQL tables in the same Postgres** (`devices`, `points`, `areas`, `area_members`, `area_bindings`, `derivations`, `dashboards`) with real FKs and CHECKs |
| Release cadence   | Monthly (`2026.7` at time of writing), with published deprecation runways                                                                                                                 | Continuous deploy from `main`                                                                                                                             |
| Distribution      | Core / Supervisor / OS / Container + add-ons                                                                                                                                              | Single Vercel deployment                                                                                                                                  |

Two structural consequences. **Runtime shape**: HA _can_ keep the current world in memory and act on
it instantly; we can't, so we lean on a durable store plus a fast cache. **Config store**: HA's
registries are JSON documents whose referential integrity is code-only and can drift; ours are SQL
rows that can't dangle — which buys us enforcement and costs us HA's zero-migration schema evolution.

## Object-model mapping

| LiveOne (config-v4)                                                                    | Home Assistant                                                                                               | Mapping quality                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices` (uuid, wire `dv_…`; `rid` int; `vendor` + `vendor_site_id`)                  | **Config entry → subentry → Device** _(three tiers)_                                                         | **Ours is flat, deliberately** — and HA has since gone further the other way (subentries). See "Where HA is clearer" #1                           |
| `points` (uuid `pt_…`; `rid` int)                                                      | **Entity** (`unique_id` → `entity_id`)                                                                       | Clean, and identity is now clean too                                                                                                              |
| `points.id` = `uuidv5(vendor : vendor_site_id : physical_path)`                        | entity **`unique_id`** (vendor-stable, never user-configurable)                                              | **Clean** — both stable, vendor-derived, reproduced on re-onboarding                                                                              |
| `points.rid` → `point_readings(point_rid, measurement_time)`                           | `states_meta.metadata_id` / `statistics_meta.id`                                                             | **Convergent evolution** — the same int-surrogate-in-hot-tables trick, reached independently                                                      |
| `points.physical_path` (`selectronic/solar_w`)                                         | the vendor half of `unique_id`                                                                               | Clean                                                                                                                                             |
| `points.logical_path` + `metric_type` (`source.solar` / `power`)                       | `device_class` (60+) + `state_class` (4)                                                                     | **Leaky, and far narrower** — one path carries semantic type _and_ aggregation hint, over a vocabulary a fraction of HA's                         |
| `points.name` / `default_name`                                                         | registry **name override** vs `has_entity_name` composition                                                  | **Ours is flatter** — HA composes `friendly_name` from device name + entity name                                                                  |
| `points.unit`                                                                          | `native_unit_of_measurement` + `suggested_unit_of_measurement` + `unit_class` converters + per-user override | **HA is much deeper** — we have one fixed string per point and no model-layer conversion                                                          |
| `points.transform` (`d`=delta) + agg rules keyed on `metric_type`                      | **`state_class`** (`measurement` / `total` / `total_increasing` / `measurement_angle`)                       | Same intent, theirs first-class; theirs also carries `last_reset` and reset detection                                                             |
| `points.active`                                                                        | `available` + `entity_category` (config / diagnostic)                                                        | **Ours is a single on/off** — HA separates "can't read it right now" from "this is a secondary/diagnostic signal"                                 |
| `lib/roles/registry.ts` (6 roles, carries `device_class`/`state_class`/`unit`)         | _(no native table)_ — Energy-dashboard role slots                                                            | **Explicitly HA-aware** — our export bridge in waiting. v4 deletes its SQL projection (`roles`); `area_bindings_role_check` holds the vocabulary. |
| `areas` (uuid `ar_…`; owns `day_offset_min`, `display_timezone`, `location`, `config`) | **Area** registry (+ configured primary temperature/humidity sensors)                                        | Close — and converging: HA areas have started acquiring per-role sensor slots of their own                                                        |
| `area_members` (area ↔ device, many-to-many)                                          | device's single `area_id`                                                                                    | **Ours is more general** — a device can belong to several areas; HA allows exactly one                                                            |
| `area_bindings` (role→point, `priority`, shape-validated, FK + CHECK)                  | Energy "preferences" — `energy_sources[]` with `flow_from`/`flow_to`, `stat_cost`, `device_consumption[]`    | Same job. Ours is enforced SQL with deterministic per-slot resolution; theirs is a JSON doc with per-source cost/price fields we lack             |
| `derivations` / `derived_intervals` (+ per-run cost / emissions / renewable)           | Helper integrations (Threshold, Integration, Derivative, Utility Meter, Template, Group)                     | Same intent — **one mechanism now**, but our kinds are code-typed where HA's are user-composable                                                  |
| `dashboards.doc` (recursive node tree) + `dashboard_revisions`                         | **Lovelace** storage-mode dashboard, **or a generated _strategy_**                                           | Close in shape; ours adds revisions + `If-Match`. HA additionally generates dashboards from the registries at render time (strategies)            |
| `share_tokens` (one token → one dashboard) / `dashboard_grants`                        | _(none — `require_admin`, and per-view `visible` is cosmetic hiding)_                                        | No mapping — see "Where ours may be superior" #4                                                                                                  |
| `device_state` (1:1 with `devices`; per-poll health)                                   | config-entry state + integration diagnostics                                                                 | Ours is a first-class table; HA's is in-memory + downloadable diagnostics                                                                         |
| `legacy_handles` / `dashboards.legacy_id`                                              | _(none)_                                                                                                     | No mapping — our sanctioned permanent compat shims                                                                                                |
| KV latest cache + newest `point_readings`                                              | **State machine** `State` (in-memory)                                                                        | Functional analog (theirs authoritative in-RAM, ours a derived cache)                                                                             |
| `point_readings` (raw, durable, retained)                                              | recorder `states` (+ `states_meta`, `state_attributes`), purged ~10 days                                     | **Different contract** — theirs is a rolling window, ours is the permanent source of truth                                                        |
| `point_readings_agg_5m` / `agg_1d` (both retained)                                     | `statistics_short_term` (5m, ~10d) / `statistics` (hourly, indefinite)                                       | **Strikingly parallel**; cadence, retention _and_ statistical semantics all differ                                                                |
| `point_readings_flow_attr_1d` (materialized, attributed, versioned)                    | Sankey energy card + power-flow Sankey (derived at render)                                                   | **Both exist now** — ours persisted and metric-attributed, theirs computed per view but structured by floors/areas/device hierarchy               |
| `battery_provenance_daily` (learned η / C / fold checkpoints)                          | _(none)_                                                                                                     | No mapping — HA's battery model is round-trip efficiency from in/out sensors                                                                      |
| `sessions` (poll provenance, vendor response)                                          | _(none)_                                                                                                     | No mapping — HA keeps no per-poll record                                                                                                          |
| `observations_outbox` + QStash + receiver                                              | event bus (`state_changed`) + recorder write                                                                 | No mapping — **different reliability model**                                                                                                      |
| —                                                                                      | **Floor** registry (parent of Area)                                                                          | **Absent in ours**                                                                                                                                |
| —                                                                                      | **Label** registry (areas, devices, entities, automations, scenes, scripts, helpers)                         | **Absent in ours** — v4 kept it as an explicit deferred seam                                                                                      |
| —                                                                                      | **`via_device`** device hierarchy + energy **upstream device** (2025.4)                                      | **Absent in ours** — no device tree, no sub-metering containment                                                                                  |
| `lib/vendors/*` adapters + registry                                                    | **Integration + platform** (`manifest.json`, config-flow, coordinators)                                      | Clean structurally; HA `iot_class` ≈ our `dataSource` (poll/push/combined)                                                                        |

_Not in the table: HA's **Category** registry. It looks like a missing dimension but isn't — categories
are per-table UI grouping for the automation / scene / script / helper lists and "have no effect
anywhere else". They don't apply to entities or devices, and we have no automation lists to group._

## Where Home Assistant is clearer / more general

Real design advantages. The first two are new to this revision and are the sharpest findings in it.

1. **Containment — and HA has extended its lead.** HA's chain is now **config entry → config
   subentry → device → entity**, with cascade delete throughout. Subentries exist precisely to let
   _one_ connection hold _many_ logical configurations — the canonical example being credentials in
   the parent entry with one subentry per location. Config-v4 declined the config-entry/device split
   on the grounds that _"LiveOne's point namespace, credential scope, and polling unit are all 1:1
   with the vendor connection; a second table buys nothing until one connection yields multiple
   independently-addressable devices"_ (§4.1). That reasoning still holds for today's adapters — but
   HA has since built exactly the mechanism for exactly that case, so the decision should be re-read
   as _deferred_, not settled. The first multi-site vendor connection we onboard is the trigger.
   (Where we _are_ more general: `area_members` is many-to-many, so one site can span devices and one
   device can appear in several areas; HA pins a device to exactly one area.)
2. **Two hierarchies we don't have at all.** `via_device` gives HA a **device tree** (hub → child
   device, power strip → outlet), and since **2025.4** the energy dashboard has an explicit
   **upstream device** relation for sub-metering: mark a breaker as upstream of the devices on its
   circuit and HA stops double-counting them. Our load side is roles plus a synthetic
   `load.rest-of-house` — there is no way to say "this circuit contains these three loads", so the
   arithmetic that HA does structurally, we do by subtraction. Of everything in this document, this
   is the idea most worth stealing.
3. **Floors and Labels.** Floor is a strict parent of Area (devices and entities attach to areas
   only). **Labels** are the valuable one: an orthogonal many-to-many tag applicable to areas,
   devices, entities, automations, scenes, scripts and helpers, usable both as a table filter and as
   an automation _target_. We have a single Area tier. v4 absorbed the identity half of
   [`identity-address-split-and-labels.md`](../plans/identity-address-split-and-labels.md) and parked
   the label half deliberately (§12.7).
4. **A far richer semantic vocabulary.** HA has 60+ `device_class`es, four `state_class`es (including
   `measurement_angle`), `entity_category` (config / diagnostic) to demote secondary signals,
   `has_entity_name` composition so `friendly_name` is derived rather than stored,
   `suggested_display_precision`, and a real unit model: `native_unit_of_measurement` vs
   `suggested_unit_of_measurement`, automatic device-class-driven conversion, per-user overrides held
   in the entity registry, and `unit_class` naming the converter. We have six roles, a handful of
   `metric_type`s, one fixed unit string per point, flat names, and no conversion anywhere in the
   model. This is the largest _breadth_ gap between the two systems.
5. **State = string + open-ended attributes dict.** Any HA integration attaches arbitrary
   supplementary data with no schema change. Our reading is fixed-column (`value` / `value_str` /
   `error` / `data_quality`) — more rigid, though that rigidity is what buys typed aggregation.
   (`devices.adapter_state` gives adapters a per-device escape hatch, not a per-reading one.)
6. **Service/event decoupling.** `call_service` (imperative) vs `state_changed`/event-bus
   (observation), uniform across 1000+ integrations. We have one bespoke command route, no registry,
   and the FE→engine command pattern remains direction-of-travel.
7. **Config flow as a uniform onboarding contract.** `user` / `discovery` / `zeroconf` / `reauth` /
   `reconfigure` as standard steps (plus subentry reconfiguration), with `async_set_unique_id` dedup.
   Ours is narrower with no discovery or reauth taxonomy — notable given Tesla and Enphase tokens
   expire.
8. **The helper / template ecosystem — still HA's crown jewel.** _Integration_ (Riemann sum, W→kWh),
   _Derivative_, _Utility Meter_ (cycle/tariff), _Template_, _Group(sum)_ let users compose new typed
   entities purely through config. v4's `derivations` closed the embarrassing half of this gap —
   run-tracking and the HWS thermal model are now one mechanism (`output='point'` → a derived point
   in the pipeline; `output='intervals'` → run periods) with typed `params`/`source_points` as data.
   But the **kinds** are code (`run-detector`, `hws-model`): an engineer ships a kind, where an HA
   user configures one.
9. **Statistics semantics — HA is ahead, and further ahead than the last revision said.** HA's mean
   is **time-weighted** (ours is a plain sample mean, biased under irregular sampling); it detects
   counter resets on `total_increasing` with a >10% tolerance and honours `last_reset` on `total`;
   and since the Oct-2025 recorder API it carries `mean_type` (`arithmetic` / `circular`, the latter
   for angle-like quantities) and `unit_class`. **Correction to the previous revision:** HA is _not_
   forward-only — `async_import_statistics` / `async_add_external_statistics` are first-class APIs for
   writing statistics at arbitrary past timestamps, and re-importing the same timestamps replaces the
   existing rows. Backfill is supported and used in production by energy-provider integrations. The
   real difference is described under "Where ours may be superior" #2, and it isn't "can they
   backfill" — it's what the backfill is computed _from_.
10. **Dashboards can be generated, not just stored.** HA _strategies_ build a whole dashboard (or a
    single view) at render time by querying the registries — the default Home dashboard in 2026.2 is
    one. A new device appears without anyone editing a document. Our `/areas/{id}/default-group`
    seeds a stored doc once at creation; after that the doc is authoritative and drifts from reality
    until someone edits it. Both models have a place — HA's "take control" (snapshot the generated
    doc and start editing) is the bridge between them, and we have no equivalent.

## Where we are more constrained

- **`devices` fuses config entry and device** (see #1 above), so an HA export must choose a level, and
  we cleanly model only single-device connections.
- **Vendor coupling leaks upward** via `physical_path`; HA hides vendor specifics behind the
  integration boundary so everything above the entity is vendor-agnostic. `logical_path` exists to
  recover this, but the physical path remains a first-class, uniquely-indexed column.
- **`legacy_handles` and `dashboards.legacy_id` are permanent seams** HA never carries — it mints
  opaque IDs freely, while we froze the old integer space so `?systemId=N` and `/dashboard/id/{n}`
  resolve forever. Sanctioned shims, but shims.
- **`sessions` and `observations_outbox` keep an int `device_rid`** rather than the uuid (§12.1) — a
  deliberate deviation, the seam working as designed, but it means two tables address devices
  differently from everything above them.
- **Composite provenance collapses** at `flow_attr_1d`, which is path-keyed
  `(area_id, day, source_path, load_path)` rather than point-keyed, so aggregated multi-point sources
  get a stable identity at the cost of "which physical meter" being unrecoverable from the flow row.
  HA can't express "total solar across 3 inverters" as a persisted entity without a Group helper that
  collapses provenance the same way — a fair trade, not a deficiency.
- **The document is one JSONB blob** (§12.2). Deliberate — nothing queries cards in SQL, and
  normalization would create two sources of truth — but it does mean no SQL query can answer "which
  dashboards show this point" without walking documents.

## Where ours may be superior

Genuine wins, with the domain-difference discount applied honestly.

1. **Single-writer + transactional-outbox ingest durability — GENUINE WIN.** `observations_outbox` is
   committed _before_ the QStash enqueue; an idempotent single-writer receiver
   (`/api/observations/receive`) materializes it; the relay replays. At-least-once and rebuildable,
   across a network boundary, without a heavyweight log — and it is what made the Phase-8 cutover
   survivable (pausing materialization never stopped collection). **HA's pipeline is fire-and-forget
   in-process**: a `state_changed` the recorder misses (crash, DB stall) is simply lost. HA doesn't
   _need_ this — an in-memory control plane has different durability requirements — but for a durable
   pipeline it is a real advantage.
2. **Retained raw data + deterministic recompute — GENUINE WIN, and the correct framing of the
   backfill point.** HA can write past statistics (#9 above), but it cannot _recompute_ them from
   source: by the time you want to, the underlying states are purged. An import therefore _asserts_
   history. Ours _derives_ it — every tier is retained permanently, aggregates recompute
   order-independently from raw on every insert, and `flow_attr_1d` carries an algorithm `version` so
   a corrected model can be replayed across years of history and dedup itself. Our agg rows also
   carry `sample_count` / `error_count` / `data_quality`, so a recompute knows what it's standing on.
   The Sigenergy sign-convention repair (July 2026) was exactly this capability being cashed in;
   under HA's model it would have been an import script and a leap of faith.
3. **Materialized, metric-attributed energy flows — NARROWER THAN CLAIMED, still a win.** The
   previous revision called the Sankey a clear win; that was out of date. HA now ships a **core
   Sankey energy card**, a real-time **power-flow Sankey**, and a water equivalent, and it structures
   them better than we can — grouping consumers by floor and area and respecting the upstream-device
   hierarchy. What actually survives as ours:
   - **Persistence and shape.** `point_readings_flow_attr_1d` materializes
     `(area_id, day, source_path, load_path) → energy_kwh` per local day, built from 5-minute data
     (not daily, whose averages cancel direction), with direction encoded by slot (battery
     charge→`load.battery`, discharge→`source.battery`; grid import→`source.grid`,
     export→`load.grid`). A multi-day range is a plain `SUM … GROUP BY`, identical for every viewer.
     HA recomputes per view in the browser.
   - **Attribution per edge.** Each flow carries `emissions_g`, `renewable_kwh` and `cost_c`, derived
     from grid intensity (OpenElectricity / Amber) and a learned battery-provenance blend, plus
     `estimated_kwh` as a confidence denominator and `finalized_at` for the ~72h estimated→final
     cutoff. `derived_intervals` accumulates the same three metrics per generator run. HA has
     per-source **cost** natively (`stat_cost` / `entity_energy_price` / `number_energy_price`) and a
     whole-home grid fossil-fuel percentage via Electricity Maps — but not per-edge attribution, and
     nothing that answers _"what did it cost, how green was it, to charge the EV in July"_.
   - **Verdict:** we are ahead on attribution, determinism and multi-tenant serving; HA is ahead on
     consumer-side structure. Neither is a superset.
4. **Multi-tenant sharing that is actually access control — WIN, and bigger than it looked.**
   `share_tokens` (one token → one dashboard) and `dashboard_grants` (admin/viewer) resolve scope
   **live from the dashboard document on every read** — Dashboard → its nodes' envelope refs →
   exactly those points — and v4 makes that safe by construction: scope-bearing references may live
   _only_ in fixed envelope fields, never inside a card's `config`, so the scope walk is type-agnostic
   and an unknown card type cannot smuggle a reference past it (§8.3). HA is single-tenant: dashboards
   offer `require_admin`, and per-view `visible` is **cosmetic hiding, not authorization** — the data
   remains reachable through the API. This is not a domain-difference discount; it is a different
   security posture.
5. **Typed bindings with deterministic slot resolution — WIN on rigour.** `area_bindings` are SQL rows
   with real FKs and a CHECK on the role vocabulary (the `roles` table, a second source of truth
   mirroring `lib/roles/registry.ts`, is deleted precisely because the CHECK does the job). On top:
   **`priority`-ordered per-slot resolution** (explicit binding → unique shape match → area-config
   producer → absent, with "two candidates, no binding" surfaced as a choice rather than silently
   picked, and a `/areas/{id}/resolution` report to explain it) and **bind-time shape validation**
   (a point whose `(logical_path, metric_type)` doesn't fit the role is rejected). HA's energy prefs
   are one entity per slot in a JSON document with no priority, no validation and no explanation of
   what auto-connected. Worth noting the convergence, though: HA areas have started acquiring their
   own per-role sensor slots (configured primary temperature/humidity sensors) — the same idea,
   arrived at from the other direction.
6. **Versioned documents with optimistic concurrency — SMALL BUT REAL WIN.** `dashboard_revisions`
   keeps whole-doc snapshots with `saved_by`/`saved_at`; the v4 PUT is `If-Match`-checked (412 on a
   stale revision) and echoes the normalized canonical document so client state can't drift; restore
   copies forward rather than rewinding. Lovelace's storage-mode document has no history and no
   concurrency check — last write wins.
7. **Fixed-offset day bucketing, decided rather than defaulted — DOMAIN WIN.** `areas.day_offset_min`
   is the canonical bucketing key (immutable except via an explicit re-bucket that regenerates
   `agg_1d` / `flow_attr_1d` / provenance); `display_timezone` is formatting only. **Every day is
   exactly 24 hours**, so 5m→1d rollups stay idempotent and daily comparisons carry no asterisk — and
   it matches the domain, since AEMO settles the NEM in fixed AEST year-round. HA stores hourly
   statistics and derives local days at query time, inheriting 23/25-hour DST days. For home
   automation that's right; for energy accounting ours is.
8. **Engine/web separation + the rid seam — MIXED / domain-appropriate.** The cloud-scaling split
   (collection vs serving, single-writer contract, KV-as-engine-write / web-read) is something HA has
   no need for — calling it superior is mostly a category error. The `uuid ↔ rid` seam is a real
   ergonomic win for join-heavy time-series (and at `(point_rid, time)` is 4 bytes per index entry
   _smaller_ than the v3 composite) but it is convergent with, not ahead of, HA's `metadata_id`.
   Where we _are_ ahead is enforcement: the boundary is machine-checked (`no-restricted-imports` plus
   a prebuild gate), uuids above and rids below, permanently.

**Honest deductions:** our command plane is one bespoke route where HA's service registry is mature
and uniform; our no-code composition is absent where HA's helper ecosystem is its crown jewel; our
semantic vocabulary is a fraction of HA's and has no unit conversion at all; our plain-mean
aggregation is simply worse than HA's time-weighted mean; and we have no answer to sub-metering
containment.

## The deliberate deviations, HA-side

Config-v4 §12 records seven choices made _against_ the clean sheet. Four are HA-facing, and are the
places where "we don't do what HA does" is a decision rather than a gap:

| Deviation                                                         | HA does                                                        | Why we don't                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **No device or area ACLs** — the dashboard is the only share unit | no ACLs either, but also no sharing model at all               | a third grant surface is speculative; dashboard scope is derived live and already least-privilege |
| **The document stays one JSONB blob**                             | Lovelace is also one document                                  | cards are layout-coupled presentation; normalization = two sources of truth                       |
| **Labels deferred**                                               | Labels across seven object types, usable as automation targets | clean future add; nothing reads them yet — the cheapest HA idea still on the table                |
| **Fixed-offset days**                                             | DST-aware local days derived from hourly UTC statistics        | market time has no DST; 23/25-hour days break idempotent rollups                                  |

## Verdict

**Home Assistant is the more general and elegant object model, semantic vocabulary and control
runtime; LiveOne is the more rigorous durable, multi-tenant, attribution-first data pipeline.**

The second pass moved the scorecard in both directions. Against us: HA's containment now goes one
tier deeper than when we declined it, it has two hierarchies we lack entirely, it ships a core Sankey
we thought was our differentiator, and its statistics can be backfilled after all. For us: the
sharing story is stronger than "multi-tenant" made it sound (HA's per-view hiding is not access
control), and the recompute story is the right way to state the durability advantage — HA can assert
history, only we can re-derive it.

Remaining borrowings worth considering, in rough order of value-per-risk:

1. **Sub-metering containment** — an upstream/parent relation between points or devices, so circuit
   totals stop being a subtraction. HA's 2025.4 energy hierarchy is the model.
2. **Labels** — an orthogonal tag dimension on any object. Already parked as a deferred seam.
3. **`entity_category`-style demotion** — separate "diagnostic/secondary" points from primary ones so
   pickers and default dashboards stop showing everything at once.
4. **Reauth as a first-class onboarding step** — we need it anyway; HA has the taxonomy.
5. **Unit classes** — model-layer conversion, so display units stop being baked into the point.
6. **Time-weighted means** in the 5-minute rollup — the one place HA's statistics are plainly more
   correct than ours.
7. **A strategy-style generated view** — a dashboard (or one group) rendered live from the registries
   so newly-onboarded devices appear without a document edit.
8. **User-composable derivation kinds** — the long pole, and the one that would turn `derivations`
   from an internal mechanism into a user-facing feature.

## Related docs

- [`../plans/config-v4-clean-sheet.md`](../plans/config-v4-clean-sheet.md) — the canonical rationale;
  §4.1 records the non-adoption of HA's config-entry/device split, §8 the document model (with its
  explicit HA precedents), §12 the deliberate deviations.
- [`../plans/config-v4-execution-plan.md`](../plans/config-v4-execution-plan.md) — what has landed and
  what Phases 12–14 still finish.
- [`areas-and-dashboards.md`](areas-and-dashboards.md) — the Device→Area→Dashboard split and the
  original HA bridge table (partly overturned by the clean sheet).
- [`points.md`](points.md) — the point model, paths, and identity.
- [`data-model.md`](data-model.md) — data semantics & invariants.
- [`engine-web-separation.md`](engine-web-separation.md) — ingest durability (outbox), engine/web
  split, the (planned) FE→engine command pattern.
- [`energy-flow-matrix.md`](energy-flow-matrix.md) — the directional Sankey matrix.
- [`battery-provenance.md`](battery-provenance.md) — the metric legs attached to those flows.

## Revision history

- **2026-07-28 (second pass)** — deeper HA verification against the developer docs, and LiveOne
  restated as finished config-v4 rather than a migration in progress. Material corrections: HA config
  **subentries** (containment went deeper, not away); `via_device` + the **2025.4 energy device
  hierarchy** (two hierarchies we lack); HA's **core Sankey / power-flow / water Sankey cards**
  (narrows our flow-matrix claim); **statistics backfill is supported** via
  `async_import_statistics` (the previous revision was wrong — the real distinction is
  assert-vs-derive); HA's **unit model and 60+ device classes** (a breadth gap the doc had understated);
  **Category** demoted to a footnote (per-table UI grouping, not an entity dimension); HA per-view
  `visible` identified as **cosmetic, not authorization** (strengthens our sharing claim). Added the
  deliberate-deviations table and dashboard **strategies** as a new axis.
- **2026-07-28 (first pass)** — refreshed for config-v4 and HA 2026.7.
- **2026-07-21** — original, written against the v3 model alongside the config-v4 clean sheet.
