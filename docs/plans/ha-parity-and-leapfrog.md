# Twelve enhancements — parity with Home Assistant, and past it

> **Status: PROPOSAL, not approved.** Nothing here is scheduled and no schema change described below
> should be generated or applied without an explicit decision first. Written 2026-07-28 out of the
> second-pass findings in
> [`../architecture/home-assistant-comparison.md`](../architecture/home-assistant-comparison.md),
> which is the evidence base for every "HA does / doesn't" claim made here.
>
> Assumes config-v4 is complete (Phases 12–14 done): `devices`/`points` primary, the integer handle
> gone, one dashboard shape. Several of these are cheap _after_ that and expensive before it.

## How to read this

Each item is tagged:

- **Parity** — closes a gap where HA is genuinely ahead. Doing it makes us as good.
- **Leapfrog** — uses something we have and HA structurally cannot (retained raw data, deterministic
  recompute, per-edge attribution, multi-tenancy) to end up somewhere HA can't follow.

The ranking is impact-per-effort, not importance. Effort is T-shirt sized against a codebase where a
schema change plus a full-history recompute is a known, exercised operation.

| #   | Enhancement                               | Type            | Effort | Unlocks                                             |
| --- | ----------------------------------------- | --------------- | ------ | --------------------------------------------------- |
| 1   | Point category (primary/diagnostic)       | Parity          | S      | Usable pickers as point counts grow                 |
| 2   | Data quality & coverage as signals        | Leapfrog        | S–M    | Trust; "12% estimated" everywhere                   |
| 3   | Labels                                    | Parity          | S–M    | Cross-cutting selection; #7 and #10 lean on it      |
| 4   | Time-weighted means + reset detection     | Parity→Leapfrog | M      | Correctness, retroactively                          |
| 5   | Point topology (sub-metering containment) | Parity→Leapfrog | M      | Kills `rest-of-house` guessing; nested attribution  |
| 6   | Unit classes & display precision          | Parity          | M      | W↔kW without baking; fewer unit bugs               |
| 7   | Generated ("strategy") groups             | Parity          | M      | New devices appear without a document edit          |
| 8   | Reauth & credential-health onboarding     | Parity→Leapfrog | M      | Predicted token expiry instead of silent failure    |
| 9   | Attribution as a product surface          | Leapfrog        | M–L    | "What did the EV cost, and how green was it?"       |
| 10  | Portfolio tier (our answer to Floors)     | Leapfrog        | M–L    | Fleet rollups HA cannot express                     |
| 11  | Composable derivations                    | Parity→Leapfrog | L      | User-defined signals, backfilled across all history |
| 12  | Be HA's historian (export + stats push)   | Leapfrog        | L      | HA becomes a client, not a competitor               |

---

## 1. Point category — primary vs diagnostic — **Parity, S**

**Gap.** HA has `entity_category` (`config` / `diagnostic`) to demote secondary signals so pickers,
auto-generated dashboards and the device page show the interesting things first. Every LiveOne point
is equal; `points.active` is a single on/off. This is getting worse fast — the DeepSea genset capture
and the Sigenergy register work mean devices now expose dozens of points where they used to expose a
handful, and every one of them lands in the card picker.

**Sketch.** `points.category text NOT NULL DEFAULT 'primary'` with a CHECK over
`primary | diagnostic | config`. Adapters set it at mint time (register dumps, RSSI, firmware
versions, internal temperatures → `diagnostic`). Pickers, `/areas/{id}/eligibility` and the
default-group seeder filter to `primary` unless asked. No recompute, no data migration — a backfill
that classifies existing points by physical-path pattern gets most of it.

**Why first.** Smallest change on the list with a visible daily payoff, and it makes #7 and #3 much
more useful. Nothing depends on it, so it can land any time.

---

## 2. Data quality and coverage as first-class signals — **Leapfrog, S–M**

**What we have that HA doesn't.** `point_readings.data_quality`, `agg_*.sample_count` /
`error_count`, `flow_attr_1d.estimated_kwh` and `finalized_at`, the `sessions` table (a durable
record of every vendor poll and its response) and `device_state`. HA has none of this: a gap in HA
statistics is simply invisible — the graph draws a line across it and the energy dashboard quietly
under-reports.

**The gap is that we barely surface it.** The confidence machinery exists and is largely invisible in
the UI. That is a wasted structural advantage.

**Sketch.** Three layers, cheapest first:

1. **Surface what exists.** Every aggregate number that is partly estimated says so ("12% estimated"
   from `estimated_kwh / energy_kwh`); every chart shades gaps rather than interpolating them; the
   Sankey marks a day that hasn't crossed `finalized_at`.
2. **A coverage view per area** — a per-day, per-point coverage heatmap from `sample_count` against
   the expected sample rate. This is the single best "is my monitoring healthy" screen and nothing in
   HA can produce it.
3. **Repair triggers.** [`../architecture/coverage-repair.md`](../architecture/coverage-repair.md)
   already describes the repair path; drive it from measured coverage instead of by hand.

**Why high.** Mostly presentation over data we already store, and it converts an invisible engineering
investment into visible product trust.

---

## 3. Labels — **Parity, S–M**

**Gap.** HA labels are an orthogonal many-to-many tag applicable to areas, devices, entities,
automations, scenes, scripts and helpers, usable as a table filter _and_ as an automation target. We
have one Area tier. Config-v4 §12.7 parked labels deliberately as "a clean future add".

**Sketch.** `labels (id uuid pk, owner_user_id, name, slug, color)` with TypeID `lb_`, plus
`label_assignments (label_id, target_type, target_id)` where `target_type ∈ device|point|area|dashboard`.
Polymorphic ids are safe here because every target is a uuid in one namespace. Then: label filters in
every picker, and `?label=lb_…` on the list APIs.

**Leapfrog extension, cheap once the base exists.** Two things HA can't do because it's
single-tenant: **label-scoped share tokens** (share "everything labelled `farm`" rather than one
dashboard) and label-driven generated groups (#7) — "a card for every point labelled `hot-water`,
across all my sites".

**What it's actually for.** The shape only earns its keep against concrete uses, so name them:
`region:nsw`, `hardware-gen:selectronic-v2`, `support-tier:vip`, `beta-cohort`, `share-public`,
`needs-review`, `migrated-2026`. None of those is a _site_ (Area) or a _signal kind_ (role) — that
mismatch is the whole argument. Three payoffs stand out:

- **Rollout cohorts as data, not code.** Roll a feature out to labelled devices; the cohort lives in
  the DB, not a hard-coded list or an env flag.
- **Bulk ops as queries.** "Re-aggregate everything tagged `migrated-2026`", "list every dashboard
  tagged `share-public`" — an indexed many-to-many instead of a jsonb scan.
- **It stops grouping drift.** Config-v4 cleaned up the specific leaks (`systems.alias` → a
  first-class `devices.slug`, `systems.metadata` → the honestly-named `adapter_state`, `areas.metadata`
  gone entirely in favour of typed `config`/`location`). But it did not create a _home_ for
  cross-cutting grouping, so the pressure that produced those leaks is still there and will re-accrete
  as jsonb keys. That, not parity with HA, is the strongest reason to do this.

**Honest scope, and the brake.** ROI scales with object count: with a handful of devices the payoff
is low, and it grows with the multi-tenant footprint. So **tie the first cut to a concrete use case**
— ops tagging for a multi-tenant rollout, or share-cohorts pairing with label-scoped tokens — rather
than building it speculatively. Cost is genuinely small (one registry table + one assignment table,
both additive, no data migration since labels start empty), which is exactly what makes it tempting
to build with no user. **Minimal first cut:** `labels` + assignments for `device` only, plus an admin
UI to tag devices; add `area` / `dashboard` / `point` targets as use cases appear.

> Note on the polymorphic choice: an earlier plan left "polymorphic (HA-like, no FK) vs typed
> junctions (FK integrity)" open and leaned typed, on this project's house preference for FK-enforced
> bindings. Config-v4 settled it the other way by making it true that every target is a uuid in one
> namespace — so the single polymorphic `label_assignments` table above is the right call now, and
> that older lean is stale.

---

## 4. Time-weighted means and counter-reset detection — **Parity → Leapfrog, M**

**Gap.** HA's statistics mean is **time-weighted**; ours is a plain sample mean, biased whenever
sampling is irregular — which is exactly what push vendors, retries and gaps produce. HA also detects
counter resets on `total_increasing` (>10% drop ⇒ new meter cycle) and honours `last_reset` on
`total`; we infer reset behaviour from `metric_type` and `transform`. Since 2025.10 HA additionally
carries `mean_type` (`arithmetic` / `circular`) for angle-like quantities.

**Sketch.** In the 5-minute reducer: weight each sample by the interval it represents rather than
counting it once, and add explicit reset detection for counter-shaped points. Bump the aggregate
algorithm version and recompute.

**Why this is the leapfrog, not just parity.** HA can change its estimator only going forward — by
the time you'd want to recompute, the underlying states have been purged. **We can recompute the
entire history under the corrected estimator**, because raw is retained at every tier and
recomputation is order-independent and idempotent. Same formula as HA; applied to years of data
instead of tomorrow onward. The Sigenergy sign-convention repair already proved the machinery.

**Risk.** Every historical average changes. Needs the algorithm version, a before/after diff report on
a sample of areas, and a decision about whether daily bars visibly shift.

---

## 5. Point topology — sub-metering containment — **Parity → Leapfrog, M**

**Gap, and the biggest one on the list.** HA has two hierarchies we lack entirely: `via_device` (a
device tree) and, since **2025.4**, an explicit **upstream device** relation in the energy dashboard —
mark a breaker as upstream of the devices on its circuit and HA stops double-counting them. Our load
side is roles plus a synthetic `load.rest-of-house`: we do by subtraction what HA does structurally,
and we can only do it at one level.

**Sketch, and it's neater than it sounds.** Our `source_path` / `load_path` are already dotted logical
paths, so containment can be expressed in the grammar that exists: `load.house.ev` is contained by
`load.house`. Make it explicit rather than implied:

- `point_containment (parent_point_id uuid, child_point_id uuid, PK(parent, child))`, validated
  acyclic, or a nullable `points.contained_by` if a strict forest is enough.
- `computeFlowAccounting` walks the tree: a parent's contribution is its measured energy _minus_ its
  known children, at every level. `load.rest-of-house` stops being a special case and becomes "the
  unattributed remainder of whatever node you're looking at".
- `flow_attr_1d` keys on the hierarchical path it already stores, so the table shape doesn't change —
  only the set of paths written. Bump the algorithm version and backfill.

**Leapfrog.** HA's hierarchy only avoids double-counting. Ours would carry the **attributed** legs
down the tree: "the EV charger drew 42 kWh, of which 31 kWh was solar, costing $2.10 and 4.1 kg CO₂" —
for a sub-circuit, not just the whole home. Nothing in HA can answer that at any level.

**Dependency.** Best done after #4, so the recompute happens once.

---

## 6. Unit classes and display precision — **Parity, M**

**Gap.** HA has a real unit model: `native_unit_of_measurement` vs `suggested_unit_of_measurement`,
automatic device-class-driven conversion, per-user overrides held in the entity registry,
`unit_class` naming the converter, and `suggested_display_precision`. We have one fixed string per
point and no conversion anywhere in the model — so W vs kW is decided at write time and at render
time independently, by convention.

**This has already cost us.** The generator run-period columns were named `*_power_w` and rendered as
`kW` by dividing by 1000, which silently displayed engine **rpm** as ~1.5 kW when the detector was
re-pointed at a speed signal. That's a units-are-just-strings bug.

**Sketch.** `points.unit` becomes the native unit; add `unit_class` (the converter family: power,
energy, temperature, angle, dimensionless…) and `display_precision`. Conversion happens in one place
at the serving edge; a per-dashboard or per-user display preference selects the unit. Because raw is
retained and conversion is display-only, this is lossless and retroactive.

---

## 7. Generated ("strategy") groups — **Parity, M**

**Gap.** HA _strategies_ build a whole dashboard or a single view at render time by querying the
registries — the default Home dashboard in 2026.2 is one, and a newly-onboarded device appears in it
without anyone editing a document. Our `/areas/{id}/default-group` seeds a stored document once at
creation; from then on the document is authoritative and drifts from reality.

**Sketch.** A third node kind in the v4 document: `{kind:'query', select:{…}, render:{…}}`, resolved
at read time against the registry — "every point in this area with role `solar`", "every device
labelled `farm`" (#3), "every `primary` point on this device" (#1). It composes with the existing tree
because it returns nodes.

**Keep the good half of what we have.** HA's generated dashboards aren't directly editable — you
"take control", which snapshots them into a static document and stops the updates. We should offer
exactly that as an explicit operation: **materialize** a query node into its expanded static subtree.
Generated by default, static when you want control, and the difference visible in the editor. That is
strictly better than either HA's model or ours today.

---

## 8. Reauth and credential health — **Parity → Leapfrog, M**

**Gap.** HA's config flow has a standard taxonomy — `user` / `discovery` / `zeroconf` / `reauth` /
`reconfigure`, plus subentry reconfiguration — with `async_set_unique_id` dedup. Our onboarding is
`credentialFields` + `credentials`/`oauth-redirect` with no reauth step at all, which matters because
Tesla and Enphase tokens expire and the current failure mode is a device that quietly stops polling.

**Sketch.** Add `reauth` as a first-class device state and flow: `device_state` gains a credential
status, the adapter distinguishes "auth failed" from "vendor down", and the UI surfaces a re-connect
action on the device rather than an error count.

**Leapfrog.** We have `sessions` — a durable per-poll record with the vendor response — and
`device_state` counters. HA has neither. So we can do what HA can't: **predict** expiry from observed
token lifetimes and error onset, and prompt _before_ collection breaks rather than after. For a
monitoring product whose whole value is an unbroken series, that's the difference between a gap and
no gap.

---

## 9. Attribution as a product surface — **Leapfrog, M–L**

**What we have.** Per-edge `emissions_g` / `renewable_kwh` / `cost_c` on `flow_attr_1d`, the learned
battery-provenance blend behind it, per-run attribution on `derived_intervals`, and
`estimated_kwh`/`finalized_at` as an honest confidence channel. HA has per-source **cost**
(`stat_cost` / `entity_energy_price` / `number_energy_price`) and a whole-home grid fossil-fuel
percentage from Electricity Maps — but nothing per-edge, and no battery provenance at all (its
battery model is round-trip efficiency from in/out sensors).

**The gap is that this is an implementation detail, not a product.** It powers tooltips.

**Sketch.**

1. **A query surface** — `GET /api/v4/attribution?area=&from=&to=&group_by=load|source|day` answering
   "what did each load cost, how green was it, over any window", with the estimated fraction attached
   to every figure.
2. **Cards for the obvious questions** — cost and emissions by load over a month; the EV/hot-water
   breakdown; year-on-year.
3. **Counterfactuals (the ambitious half).** Because we retain 5-minute raw and the provenance model
   is a deterministic fold, we can replay history under altered parameters: a bigger battery, a
   different tariff, a shifted charging window. "A 20 kWh battery would have saved $340 last year" is
   computed, not estimated — and it is unreachable for HA, which no longer has the data.

**Dependency.** #5 makes this dramatically better (attribution per sub-circuit rather than per role).

---

## 10. Portfolio tier — our answer to Floors — **Leapfrog, M–L**

**Gap, reframed.** HA has Floor → Area → device. Copying that literally is low value for us: our
users don't have floors, they have _sites_. The right analog for a multi-tenant energy platform is
**Portfolio → Area**: "all my farms", "the fleet", "everything in NSW".

**Why it's a leapfrog rather than parity.** HA is single-home by construction and can never express
this. We already store every area's history in one uuid-keyed table.

**Sketch.** Either `areas.parent_area_id` (area nesting) or a distinct `portfolios` table with
membership. Nesting is more flexible; a separate table makes the rollup semantics explicit, which
matters here because **there is a live trap**: `flow_attr_1d` warns that a multi-device area and its
members' areas-of-one each get their own rows, so a rollup must never sum an area _and_ its members.
Today that rule lives in a comment. A portfolio tier should encode it — the rollup query is defined
once, at the tier that owns it, rather than being re-derived correctly by each caller.

**Also unlocks** cross-site comparison ("which site has the worst self-consumption") and portfolio-level
sharing, which is the natural next sharing unit after the dashboard.

---

## 11. Composable derivations — **Parity → Leapfrog, L**

**Gap.** HA's helper ecosystem is its crown jewel: _Integration_ (Riemann sum, W→kWh), _Derivative_,
_Utility Meter_ (cycle/tariff), _Template_ (arbitrary typed expression), _Group(sum)_. A user composes
new typed entities purely through config. Config-v4's `derivations` unified our two derive mechanisms
and made the wiring data (`params`, `source_points` are jsonb) — but the **kinds** are code
(`run-detector`, `hws-model`). An engineer ships a kind; an HA user configures one.

**Sketch.** New derivation kinds that need no new code per use:

- `expression` — a typed formula over bound points, evaluated in a sandbox with no I/O and a step
  budget. The typing is the interesting part: inputs carry `metric_type` and unit (#6), so
  `W × hours → kWh` is checked, not hoped.
- `integrate` / `derivative` — the Riemann and rate helpers, which we already do ad hoc.
- `meter` — cycle/tariff accumulation with configurable reset.
- `group-sum` — N points → 1, which today is code (`load.rest-of-house`, synthetic totals).

**Leapfrog.** HA helpers only produce data from the moment you create them — there's nothing to
backfill from. Ours would run over retained raw, so **a newly-defined derived series is instantly
populated across its entire history**, and a corrected formula re-derives cleanly with an algorithm
version. Creating a helper in HA means waiting a year for a year of data; here it means having it.

**Risk.** Sandboxed evaluation is the real work — it must be non-Turing-complete, deterministic and
bounded, because it runs in the ingest path and in bulk recompute.

---

## 12. Be Home Assistant's historian — **Leapfrog, L**

**The strategic one.** Phase 3 of the areas roadmap has always been "HA export": describe our
semantic layer as HA config. That's the small version. The large version uses the finding from the
comparison's second pass — **HA has a first-class API for writing statistics at arbitrary past
timestamps** (`async_import_statistics` / `async_add_external_statistics`, and re-importing the same
timestamps replaces the existing rows).

That means we can do something HA cannot do for itself.

**Sketch — two directions:**

1. **Config out.** MQTT Discovery (or a custom integration) publishes each LiveOne point as an HA
   entity with the right `device_class` / `state_class` / unit, grouped into HA Areas that mirror
   ours. The role registry already carries this metadata for exactly this purpose; a
   `GET /api/v4/export` (**to be built** — no such route exists today) would be most of the payload.
2. **History in — the differentiator.** A small HA integration pulls our long-term aggregates and
   imports them as HA long-term statistics. An HA user who installs it gets: history from before they
   ran HA; history recomputed under corrected models rather than frozen at whatever was computed at
   the time; gaps repaired from vendor backfill; and attributed cost/emissions HA has no way to
   derive. HA's own recorder purges the raw states these would have been computed from — so this is
   not a convenience, it's data they cannot otherwise have.

**Why it matters beyond features.** It reframes the relationship. Today HA is the thing we're
measured against; this makes HA a distribution channel, with LiveOne as the durable, recomputable,
attributed store behind it — which is precisely the axis where the comparison says we're strongest
and HA is structurally weakest.

**Effort and shape.** The integration is Python and lives outside this repo, which is a real cost. But
the server side is mostly `/api/v4/export` plus a statistics endpoint over aggregates we already
serve, and a read-only share token is already the right auth primitive.

---

## Suggested sequencing

Not a plan — a dependency-respecting order if these were picked up.

**First, independently:** #1 (point category), #2 (data quality surfacing), #3 (labels). All small,
none blocked, and #1/#3 make later items better.

**Then the one recompute:** #4 (time-weighted means) and #5 (point topology) together, so history is
recomputed once rather than twice. #6 (units) fits naturally alongside, since #5's tree and #11's
type-checking both want a real unit model.

**Then the surfaces:** #7 (generated groups, wants #1 and #3), #9 (attribution, much better after #5),
#8 (reauth, independent).

**Then the large bets:** #11 (composable derivations, wants #6) and #12 (HA historian, wants nothing
but is the most work). #10 (portfolio) whenever a second site makes it real.

## Deliberately not here

- **HA's config-entry/device split** and config subentries. Config-v4 §4.1 declined it with a stated
  rationale; the 2026-06 areas refactor had already deferred the same thing ("the clean HA end-state,
  but orthogonal and XL"). Credentials still live on `devices` (`adapter_state`). The trigger is the
  first vendor connection that yields several independently-addressable devices, and that hasn't
  happened. Revisit then, not now.
- **A command/service registry.** Real gap, but it belongs to `engine-web-separation.md`'s Control API
  rather than to HA parity — and with one shipped command (Tesla charge control) the demand isn't
  there yet.
- **HA's Category registry.** It looks like a missing dimension but isn't — categories group the
  automation/script/helper lists and have no effect elsewhere. We have no automation lists.

## Related docs

- [`../architecture/home-assistant-comparison.md`](../architecture/home-assistant-comparison.md) — the
  scorecard, and the evidence base for every HA claim above.
- [`../architecture/areas-and-dashboards.md`](../architecture/areas-and-dashboards.md) — the
  three-layer model these build on.
- [`completed/config-v4-clean-sheet.md`](completed/config-v4-clean-sheet.md) — the model as designed,
  including the deliberate deviations several of these would revisit.
- [`../architecture/coverage-repair.md`](../architecture/coverage-repair.md) — the repair path #2
  would drive automatically.
- [`../architecture/battery-provenance.md`](../architecture/battery-provenance.md) — the model #9
  would expose as a product.
