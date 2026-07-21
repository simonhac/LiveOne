# LiveOne vs. Home Assistant — architecture & object model

> **Status:** current as analysis; for design decisions it is superseded by
> [config-v4-clean-sheet.md](../plans/config-v4-clean-sheet.md) (2026-07-21), which carries the
> HA-relationship choices forward. An analytical comparison, not a spec.
> Where it describes LiveOne, the source of truth is `lib/db/planetscale/schema.ts` +
> `docs/architecture/{overview,data-model,areas-and-dashboards,engine-web-separation}.md`.
> Where it describes Home Assistant, it reflects the HA developer docs as of mid-2026
> (HA changes fast — treat HA specifics as indicative).

## Why this doc exists

LiveOne's own design (`areas-and-dashboards.md`) deliberately borrows Home Assistant
vocabulary — System→Device, Point→Entity, Area→Area, `area_bindings`→Energy-dashboard
config — and the `roles` table literally stores `ha_device_class` / `ha_state_class` /
`ha_unit` against a planned HA export bridge. So the two systems are worth comparing
carefully: not to copy HA wholesale, but to know exactly where we mirror it, where we
diverge, and why. This doc is the honest scorecard.

## The one asymmetry that explains everything

A fair comparison separates the **object model** (where we map onto HA very cleanly — partly
by design) from the **runtime/storage architecture** (where we diverge because the _problem
domains_ diverge):

- **Home Assistant is a real-time _control plane_ for one home.** Thousands of
  _heterogeneous_ devices and **actuators** (lights, locks, switches), single-tenant, mostly
  local. It is **write/command-heavy** and **latency-sensitive** ("press button → light turns
  on"), so its source of truth is an **in-memory state machine**. Durable history
  (recorder/statistics) is a secondary, best-effort bolt-on.
- **LiveOne is a durable _observability/metrics pipeline_ for many sites.** A _narrow_,
  homogeneous signal set (power / energy / SOC / price), multi-tenant, cloud. It is
  **read/aggregate-heavy** and **durability-critical** (losing a reading is a data-integrity
  bug, not a missed light), with **no actuators** in the core loop (Tesla charge control is a
  noted Phase-2 edge). Source of truth is **durable Postgres**; KV is a derived fast-read.

Almost every difference below falls out of that asymmetry. Keep it in mind so the comparison
stays fair: HA "wins" on generality/identity/control because it must tame _heterogeneity_ and
_control_ for _end-users_ in _one_ home; LiveOne "wins" on durability/aggregation/sharing
because it must _not lose data_, _serve aggregates fast to many tenants_, and _partition
access_.

## Language & stack

|               | Home Assistant                                                                                                                                                                            | LiveOne                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Core language | **Python**, entirely on **`asyncio`** (one event loop on the `hass` object; integrations are `async` coroutines, blocking I/O pushed to executor threads). Tracks recent Python releases. | **TypeScript** end-to-end                                                                                         |
| Frontend      | TypeScript / **Lit** (web components) — Lovelace                                                                                                                                          | TypeScript / **Next.js** (React)                                                                                  |
| Runtime shape | Long-lived **process you host** — can hold authoritative state in RAM                                                                                                                     | **Stateless serverless** (Vercel, region `syd1`) — no in-RAM authoritative state, so state lives in KV + Postgres |
| Datastore     | SQLite (default) / MariaDB / PostgreSQL via the _recorder_                                                                                                                                | PostgreSQL (PlanetScale) as the sole datastore; Vercel KV as a derived latest-value cache                         |
| Distribution  | Core / Supervisor / OS / Container + add-ons                                                                                                                                              | Single Vercel deployment from `main`                                                                              |

The runtime shape alone drives much of the divergence: HA _can_ keep the current world in
memory and act on it instantly; we can't, so we lean on a durable store plus a fast cache.

## Object-model mapping

| LiveOne                                                                         | Home Assistant                                                   | Mapping quality                                                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `point_info` row, addressed `(system_id, id)`                                   | **Entity** (`unique_id` → `entity_id`)                           | **Clean concept, weaker identity** — see "How ours maps onto theirs"                                                     |
| `point_info.physical_path_tail` (`selectronic/solar_w`)                         | entity **`unique_id`** (vendor-stable)                           | Clean — both the stable, vendor-derived, non-user identity                                                               |
| `point_info.logical_path_stem` + `metric_type` (`source.solar`/`power`)         | `device_class` + `state_class` + energy-role                     | **Leaky** — we overload one path to do all three jobs                                                                    |
| `point_info.display_name` (editable) vs `point_name` (default)                  | entity registry **name override** vs device-supplied name        | Clean                                                                                                                    |
| `point_info.metric_type` / `metric_unit`                                        | **`device_class`** + **`unit_of_measurement`**                   | Mostly clean (we lack model-layer unit conversion W↔kW)                                                                 |
| `point_info.transform` (`d`=delta) + agg rules keyed on `metric_type`           | **`state_class`** (`measurement` / `total` / `total_increasing`) | Same intent, different mechanism (theirs first-class, ours inferred)                                                     |
| `roles` (stores `ha_device_class` / `ha_state_class` / `ha_unit`)               | _(no native table)_ — Energy-dashboard role slots                | Clean & **explicitly HA-aware** — our bridge-in-waiting                                                                  |
| `systems` row (integer `id`, `vendor_type`, `vendor_site_id`, `model`/`serial`) | **Config entry + Device** _(fused)_                              | **Leaky/merged** — we fuse connection-instance and device into one row                                                   |
| `areas` (`kind=identity\|composite`, `legacy_system_id`, `location`)            | **Area** registry                                                | **Overloaded** — ours is room + logical-system + aggregation-scope; `kind=composite` has no HA analog                    |
| `area_bindings` (typed role→point edges, FK to `point_info` + `roles`)          | Energy "preferences" (role→entity)                               | Clean & direct; **ours FK-enforced, theirs JSON in `.storage`**                                                          |
| `dashboards.descriptor` (jsonb) + cards                                         | **Lovelace** dashboard + cards                                   | Clean — presentation referencing points by id; auto-generated default                                                    |
| KV latest cache + newest `point_readings`                                       | **State machine** `State` (in-memory)                            | Functional analog (theirs authoritative in-RAM, ours a derived cache)                                                    |
| `point_readings` (raw, durable, SQL)                                            | recorder `states` table                                          | Theirs is best-effort history; ours is the source of truth                                                               |
| `point_readings_agg_5m` / `agg_1d`                                              | `statistics_short_term` (5m) / `statistics` (hourly)             | **Strikingly parallel**; semantics differ (see below). Cadence mismatch: our coarse tier is **daily**, theirs **hourly** |
| `point_readings_flow_1d` (directional Sankey matrix)                            | _(none — computed at query time)_                                | No mapping — we materialize, HA derives on the fly                                                                       |
| `sessions` (poll provenance, vendor response)                                   | _(none)_                                                         | No mapping — HA keeps no per-poll record                                                                                 |
| `observations_outbox` + QStash + receiver                                       | event bus (`state_changed`) + recorder write                     | No mapping — **different reliability model**                                                                             |
| `device_trackers` / `device_run_periods`                                        | Threshold helper (`binary_sensor`) + recorder history            | Same intent ("HA-style threshold helper"); we persist richer run-periods + energy attribution                            |
| `dashboard_grants` / `dashboard_share_tokens`                                   | _(none — single-tenant)_                                         | No mapping                                                                                                               |
| —                                                                               | **Floor** registry                                               | **Absent in ours** (no floor tier)                                                                                       |
| —                                                                               | **Label** registry                                               | **Absent in ours** (no orthogonal tag dimension)                                                                         |
| `lib/vendors/*` adapters + registry                                             | **Integration + platform** (`manifest.json`, config-flow)        | Clean structurally; HA `iot_class` ≈ our `dataSource` (poll/push/combined)                                               |

## Where Home Assistant is clearer / more general

Real design advantages, mostly orthogonal to the domain difference — several we could adopt.

1. **Three-way identity split.** HA separates _durable identity_ (`unique_id`,
   non-user-configurable, the thing that makes a registry entry exist), _renameable address_
   (`entity_id` = `domain.object_id`), and _device identity_ (`identifiers`/`connections`,
   with cross-integration dedup via MAC). We fuse identity **and** address into one composite
   integer `(system_id, point_id)` — no rename-safe alias, no global namespace.
   `physical_path_tail` is our only stable token, and it isn't the addressing key. _(This is
   the motivation for the `point_uid` proposal in
   `../plans/identity-address-split-and-labels.md`.)_
2. **`config entry → device → entity` containment.** One HA integration instance owns _many_
   devices, each many entities, with cascade delete. Our flat `systems → point_info` (one row
   is connection + device) is _exactly_ why we had to invent `areas`/`area_bindings` — we
   can't natively model "one logical site spanning multiple physical devices."
3. **Floor + Label.** Two grouping dimensions we lack entirely: Floor (hierarchical:
   Floor → Area → device/entity) and Label (orthogonal many-to-many tag on _any_ object —
   area, device, entity, automation, dashboard). We have a single Area tier. _(Motivates the
   Label proposal in `../plans/identity-address-split-and-labels.md`.)_
4. **State = string + open-ended attributes dict.** Any integration attaches arbitrary
   supplementary data with no schema change. Our reading is fixed-column (`value` /
   `value_str` / `error` / `data_quality`) — more rigid, though that rigidity is what buys
   typed aggregation.
5. **Service/event decoupling.** `call_service` (imperative command) vs
   `state_changed`/event-bus (observation), uniform across 1000+ integrations. Our FE→engine
   **command plane is aspirational** (`engine-web-separation.md`); only the observation
   pipeline is mature.
6. **Config-flow as a uniform onboarding contract** — `user` / `discovery` / `zeroconf` /
   `reauth` / `reconfigure` as standard steps, with `async_set_unique_id` dedup. Our
   add-system flow (`credentialFields`, `credentials`/`oauth-redirect`) is narrower with no
   discovery/reauth taxonomy.
7. **The helper / template ecosystem — HA's crown jewel.** _Integration_ (Riemann sum,
   W→kWh), _Derivative_ (kWh→W), _Utility Meter_ (cycle/tariff), _Template_ (arbitrary typed
   Jinja sensor), _Group(sum)_ (N entities → 1) let users **compose new typed points purely
   through config**. Our derived points (`load.rest-of-house`, synthetic totals, HWS model)
   are **code-defined** — an engineer builds what an HA user just configures.
8. **`device_class` ⊥ `state_class` ⊥ energy-role.** HA keeps semantic type, aggregation
   behavior, and energy-dashboard role as three separate axes. We overload
   `logical_path_stem` + `metric_type` to carry all three.

## How ours maps onto theirs

Surprisingly well at the **semantic layer** — because we deliberately borrowed the vocabulary
and even store `ha_device_class` / `ha_state_class` / `ha_unit` in `roles` with an
MQTT-Discovery export bridge planned (areas P5). Point→Entity, Area→Area,
`area_bindings`→Energy preferences, dashboards→Lovelace all translate directly.

Where we're **more constrained**:

- **Integer composite addressing** `(system_id, point_id)` — efficient and FK-friendly for
  join-heavy time-series, but no rename-safe identity and no global entity namespace.
- **`legacy_system_id`** is a permanent compatibility seam HA never carries (it mints opaque
  IDs freely; we preserved an integer space across the areas migration to avoid a UUID
  rewrite). See `areas-and-dashboards.md`.
- **`systems` fuses config-entry + device**, so an HA export must choose; it only cleanly
  models single-device sites.
- **Vendor coupling leaks upward** via `physical_path_tail`; HA hides vendor specifics behind
  the integration boundary so everything above the entity is vendor-agnostic. Our
  `logical_path_stem` abstraction exists to recover this, but the physical path remains a
  first-class addressed column.
- **Composite provenance collapses** at `flow_1d` (path-keyed `(area_id, day, source_path,
load_path)`, not point-keyed) so aggregated multi-point sources have a stable identity — at
  the cost of "which physical meter" no longer being recoverable from the flow row. But HA
  can't express "total solar across 3 inverters" as a first-class persisted entity without a
  Group helper that collapses provenance the same way — so this is a _fair trade_, not a pure
  deficiency.

## Where ours may be superior

Genuine wins — separating real architectural advantages from "different problem domain."

1. **Single-writer + transactional-outbox ingest durability — GENUINE WIN.**
   `observations_outbox` is committed _before_ the QStash enqueue; an idempotent
   single-writer receiver (`/api/observations/receive`) materializes it; the relay replays.
   At-least-once + rebuildable, across a network boundary, without a heavyweight log. **HA's
   pipeline is fire-and-forget in-process** — a `state_changed` the recorder misses (crash,
   DB stall) is simply _lost_. For a durable observability pipeline this is a real
   engineering advantage. (HA doesn't _need_ it — an in-memory control plane has different
   durability requirements.) See `engine-web-separation.md`.
2. **Typed aggregation with quality metadata + deterministic recompute — PARTLY a win.** Both
   downsample (us 5m+1d; HA 5m+hourly). Our agg rows uniquely carry `sample_count` /
   `error_count` / `data_quality`, and **recompute order-independently** from raw on every
   insert — so backfill / out-of-order data heals cleanly, whereas HA's statistics compute
   strictly forward in time and backfill is awkward. _Honest caveat:_ HA has **time-weighted
   mean** (our `avg` is a plain sample mean, biased under irregular sampling) and **counter
   reset detection** (~10% tolerance baked into `total_increasing`) that we lack. Roughly
   parity on the core idea, each with a refinement the other misses.
3. **Directional energy-flow matrix (`flow_1d`) — GENUINE WIN for the Sankey use case.**
   Materialized `(area_id, day, source_path, load_path) → energy_kwh`, direction encoded by
   slot (battery charge→`load.battery`, discharge→`source.battery`; grid import→`source.grid`,
   export→`load.grid`), built from 5m (not 1d, "whose daily averages cancel direction"), with
   an algorithm `version` for backfill dedup. HA computes the equivalent **at query time and
   persists nothing** — fine for one user, wrong for serving many tenants the same history.
   See `energy-flow-matrix.md`.
4. **Multi-tenant, capability-scoped sharing — outside HA's domain entirely.**
   `dashboard_grants` (owner/admin/viewer) + `dashboard_share_tokens` (one token → one
   dashboard, resolving Dashboard → its cards' bindings → exactly those points):
   least-privilege, FK-enforced, per-dashboard. HA is single-tenant and has no analog.
5. **FK-enforced typed bindings vs HA's JSON-in-`.storage`.** `area_bindings` and `roles` are
   SQL with real FKs (`area_bindings.(point_system_id, point_id) → point_info`, `.role →
roles.role`, composite-unique). Ours can't dangle past a cascade; HA's referential
   integrity is code-only and can drift. (Tradeoff: HA's looseness buys zero-migration schema
   evolution — a fair trade, not strictly inferior.)
6. **Engine/web separation + stable integer addressing — MIXED / domain-appropriate.** The
   cloud-scaling split (collection vs serving, single-writer contract, KV-as-engine-write /
   web-read) is something HA has no need for (one process, one box) — calling it "superior"
   is mostly a category error. Stable integer addressing is a modest, real ergonomic win for
   join-heavy time-series — but it's _also_ the constraint that forced `legacy_system_id` and
   lacks HA's rename-safe identity split.

**Honest deductions:** our command/control plane is aspirational where HA's service registry
is mature and uniform; our no-code composition is absent where HA's helper ecosystem is its
crown jewel; our plain-mean aggregation is arguably worse than HA's time-weighted mean.

## Verdict

**Home Assistant is the more general and elegant _object model + control runtime_; LiveOne is
the more rigorous _durable, multi-tenant, aggregation-first data pipeline_.** Where we
re-implement HA's semantic layer we're a reasonable (more rigid, integer-addressed) subset;
where we diverge we're not "behind" HA — we're solving a different problem, and the outbox /
aggregation / sharing investments are genuine wins _for that problem_.

Two low-domain-risk borrowings from HA are worth considering, written up separately in
[`../plans/identity-address-split-and-labels.md`](../plans/identity-address-split-and-labels.md):
splitting **identity from address** (a stable `point_uid` distinct from the renameable
`(system_id, point_id)` handle) and adding a **Label-style orthogonal tag dimension**.

## Related docs

- [`areas-and-dashboards.md`](areas-and-dashboards.md) — the System→Area→Dashboard split and
  the existing System→Device / Point→Entity / Area→Area HA bridge table.
- [`engine-web-separation.md`](engine-web-separation.md) — ingest durability (outbox),
  engine/web split, the (planned) FE→engine command pattern.
- [`points.md`](points.md) — the point model, paths, and identity.
- [`data-model.md`](data-model.md) — data semantics & invariants.
- [`energy-flow-matrix.md`](energy-flow-matrix.md) — the directional Sankey matrix.
