# Info Producers & Consumers — typed-shape info exchange (auto-connect + explicit wiring)

> **Status:** plan (proposed — not yet started). A design to hand off to an implementing workspace.
> Where it describes today's code, the source of truth is `lib/db/planetscale/schema.ts` +
> `lib/capabilities/*` + `lib/roles/registry.ts` + `lib/areas/*` + `lib/kv-cache-manager.ts`.
> HA references reflect Home-Assistant developer docs mid-2026 (indicative). Companion:
> [`../architecture/home-assistant-comparison.md`](../architecture/home-assistant-comparison.md).

## Why this exists

LiveOne repeatedly needs one part of the system to consume typed info another part produces:
a Sankey card consumes `grid/power`; the run-tracker produces a `.../running` point a card consumes;
the **battery-energy-provenance** fold consumes battery power/SoC/charge-energy/discharge-energy +
grid emissions/renewable/price, from **several different devices** (Kinkora already splits battery
_power_ [Mondo `6.9`] from _SoC_ [Fronius `5.7`]), across **three battery vendors** (Selectronic,
Sigenergy, Fronius[=`fusher`]), where the metrics are **separable** (emissions from OpenElectricity,
price from Amber). Today each consumer re-invents "find my inputs," and the fold in particular selects
sources **nondeterministically** (DB return order — first-wins or last-wins depending on the slot).

The goal is a single, HA-faithful model — **info producers and consumers that agree on the _shape_ of
the info exchanged** — that:

- lets producers **advertise** what info (status _and_ config) they can supply;
- lets consumers **seek** the best available producer per input, tolerant of absence;
- supports **auto-connect** when exactly one producer matches a consumer's required shape (HA discovery);
- supports **explicit user wiring** of Areas (the existing `area_bindings`), with priority;
- **signals availability** so a missing/stale input degrades to best-effort instead of silently wrong.

**Battery energy provenance is the first consumer** that proves the model; the same machinery then
generalizes to cards, derived points, and future consumers.

## The model

**Info** has two kinds — **status** (runtime time-series / latest values) and **config**
(declarative parameters) — and every piece of info has a **shape**: a typed contract

```
Shape = { kind: "status" | "config", role, metric, unit, stateClass, cadence }
```

This is HA's `device_class ⊥ state_class ⊥ unit ⊥ energy-role`, which LiveOne **already stores** as
`point_info.(logical_path_stem, metric_type, metric_unit)` (the addressing key —
`pi_system_stem_metric_unique`, `schema.ts:224-264`) plus the `roles` HA overlay
(`ha:{deviceClass,stateClass,unit}`, `lib/roles/registry.ts:24-63`; SQL projection `schema.ts:673-683`).

- **Producer** — advertises **output ports** of given shapes. A vendor point, a derived/helper point,
  or a **config-backed synthesized series** (e.g. `generatorSource` constants; the tariff provider).
- **Consumer** — declares **input slots** with required shapes (the fold's input list; a card's
  `grid/rate`; a derived-point computation's inputs).
- **Connection** — a producer→consumer edge in one of two modes; the consumer **seeks** per slot:

| Mode                               | Mechanism (existing seam)                                                                                     | HA analog                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Explicit wiring**                | `area_bindings` (role→point; `ordinal` = priority) + `refreshAreaServing`                                     | user assigning entities to Energy-dashboard slots |
| **Auto-connect (shape agreement)** | capability derivation — a device advertises `(role,metric)`; pick the single shape-matching producer in scope | HA discovery / suggested entities                 |

**Resolution order per slot (the "seek"):**
`explicit binding (highest-priority ordinal)` → `auto shape-match (exactly one candidate)` →
`config / synthesized producer` → `absent (best-effort + availability flag)`.

"Info is status _and_ config" falls out for free: a config value (`generatorSource`) is simply a
**config-kind producer** the same resolver consumes — no separate path.

## What LiveOne already has (build on these — do not reinvent)

1. **Typed shape + reverse-index fan-out.** `(stem, metric, unit)` is the addressing key
   (`schema.ts:224-264`). `lib/kv-cache-manager.ts` is a real producer→consumer router:
   `updateLatestPointValue` (`:67-127`) mirrors a producer's latest value into every subscriber Area's
   hash; `buildSubscriptionRegistry` (`:225-280`) builds the reverse map from `area_bindings` +
   binding-less members (`buildSubscriptionsFromBindings :197-223`). _(Note: CLAUDE.md's
   `/api/admin/kv/build-registry` is stale; the live entry is `buildSubscriptionRegistry()` via
   `refreshAreaServing` + `scripts/build-subscription-registry.ts`.)_
2. **Auto-connect by shape already exists** for cards: `capabilitiesFromPoints`/`collectAtomic` over
   `ATOMIC_CAPABILITY_RULES` (`lib/capabilities/derive.ts:42-68`, `registry.ts:159-164`) advertises a
   device's `(role,metric)` capabilities from its points; `unionCapabilities` (`derive.ts:91-97`) merges
   an Area over its members; `catalog.ts` + `strategy.ts` light up cards from advertised capabilities
   ("a never-seen vendor that advertises solar+load auto-gets tiles+chart with zero code").
3. **Explicit wiring** — `area_bindings` (`schema.ts:750-786`; unique on
   `(areaId, role, metricType, pointSystemId, pointId)`, so **multiple candidate points per
   `(role,metric)` are permitted**), `ordinal` (`:763`), `replaceBindings` (`create.ts:277-308`),
   `getAreaBindingRefs` ordered by ordinal (`bindings.ts:25-43`), `refreshAreaServing` (`create.ts:316-328`).
4. **Self-describing producers** — `/api/gush` (a push reading carries its own
   `physicalPathTail/metricType/metricUnit/logicalPathStem`, `app/api/gush/route.ts:166-187`, with a
   GET contract at `:283-303`); vendor `PointMetadata` + `VendorAdapter.dataSource: poll|push|combined`
   (`lib/vendors/types.ts:93-133`); the `helper` no-op adapter (`lib/vendors/helper/adapter.ts:11-16`).
5. **Derived points as producers**, all one pattern (point_info + agg_5m + KV, addressed by
   `stem/metric`): battery blend + η (`lib/battery-provenance/register.ts:24-52`,
   bound via `ensureHelperBindings :158-182`), run-tracking `runningPathForRole`
   (`lib/run-tracking/running-point.ts:17-24`), HWS. Consumers find them by `role+metric`, e.g. the
   fold's η read (`lib/battery-provenance/load.ts:394-409`).

## The three gaps to close

1. **No per-slot source _selection_.** The fold's binding reads **ignore `area_bindings.ordinal`**
   entirely — `boundPoints` has no `orderBy` (`lib/battery-provenance/load.ts:130-149`), so selection
   rides on DB return order. The per-slot mechanics differ (each wrong in its own way): battery
   power/SoC/charge/discharge/η are first-wins `Array.find` (`load.ts:195,220,362-367,399`); grid
   **price** is a filter + assignment loop, i.e. **last**-wins (`load.ts:~311-328`); grid
   **emissions/renewable are not selected from bindings at all** — an OE region lookup from
   `area.location` (`load.ts:267-307`), which the resolver must formalize as an auto/region _producer_
   rather than swap in place. No priority, no fallback chain, no determinism when two devices satisfy
   one `(role,metric)`. _(Power is a genuine sum-union, `flow-series.ts`; that stays.)_
2. **No shape _validation_ at bind time.** Binding a point to a role does **not** check the point's
   `metric_type`/stem is compatible with the role (`create.ts:277-290`). The only compatibility signal
   is a cosmetic UI dot (`BindingsTab.tsx:206-216`, `stemMatchesRole`); `roles.validatesCompositePath`
   is inert (its endpoint was deleted). Auto-connect needs this to be real.
3. **No _availability_ signal.** Presence is only _observed_ (a non-null KV latest, or forward-fill
   staleness → `estimated`), never _declared_. Nothing lets a consumer say "input X is unavailable, so
   this result is best-effort."

## The design (concrete changes)

Evolutionary — extend the existing capability/role/binding/fan-out seams; do **not** add a parallel
"port" abstraction (everything already routes through `(stem,metric)` + `area_bindings` + the KV
fan-out, and a parallel layer would duplicate addressing and collide with in-flight work).

1. **Advertise (extend capabilities).** Add the provenance-input `(role,metric)` capabilities so a
   device signals what it can supply: `battery/soc`, `battery/power` exist; add
   `battery/charge-energy`, `battery/discharge-energy`, `grid/emissions-intensity`,
   `grid/renewable-fraction` (price = existing `grid/rate`). Edit `lib/capabilities/registry.ts`
   (`ATOMIC_CAPABILITY_RULES` + `CapabilityId`) and get union-across-members for free via `derive.ts`.
2. **Seek (the resolver).** Introduce `resolveInfoSources(areaId, requiredSlots)` — per slot resolve
   `explicit(ordinal) → auto shape-match(single candidate) → config/synthesized → absent`. Replace the
   fold loader's first-wins finds with it; honor `area_bindings.ordinal` as explicit priority. Return,
   per slot, `{ producer, mode: "explicit"|"auto"|"config"|"absent", available: boolean }`.
3. **Agree (shape validation).** Enforce, at bind time (`create.ts` `replaceBindings`) **and** in the
   resolver's auto step, that a point's `(stem, metric)` matches the role's expected shape
   (`stemMatchesRole` + the role's metric set / HA `deviceClass`). Promote the cosmetic UI dot to a real
   validation. Retire or repurpose `validatesCompositePath`.
4. **Availability → confidence.** The resolver's `available:false`/stale outcome feeds the existing
   `estimatedKwh` confidence channel (the fold already surfaces "% estimated"), so a missing source
   degrades to best-effort and heals on recompute when it returns.
5. **Config as a producer.** Model `generatorSource` and `exportTariff` (both live on the
   battery-energy-provenance branch, see Coordination) as **config-kind producers** of the
   `grid/emissions-intensity` / `grid/price` / `grid/export-price` shapes, resolved by the same
   `resolveInfoSources` step. The `TariffProvider` seam is implemented
   (`lib/battery-provenance/tariff.ts` — `resolveExportPriceSeries :97` turns `{none|amber|schedule}`
   into the one per-interval series the fold consumes); it is exactly a narrow instance of this
   resolver, so generalize it rather than wrapping it.
6. **(Optional, later) shared helper.** Once proven on the fold, lift a generic
   `resolveInfoPort(area, shape)` that cards and derived points can also call, so "find my typed input"
   is one function repo-wide.

## Battery energy provenance as the first consumer

The fold's declared input slots and how the resolver fills them on the two live sites:

| Input slot (shape)          | Kinkora (area 8)                                               | Daylesford (area 1000002)                     | Multi-source?                             |
| --------------------------- | -------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `battery/power`             | Mondo `6.9`                                                    | Selectronic `1`                               | yes (Selectronic/Sigenergy/Fronius/Mondo) |
| `battery/soc`               | Fronius `5.7`                                                  | Selectronic `1`                               | yes (Selectronic/Sigenergy/Fronius)       |
| `battery/charge-energy`     | Fronius (`bidi.battery.charge`)                                | Selectronic                                   | per battery vendor                        |
| `battery/discharge-energy`  | Fronius (`bidi.battery.discharge`)                             | Selectronic                                   | per battery vendor                        |
| `grid/emissions-intensity`  | OE VIC1 (by `area.location`)                                   | **config** `generatorSource` (1000 g/kWh)     | single-sourced (OE) unless config         |
| `grid/renewable-fraction`   | OE VIC1                                                        | **config** `generatorSource` (0)              | OE today; Amber capable                   |
| `grid/price`                | Amber `9` (`bidi.grid.import`)                                 | **config** `generatorSource` (70 c/kWh)       | Amber today                               |
| `grid/export-price`         | Amber `9` (`bidi.grid.export`) via `exportTariff` mode `amber` | **config** `exportTariff` (`none`/`schedule`) | Amber / schedule config                   |
| `solar/power`, `load/power` | Mondo leaves                                                   | Selectronic leaves                            | yes (summed union — unchanged)            |

Vendor-agnostic: Selectronic/Sigenergy/Fronius all advertise `battery/soc`; the resolver picks by
explicit binding / priority / availability, **never by vendor name**. The generator case is exactly a
**config producer overriding an auto/region producer** — the same override #163 hard-codes in the
loader becomes a first-class resolution step.

## Auto vs. explicit — the UX

- **Explicit wiring** — the Area builder Bindings tab (`components/area-builder/BindingsTab.tsx` +
  `PUT /api/areas/[areaId]/bindings`) **already has** reorderable priority (Up/Down arrows persisted
  as `ordinal` = position, `BindingsTab.tsx:92-102` + `create.ts:296-302`); what it gains is a real
  **shape-match** validation (promote the dot), an **availability** indicator per bound source, and a
  **needs-attention** state for the ambiguous case (next bullet).
- **Auto-connect** — the common single-candidate case wires with zero config (capability derivation).
  When **≥2 candidates** match a slot and no explicit binding exists, do NOT silently fall through:
  surface "needs your choice" in the UI (HA's suggested-entities / repairs analog).
- **Resolution report** — per consumer, a read-only view of which producer filled each slot, by which
  mode (`explicit | auto | config | absent`), and its availability. This is the discoverability piece
  that makes complex multi-device areas feel effortless — users see what auto-connected without digging.
- **Config producers** — the device-config editor (`SystemSettingsDialog` → `DeviceConfigTab`, PATCH
  `/api/admin/systems/[id]/config` which **replaces** the whole `DeviceConfig`) holds `generatorSource`
  as **three raw number fields** (emissions g/kWh · price c/kWh · renewable %) — per the product
  decision, no fuel calculator — and `exportTariff` (mode `none | amber | schedule`; flat plans now,
  TOU schema-reserved; validated in the config route) — plus, later, η / reserve overrides. One
  scoping wrinkle to make explicit in the resolver: config producers live on a **device**
  (`systems.config.batteryProvenance`) while consumers are **area**-scoped; today the rule is "the
  Area's battery device's config wins".
- **Recompute action** — reuse the `lib/areas/recompute-flow.ts` client-loop + the
  `DashboardSettingsDialog` spinner + `sonner`-toast idiom, wired to the existing (currently un-called)
  `POST /api/areas/[areaId]/recompute-provenance`, so a config/binding change re-materialises provenance.

## Implementation phasing & coordination

**Coordination — critical.** The **battery-energy-provenance branch this doc ships on**
(`simonhac/battery-energy-provenance`, memphis-v3 — the successor to the merged san-diego-v4 PRs
#160–163) **has primacy** and owns `lib/battery-provenance/*` (incl. `load.ts`), `register.ts`,
`battery-provenance-pg.ts`, `lib/capabilities/config.ts`, the config route, and the FE cards. It
**already contains** `exportTariff` + the `TariffProvider` seam (`lib/battery-provenance/tariff.ts` —
a narrow instance of this resolver) plus the rollup day-boundary/gap fixes
([`battery-provenance-ops-hardening.md`](battery-provenance-ops-hardening.md)). The implementing
workspace must **branch from (or rebase onto) its merge** and generalize `TariffProvider` into the
resolver rather than racing it.

- **P1 — this doc** (done): the model + seam map + first-consumer application.
- **P2 — engine (after the battery-energy-provenance branch merges):** capability extensions
  (advertise) + `resolveInfoSources` replacing the nondeterministic reads (seek, honoring `ordinal`) +
  bind-time shape validation (agree — ship **warn-first behind an audit of existing prod bindings**,
  then enforce) + availability→estimated (define the staleness threshold that flips `available:false`
  — an explicit P2 decision). Tests: deterministic resolution; ordinal priority; single-candidate
  auto-connect; availability→estimated; **byte-identical** output on the single-source sites
  (Kinkora/Daylesford) so nothing regresses; a synthetic two-SoC-source fixture proving `ordinal`
  decides.
- **P3 — UX:** Bindings-tab shape-validation/availability/needs-attention (priority reorder already
  exists) + the resolution report + the `generatorSource`/`exportTariff` config forms + the
  "Recompute provenance" action.
- **P4 — generalize:** lift `resolveInfoPort(area, shape)` for cards/derived points repo-wide.

**No schema/migration** for P2/P3 (capabilities are code; the resolver reads existing
`area_bindings.ordinal`; validation is code). Any later `area_bindings`/`roles` change is a separate,
approval-gated migration.

## Invariants & non-goals

- **Determinism.** Resolution must be a pure function of `(bindings, advertised shapes, config)` —
  never DB-return order. This is what the current first-wins violates.
- **No feedback loops.** Derived/helper producers (blend, η, running) are inert to the consumers that
  compute them (the fold reads only power/soc/rate/energy), so advertising them creates no cycle.
- **Programmatic vs user bindings.** `replaceBindings` is delete-ALL-then-reinsert with `ordinal` =
  array index (`create.ts:271-308`), while the engine inserts the helper's blend/η bindings at
  `ordinal` 100+i (`register.ts` `ensureHelperBindings`). The Bindings-tab save path must preserve the
  helper rows (not wipe or renumber them ahead of user rows), and helpers-sort-last is the intended
  default once the resolver honors `ordinal` — state both explicitly in the implementation.
- **Best-effort, healing.** A missing/late producer degrades to `estimated`, never a wrong fact, and
  heals on the next idempotent recompute.
- **Not** a new addressing scheme, not a rename of the `battery-provenance` code paths, not an HA MQTT
  export (that remains the separate areas-P5 bridge), not a change to the power sum-union.

## Verification

- Unit/property: deterministic + ordinal-priority + single-candidate auto-connect + availability→
  estimated; bind-time shape validation rejects an incompatible `(stem,metric)`→role.
- Offline harness (`scripts/replay-battery-provenance.ts`) on the `liveone-dev` mirror reproduces
  Kinkora/Daylesford **byte-identically** to pre-refactor (single-source sites), conservation 0.00%.
- Live (dev): bind/re-prioritise a source in the editor → `refreshAreaServing` → card reflects it; set
  `generatorSource` → "Recompute provenance" → the `LoadProvenanceCard`/Sankey re-price.

## Key files / seams (read-grounded)

- **Shape/type contract:** `lib/roles/registry.ts:19-143`, `lib/db/planetscale/schema.ts:224-264`
  (`point_info`), `:673-683` (`roles`), `:750-786` (`area_bindings`, unique `:768-774`, `ordinal :763`).
- **Advertise (auto-connect):** `lib/capabilities/registry.ts:32-164`, `derive.ts:42-97`,
  `server.ts:50-100`, `catalog.ts`, `strategy.ts`, `config.ts:26-71`.
- **Explicit wiring + fan-out:** `lib/areas/bindings.ts:25-73`, `create.ts:277-328`
  (`replaceBindings`, `refreshAreaServing`), `lib/kv-cache-manager.ts:21-280`,
  `components/area-builder/BindingsTab.tsx`.
- **The "seek" gap (to replace):** `lib/battery-provenance/load.ts:192-400` (`boundPoints :130`,
  finds `:195,220,362-367,399`, price loop `:~311`, OE region lookup `:267`).
- **Config producer + tariff seam + reprice:** `lib/capabilities/config.ts:26-90`
  (`GeneratorSourceConfig`, `ExportTariffConfig`), `lib/battery-provenance/tariff.ts`
  (`TariffProvider :19`, `ScheduleTariffProvider :43`, `resolveExportPriceSeries :97`),
  `app/api/admin/systems/[systemId]/config/route.ts`,
  `app/api/areas/[areaId]/recompute-provenance/route.ts`, `lib/areas/recompute-flow.ts`.
- **Vendors (3 battery + sources):** `lib/vendors/{selectronic,sigenergy,fusher}/point-metadata.ts`,
  `lib/vendors/{openelectricity,amber}/point-metadata.ts`, `lib/vendors/mondo/adapter.ts`,
  `lib/vendors/{registry,types,base-adapter}.ts`, `app/api/gush/route.ts`.

## Related docs

- [`../architecture/home-assistant-comparison.md`](../architecture/home-assistant-comparison.md) — the HA object-model lineage (device_class ⊥ state_class ⊥ unit; Energy-dashboard slots; the helper ecosystem).
- [`../architecture/battery-provenance.md`](../architecture/battery-provenance.md) — the first consumer (metric-attributed flows through the battery). _(feature name: "battery energy provenance".)_
- [`../architecture/areas-and-dashboards.md`](../architecture/areas-and-dashboards.md) — Systems → Areas → Dashboards; `area_bindings` as the role→point wiring.
- [`../architecture/kv-store.md`](../architecture/kv-store.md) — KV keys + the subscription registry (the fan-out router).
