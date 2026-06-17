# Design: Nested Dashboard-Construction Model + grid-signals Retirement

**Status:** Read-path **IMPLEMENTED** + verified on dev (2026-06-17). **Goal:** One clean nested model —
`Dashboard → AreaSection → Card → Tile` — that reproduces `/dashboard/8` and generalizes to N areas;
retire the bespoke grid-signals card as a device-bound tile.

> §§1–8 below are the **original design** (three merged perspectives). The build **deliberately diverged**
> from it once the constraint relaxed to "it's only us and the current thing is broken — go hard, no
> migration." **§0 is authoritative**; where §§2.1 / 6 / 7 conflict with §0, §0 wins (they're kept for
> rationale: the problem statement §1, the grid-signals retirement §4, and the parity proof §4.3 still hold).

---

## 0. Realized implementation (what actually shipped — authoritative)

The cautious machinery (lazy `migrateToV3`, `legacyViewOf`, the `UNIFIED_RENDERER` flag, the 6-phase
parity-gated rollout) was **dropped**: there is exactly **one** dashboard and the old composition renderer
was broken, so we built the clean model directly, replaced the broken renderer, and **re-seeded the one
descriptor** rather than migrating.

**Model — leaner than §2.1.** Types live in **`lib/dashboard/v3.ts`** (not `descriptor.ts`). Store only
choices + structure; **derive everything that comes from the Area**:

```ts
export type TileView = TileId | "oe-grid"; // TileId = solar|load|hotWater|battery|house-to-grid|amber|ev
export interface TileV3 {
  view: TileView;
  deviceSystemId?: number;
  id?: string;
  hidden?: boolean;
  features?: TileFeature[];
}
export interface CardV3 {
  type: DashboardCardType;
  id?: string;
  hidden?: boolean;
  tiles?: TileV3[];
  chart?: ChartCardConfig;
}
export interface AreaSectionV3 {
  areaId: string;
  layout?: DashboardLayout;
  hidden?: boolean;
  cards: CardV3[];
}
export interface DashboardV3 {
  version: 3;
  sections: AreaSectionV3[];
}
```

vs the original §2.1, an `AreaSection` **dropped** `handleSystemId` (= `area.legacy_system_id`, derived
from `areaId`), made `layout` an **optional override** (else `getLayout(area.vendorType)`), and dropped
`title` (the header shows the Area name only when there are 2+ sections). So a section is just
`{ areaId, cards }` in the common case.

**Two renames (vocabulary):**

- the household import/export TileId **`grid` → `house-to-grid`** (distinct from the point role `grid`,
  the point key `bidi.grid/power`, and the `grid` subsystem — all unchanged).
- the NEM grid tile-**view** **`grid-signals` → `oe-grid`** (OpenElectricity). The legacy **card type**
  `"grid-signals"` is untouched — it's the retiring card, a different namespace, deleted at cutover.

**Renderer.** `components/CompositionDashboard.tsx` was **rewritten in place** to consume `DashboardV3`
(no separate `DashboardRenderer`/`AreaSection`/`TilesGrid` files). Single section ⇒ frameless stack
(`/dashboard/8` look); the stacked-areas charts + sankey of a section **collapse into one `SiteChartsCard`**
via `cardVisible` (shared period header — the simple resolution of §5.4, no `AreaSiteChartsProvider`); the
`oe-grid` tile self-fetches its member device and reads the region label from that device's `vendorSiteId`.

**Read-path wiring.** `app/dashboard/[...slug]/page.tsx` gates the composition branch on `isDashboardV3`
and passes the descriptor straight through (the server-side `gridContextByArea` resolution is gone).
`CompositionDashboardClient` retypes the descriptor to `DashboardV3` and **drops the v2 customize editor**
(switcher/rename/new kept).

**Data.** VIC1 (system 12) added to the Kinkora area's `area_devices` (dev); **parity held** —
`getActivePointsForSystem(8)` byte-identical across all 15 handles (the §4.3 proof). The one Kinkora
dashboard (id 38 on dev) re-seeded to v3 by `scripts/temp/seed-kinkora-v3-dashboard.ts` (hand-authored).

**The dashboard definition (the lean Kinkora descriptor):**

```jsonc
{
  "version": 3,
  "sections": [
    {
      "areaId": "<kinkora-area-uuid>", // layout + header DERIVED from the Area
      "cards": [
        {
          "type": "tiles",
          "tiles": [
            { "view": "solar" },
            { "view": "load" },
            { "view": "hotWater" },
            { "view": "battery" },
            { "view": "house-to-grid" },
            { "view": "amber" },
            { "view": "ev" },
            { "view": "oe-grid", "deviceSystemId": 12 }, // the VIC grid: a tile bound to the OE region member
          ],
        },
        {
          "type": "chart",
          "id": "chart:load",
          "chart": { "variant": "stacked-areas", "split": "load" },
        },
        {
          "type": "chart",
          "id": "chart:generation",
          "chart": { "variant": "stacked-areas", "split": "generation" },
        },
        { "type": "sankey" },
      ],
    },
  ],
}
```

**Deferred (follow-ups):** a **v3-native configurator** (the v2 one was removed); the **legacy
`DashboardClient` cutover** (it still reads v2; `lib/grid/context.ts` + the `grid-signals` card type live
on until then); a v3-aware path for **shared `?access=` composition views** and any server descriptor
consumer that still assumes top-level `cards`.

---

## 1. Problem and goals

### 1.1 What's wrong today

The descriptor (`lib/dashboard/descriptor.ts`) is **flat** — `{ version: 2, layout, cards[] }` — and is rendered by **two divergent renderers** that disagree about the same descriptor:

|               | `DashboardClient.tsx` (`/dashboard/8`)                                                  | `CompositionDashboard.tsx` (`/dashboard/id/{id}`)                                                      |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Structure     | one **implicit** area (the page system), flat                                           | N **explicit** areas, each a full-width `<section>`                                                    |
| Tiles         | 7 `useTileNodes` tiles **+ GridSignalsCard as an 8th cell in the same grid** (L461-469) | 7 tiles only; **no VIC-grid tile** (`AreaTilesCard`, L183-213)                                         |
| Grid signals  | a cell **inside** the tile grid, conditional on `gridContext`                           | a **separate full-width** `AreaGridSignalsCard`, conditional on `gridContext`                          |
| Charts/Sankey | **one** `SiteChartsCard` (shared period header + synced hover)                          | **three** `AreaSiteChartCard` wrappers, each its own `SiteChartsCard` with `cardVisible={k===cardKey}` |

Three concrete defects fall out of this:

1. **grid-signals is special-cased on three axes.** Its NEM region is **location-derived** (`resolveGridContextForSystem`: `area.location → region → public OE system`), it is **conditionally rendered** (`if (gridContext && cardVisible('grid-signals'))`), and it is a **bespoke `DashboardCardType`**. None of this generalizes; every consumer threads a `gridContext`/`gridContextByArea` prop.
2. **Flat cards can't express the multi-area reality.** A single descriptor-level `layout` can't describe a composition that mixes a `site` area and a `sidebar` area. The per-card `areaId` (descriptor.ts L50-58) is a forward seam bolted onto a flat list — area binding is _customization_, not _structure_.
3. **Legacy-vs-composition divergence.** The same descriptor renders an 8-box grid on one route and 7-tile + separate-card sections on the other. `/dashboard/8` is the look the user wants; the renderer they're on diverges from it.

### 1.2 Goals

- **G1** Reproduce `/dashboard/8` pixel-faithfully (8-box tile grid + 2 stacked charts + sankey).
- **G2** One nested model: `Dashboard → AreaSection → Card → device-bound Tile`. Legacy unified view = **one** AreaSection; composition = **N** AreaSections. One renderer.
- **G3** A **tile = (device, view)**, mix-and-match. The view is chosen by the member device's points.
- **G4** Retire grid-signals: VIC1 (system 12) becomes a **member device** (`area_devices` row); grid-signals becomes a **tile view** rendered **unconditionally** because the device is a member — no location derivation, no conditional cell.
- **G5** Prefer **ZERO schema**. Keep `DashboardClient` working throughout; every resolver-touching change is parity-gated.

---

## 2. The nested model

```
Dashboard                                  (the page; HA analogue: View)
 └─ AreaSection[]        — an Area + its presentation   (HA: Section)
     └─ Card[]           — tiles | chart | sankey | amber-* | generator-runs  (HA: card)
         └─ Tile[]       — (only for a tiles card) device-bound: (deviceSystemId, view, features?)  (HA: Tile Card)
```

**HA analogues, adapted (not copied):** Our composition dashboard shows all areas **on one page, stacked** (no tabs) — that is precisely HA's **Sections-view**: one View containing N titled Sections. So **Dashboard ≅ HA View; AreaSection ≅ HA Section; Card ≅ HA card; Tile ≅ HA Tile Card** (entity/device → state, with an optional "features" row). We deliberately **do not** introduce a View tier (we have no tabs); if multi-page dashboards are ever wanted, a `views: { sections: AreaSection[] }[]` wrapper is the additive next step.

### Why this shape (the one-sentence resolutions to the design conflicts)

- **`layout` moves from the descriptor onto each AreaSection** — because a composition mixes a `site` area and a `sidebar` area, which a single descriptor-level `layout` cannot express.
- **Area binding is a structural level (`AreaSection.areaId`), not a per-card option (`card.areaId`)** — because grouping cards under their Area is exactly what un-flattens v2-composition's "N independent area-bound cards" into the model it always implied.
- **A tile carries an explicit `deviceSystemId`** — because that is the _only_ thing that made grid-signals bespoke (deriving its device from location); making device-binding first-class subsumes the special case.

### 2.1 Full TypeScript types (v3)

These live in `lib/dashboard/descriptor.ts` (v3). `DashboardCardType`, `DashboardLayout`, `TileId`, `ChartCardConfig` stay in `cards.ts`, reused below.

```ts
// lib/dashboard/descriptor.ts  (version: 3 — nested)

import type { DashboardCardType, DashboardLayout, TileId } from "./cards";

/** A device-bound tile — the unit the user mixes-and-matches. device → data, view → rendering.
 *  This is HA's Tile Card adapted to our (integer-handle device, view) world. */
export interface Tile {
  /**
   * The MEMBER DEVICE this tile reads — a systemId that is a member (area_devices row) of the
   * enclosing AreaSection's Area. OMITTED ⇒ "the AreaSection's own handle" (area.legacySystemId),
   * i.e. the area's resolved `latest` — the legacy whole-area tile (see §2.3 default-device rule).
   * PRESENT ⇒ that specific member device (e.g. the OE region system 12 for the grid-signals tile).
   */
  deviceSystemId?: number;
  /** Which renderer to use for that device. Superset of TileId + the retired card folded in as a view. */
  view: TileView;
  /** Stable per-instance id (so one view can appear twice for two devices). Reconcile/visibility key: id ?? view. */
  id?: string;
  hidden?: boolean;
  /** HA-style optional "features" — tile detail/affordances. Forward seam; inert-with-defaults today (§3.3). */
  features?: TileFeature[];
}

/** solar/load/.../ev are today's TileId; "grid-signals" is the retired card type, now a view. */
export type TileView = TileId | "grid-signals";

export type TileFeature =
  | { kind: "sparkline"; series: string } // e.g. HWS temp 24h (already built as `extra`)
  | { kind: "breakdown" } // solar local/remote, load top-2
  | { kind: "flow-direction" } // battery/grid chevrons (already built)
  | { kind: "toggle"; command: string }; // future: charge toggle

/** A card. `tiles` now holds device-bound Tile[]; other card types unchanged. NO areaId here — the
 *  AreaSection owns the binding (was the inert per-card areaId). */
export interface Card {
  type: DashboardCardType; // tiles | chart | sankey | amber-now | amber-timeline | generator-runs
  id?: string; // instance identity; id ?? type
  hidden?: boolean;
  tiles?: Tile[]; // type === "tiles": ordered device-bound tiles (replaces TilesConfig)
  chart?: ChartCardConfig; // type === "chart": unchanged
}

/** An AreaSection: one Area + the cards rendered against it. This is the level that carries the Area
 *  binding and the per-section layout. A composition dashboard is N of these; the legacy unified view
 *  is exactly ONE. HA analogue: a Section. */
export interface AreaSection {
  areaId: string; // the Area this section reads (uuid)
  handleSystemId: number; // areas.legacy_system_id — the section's "own" device (integer handle)
  layout: DashboardLayout; // amber | site | sidebar — was the descriptor-level layout
  title?: string; // null/absent ⇒ header suppressed (the single-area page); else Area.displayName
  hidden?: boolean;
  cards: Card[];
}

export interface DashboardDescriptor {
  version: 3;
  sections: AreaSection[];
}
```

### 2.2 v2 → v3 mapping at a glance

| Flat (v2)                                           | Nested (v3)                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `descriptor.layout` (one)                           | `section.layout` (per AreaSection)                                        |
| `descriptor.cards[]`                                | `section.cards[]`, grouped under their Area                               |
| `card.areaId?` (per-card override, inert)           | `section.areaId` (structural binding level)                               |
| `card.tiles: {order:TileId[], hidden:TileId[]}`     | `card.tiles: Tile[]` (`{deviceSystemId?, view, hidden?}`)                 |
| `grid-signals` card + `resolveGridContextForSystem` | a `Tile{ view:"grid-signals", deviceSystemId: 12 }` inside the tiles card |
| home-system implicit binding (legacy)               | the single AreaSection's `areaId` / `handleSystemId`                      |

### 2.3 The default-device rule (back-compat with the whole-area tile)

The legacy unified view renders its 7 tiles from the **area's resolved `latest`** (system 8's bindings union), not from any single member. We preserve this as the **omitted-`deviceSystemId`** case, which is the cleanest possible retirement:

- `deviceSystemId` **absent** ⇒ tile reads the AreaSection's own handle (`area.legacySystemId`) — byte-identical to today's `DashboardClient` tile rendering.
- `deviceSystemId` **present** ⇒ tile reads that specific member device.

So a default Kinkora AreaSection emits **7 tiles with no `deviceSystemId`** (whole-area, unchanged) **plus one `grid-signals` tile with `deviceSystemId: 12`**. The grid tile is the _only_ one that needs an explicit device, because grid signals are a distinct device's points the area-resolution union does not (and must not) fold into system 8.

---

## 3. Device-bound tiles + the tile-view catalog

### 3.1 The catalog of views

`TileView = TileId | "grid-signals"` = `solar | load | hotWater | battery | grid | amber | ev | grid-signals`. `grid-signals` stays in `DashboardCardType` **only** for v2 read-migration; new descriptors never emit it as a card.

### 3.2 How a device exposes views (point-driven, not vendor-driven)

The set of views a device _offers_ is computed from its resolved `latest` (its points), generalizing today's `availableTiles()` and adding the grid-signals view:

```ts
// lib/dashboard/tiles.ts (new)
export function availableViewsForDevice(latest: LatestPointValues): TileView[] {
  const v: TileView[] = [...availableTiles(latest)]; // solar/load/hotWater/battery/grid/amber/ev
  if (
    hasVal(latest, GRID_LATEST_PATHS.price) || // grid.price/rate
    hasVal(latest, GRID_LATEST_PATHS.emissionsIntensity) || // grid.emissionsIntensity/intensity
    hasVal(latest, GRID_LATEST_PATHS.renewables) // grid.renewables/proportion
  )
    v.push("grid-signals");
  return v;
}
```

- **Inverter/meter device** (Fronius, Mondo, Selectronic) → `solar`, `battery`, `grid`, `load`.
- **Amber device** → `amber`. **OE region device** (VIC1=12) → **`grid-signals` only**.

Points are the authority (consistent with the codebase's drift off vendor-type ladders); `vendorType` may stay a tiebreaker for icon/label defaults but never for eligibility.

### 3.3 Data path + features

`useTileNodes` already builds all view nodes from one `latest` map. We refactor so a **single** view is callable per instance: `renderTileView(view, latest, ctx)`, keeping the synthesis helpers (master-load, rest-of-house, solar breakdown) verbatim.

- A tile with `deviceSystemId = D` fetches `dashboardDataQuery(D)` (the generic `/api/data?systemId=D` path — exactly how `gridRegionData` and `AreaTilesCard` already work). **No new endpoint, no per-device-type API** (honors the dashboard-live-values convention).
- **Batching:** React Query dedupes identical keys, so N tiles on handle 8 = **one** `/api/data?systemId=8` request; the grid tile on 12 adds one more.

**Features** (HA's feature row) map to today's per-tile `extra`/`extraInfo` slots (HWS sparkline, battery/grid chevrons, solar breakdown). **Recommendation: ship `features` typed but inert-with-defaults now** (each view declares its default feature, so behavior is unchanged); wire the per-tile "show sparkline / hide detail" UI later — no second migration.

---

## 4. grid-signals retirement (in full)

This is the load-bearing model change. grid-signals is bespoke on three axes; all three die:

| Bespoke axis (today)                                        | After                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Location-derived region** (`resolveGridContextForSystem`) | VIC1 (system 12) is an `area_devices` row of the area. Membership IS the binding.  |
| **Conditional render** (`if (gridContext && …)`)            | Rendered unconditionally: a member device offers the view, the tile loop emits it. |
| **Separate `card.type: "grid-signals"`**                    | Retired as a card type → it's a `TileView`.                                        |

### 4.1 The region label without location

Today the "VIC Grid" label comes from `nemRegionShortLabel(gridContext.region)`. After retirement, derive it from the **member device itself**: the OE system's `vendorSiteId` IS the region (`VIC1`), and arrives in the same `dashboardDataQuery(12)` payload — `nemRegionShortLabel(device.vendorSiteId)`. No separate lookup.

### 4.2 Off-grid behaviour

An off-grid area simply has **no OE region member** in `area_devices`. The area strategy emits no grid-signals tile (no member offers the view). **Absence of the member IS the off-grid rule** — strictly simpler than today's three-way null in `resolveGridContextForSystem`.

### 4.3 The crux: who creates the VIC1 membership, and the parity proof

We need one `area_devices` row: `(area_id = Kinkora area, system_id = 12, ordinal = after the inverter/meter members)`.

**Parity proof (verified in `point-manager.ts` `_resolvePointsForViewable`, L254-290):** Kinkora is a **binding area** (it has `area_bindings`). The bindings branch wins — `validPointRefs.length > 0` ⇒ the bound child refs ARE the resolved set, and the function **returns at L278, before ever reading `area_devices`** (L282-289 is reached only when there are zero bindings). Therefore:

> **Adding `(Kinkora, 12)` to `area_devices` does NOT change `getActivePointsForSystem(8)`.** VIC1's price/emissions/renewables points are **not** folded into system 8's `latest`. Grid signals reach the dashboard **only** through the explicit `grid-signals` tile that fetches `dashboardDataQuery(12)`. Parity holds. ✓

Corollary invariants (confirmed): `point_readings_flow_1d` is untouched (it's keyed on the binding flows); binding-less KV fan-out (`getBindinglessAreaMemberPoints`) excludes areas that have bindings, so Kinkora is unaffected; the admin Areas member list now honestly shows VIC1 as a member.

**Seeding — recommend (A) then (B):**

- **(A) One-time area-strategy seeder** (`scripts/temp/seed-grid-member.ts`): run `resolveGridContextForSystem`-equivalent logic **once** per existing binding-area — derive region from `location`, find the public OE system, INSERT the `area_devices` row. The location logic survives **just long enough to seed membership**, then the runtime derivation is deleted. Zero-touch parity at cutover.
- **(B) Steady state:** add the region device as a member via the admin member-add UI when an area's location is set (or directly). (A) and (B) converge on the same `area_devices` row.

> ⚠️ **The seeder writes data, not schema** (`area_devices` already exists, migration 0018). Inserting the row is a data change — flag for **explicit approval** before running against prod, and run the `getActivePointsForSystem(8)` before/after equality assertion as the gate.

### 4.4 What's deleted vs kept

- **Deleted:** `lib/grid/context.ts` (`resolveGridContextForSystem`, `systemPlaysGridRole`), `lib/grid/types.ts` (`GridContext`); the `grid-signals` `CardDef` + `DashboardCardType` membership (after v2 migration is in place); `buildDefaultDescriptor`'s `gridSignalsAvailable` branch; the `gridContext`/`gridContextByArea` prop plumbing through `page.tsx`, `DashboardClient`, `CompositionDashboard`, `SharedDashboardView`; the conditional cell push at `DashboardClient` L461-469.
- **Kept verbatim (now the view's internals):** `GridSignalsCard` (presentational), `gridLatestFromData` + `GRID_LATEST_PATHS` (`lib/grid/latest.ts`, pure selector), `nemRegionShortLabel`.

---

## 5. The single renderer — reproducing `/dashboard/8` exactly + generalizing

### 5.1 Component tree

```
DashboardRenderer                         (NEW — the single renderer; replaces both client bodies' card region)
└── AreaSection[]                          (NEW — one per area-bound group)
    ├── AreaSectionHeader                  (NEW — "Kinkora Unified" label; hidden when title == null, i.e. the single-area page)
    ├── AreaSiteChartsProvider             (NEW — ONE SiteChartsCard state context per section: period header + hoveredIndex + siteDataQuery)
    └── Card[]  (dispatch on card.type — the consolidated switch)
        ├── TilesGrid                      (NEW — the responsive grid + the device-bound tile loop, incl. grid-signals)
        │   └── Tile[]   →  renderTileView(view, dashboardDataQuery(deviceSystemId ?? handleSystemId).latest)
        ├── EnergyChartCard (stacked-areas, split=load)        → SiteChartsCard sub-view chart:load   (consumes provider)
        ├── EnergyChartCard (stacked-areas, split=generation)  → SiteChartsCard sub-view chart:generation
        ├── EnergyFlowCard  (sankey)                           → SiteChartsCard sub-view sankey
        ├── LinesChartCard  (lines)                            (UNCHANGED)
        ├── AmberNow / AmberCard / AmberSmallCard              (UNCHANGED)
        └── GeneratorRunsCard                                   (UNCHANGED)
```

Two structural rules carried from existing code: **dispatch on `card.type`, identity (`id ?? type`/`id ?? view`) flows on the instance**; **each leaf self-fetches via `dashboardDataQuery(systemId)`** — the renderer threads **systemIds, never data**.

### 5.2 Reproducing `/dashboard/8` exactly

`/dashboard/8` = **one AreaSection** (Kinkora, handle 8, `site` layout, `title: null` ⇒ header suppressed). The descriptor (assume area uuid `kinkora-area-uuid`):

```jsonc
{
  "version": 3,
  "sections": [
    {
      "areaId": "kinkora-area-uuid",
      "handleSystemId": 8,
      "layout": "site",
      "cards": [
        {
          "type": "tiles",
          "tiles": [
            { "view": "solar" },
            { "view": "load" },
            { "view": "hotWater" },
            { "view": "battery" },
            { "view": "grid" },
            { "view": "amber" },
            { "view": "ev" },
            // The retired grid-signals card, now a device-bound tile on the OE region MEMBER (VIC1=12).
            // Unconditional because 12 is a member of the Kinkora area — no location derivation.
            { "view": "grid-signals", "deviceSystemId": 12 },
          ],
        },
        {
          "type": "chart",
          "id": "chart:load",
          "chart": { "variant": "stacked-areas", "split": "load" },
        },
        {
          "type": "chart",
          "id": "chart:generation",
          "chart": { "variant": "stacked-areas", "split": "generation" },
        },
        { "type": "sankey" },
        { "type": "generator-runs" },
      ],
    },
  ],
}
```

The renderer produces the identical DOM:

1. **The 8-box tile grid.** `TilesGrid` emits the exact wrapper `DashboardClient` uses (L447):
   `grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1`,
   rendering the 7 whole-area tiles **+ the grid-signals tile as the 8th cell in the same grid** — but now via the **generic tile loop** (VIC1 is a member) instead of the special-case `if (gridContext …)` push.
2. **Two stacked charts + sankey.** Three `EnergyChartCard`/`EnergyFlowCard` instances, each a thin consumer of the **section's single `AreaSiteChartsProvider`** selecting its sub-view (`chart:load`/`chart:generation`/`sankey`). See §5.4 — this preserves the legacy single-page shared period header + synced hover.
3. **Header suppressed** (`title == null`). `<main className="max-w-7xl mx-auto px-1 py-4">` page chrome unchanged.

### 5.3 Generalizing to N area-sections

The renderer consumes `AreaSection[]` derived (pure) from the descriptor by `buildAreaSections(descriptor, areaById)` in `lib/dashboard/section-spec.ts`:

- **Legacy `/dashboard/8`** → one section, `title: null`, header off. Identical DOM to today.
- **Composition `/dashboard/id/{id}`** → N sections, `title = area.displayName`, header on, stacked (`space-y-4`). This replaces `CompositionDashboard`'s flat per-card `<section>` loop with **per-area grouping** — strictly closer to HA Sections (a titled section holds _many_ cards, not one). The VIC-grid tile appears in whichever section's area has the OE member, automatically.

### 5.4 The one real divergence to resolve: 1 vs 3 `SiteChartsCard`

Legacy `/dashboard/8` draws load+gen+sankey in **one** `SiteChartsCard` with **one** shared period header and **synced cross-chart hover** (`hoveredIndex`/`activeChart` state, `SiteChartsCard.tsx` ~L373, L633-694). The composition path uses **three** independent `SiteChartsCard` instances (`cardVisible={k===cardKey}`) — which loses the shared header + synced hover and triple-fetches `siteDataQuery`.

**Resolution (the clean version of the `cardVisible` trick):** `AreaSection` owns **one** `AreaSiteChartsProvider` per section — lift `SiteChartsCard`'s period/history/hover/`siteData` state into it once. The three chart/sankey cards become thin consumers selecting their sub-view. This (a) restores single-page parity for `/dashboard/8`, (b) avoids triple-fetch, and (c) keeps the composition path's visual "three cards" — building directly on the two session fixes already made (pass `system`; open the chart container for the sankey-only case).

### 5.5 Files

**New:**
| File | Responsibility |
|---|---|
| `components/dashboard/DashboardRenderer.tsx` | `AreaSection[]` → `<AreaSection/>` list. The single renderer. |
| `components/dashboard/AreaSection.tsx` | Optional header + `AreaSiteChartsProvider` + the consolidated card-dispatch switch. |
| `components/dashboard/TilesGrid.tsx` | The responsive grid + device-bound tile loop (incl. grid-signals). |
| `lib/dashboard/section-spec.ts` | `buildAreaSections(descriptor, areaById)` — pure; one-area and N-area both go through it. |
| `lib/dashboard/tiles.ts` | `Tile`/`TileView`/`TileFeature` types? (or keep in descriptor.ts), `availableViewsForDevice`. |
| `lib/dashboard/area-strategy.ts` | `defaultTilesForArea(area, memberLatestById)` — emits the default `Tile[]` (the HA "area strategy"). |

**Changed:**

- `lib/dashboard/descriptor.ts` — v3 types; `migrateToV3`; rescope `normalizeDescriptor` per-section; v3 `buildDefaultDescriptor`; drop `gridSignalsAvailable`.
- `lib/dashboard/cards.ts` — add `"grid-signals"` to `TileView`; keep `grid-signals` `DashboardCardType` only for v2 migration; add `deriveTileView`/`availableViewsForDevice` glue.
- `app/components/cards/useTileNodes.tsx` — refactor to `renderTileView(view, latest, ctx)`; add the `grid-signals` node (`GridSignalsCard` fed by `gridLatestFromData`); accept the member device's `latest`.
- `components/CompositionDashboard.tsx` — **gutted to a thin adapter** → `buildAreaSections` → `DashboardRenderer`; `AreaCard*` helpers move into the shared renderer.
- `components/MultiAreaCards.tsx` — folded into the grouping (off-area cards = additional `AreaSection`s); ultimately deletable.
- `app/dashboard/[...slug]/page.tsx`, `components/DashboardClient.tsx`, `components/SharedDashboardView.tsx` — drop `gridContext`/`gridContextByArea`.

**Deleted:** `lib/grid/context.ts`, `lib/grid/types.ts`.

---

## 6. Descriptor schema + migration (ZERO schema; legacy kept working)

**Storage:** stays 100% in the `dashboards.descriptor` JSONB; `version` 2→3. **Zero DB schema.** (`area_devices`, `areas.legacy_system_id`, `areas.location` already exist; the OE-system-as-member is one `area_devices` INSERT per grid area — **data**, gated on approval per §4.3.)

**Lazy, on-read migration.** Add `migrateToV3(saved, ctx)` in front of the existing `normalizeDescriptor` seam (runs on every read at `DashboardClient.tsx:296-302` and the share route). Nothing is rewritten in the DB until the user next saves.

```ts
export function migrateToV3(
  saved: unknown,
  ctx: {
    area: { id: string; legacySystemId: number };
    members: { systemId: number; views: TileView[] }[]; // area_devices members + each one's offered views (the OE member supplies grid-signals)
    vendorType: string;
  },
): DashboardDescriptor;
```

Three input shapes:

- **(a) No saved row / legacy auto-generated** → build the v3 default directly (the area strategy): one AreaSection bound to `ctx.area`, `layout = getLayout(vendorType)`, a tiles card whose `Tile[]` = the whole-area views (no `deviceSystemId`) **plus** a `grid-signals` tile _iff a member device offers that view_ — i.e. **exactly when `resolveGridContextForSystem` would have resolved, now expressed as membership presence**. This is where the bespoke card retires.
- **(b) Saved v2** → lift structurally, **byte-parity for what the user customized**:
  - one AreaSection: `areaId = ctx.area.id`, `handleSystemId = ctx.area.legacySystemId`, `layout = saved.layout`; each v2 card → v3 `Card` preserving `id`/`hidden`/`chart` verbatim.
  - v2 `tiles` card: `tiles.order` → `Tile[]` in order, `view = id`, `hidden = id ∈ saved.hidden`, **no `deviceSystemId`** (whole-area). Saved reorder/hide survives byte-for-byte.
  - v2 `grid-signals` card → **drop the card**, append `Tile{ view:"grid-signals", deviceSystemId: <OE member from ctx.members> }` (with `hidden:true` if the user had hidden it). If no OE member exists yet, append nothing — idempotent; it appears once the membership row lands.
  - v2 **composition** descriptors (cards with `areaId`) → **group by `areaId` into AreaSections** (handle/layout from each Area). This un-flattens v2-composition into the model it always implied.
- **(c) Already v3** → pass through to `normalizeDescriptor`.

`normalizeDescriptor` is **rescoped per-section** (the existing reconcile logic, run inside each section): catalog cards reconciled against the section's default, user reorder kept, new cards appended; the `id ?? type` rule extends to tiles as `id ?? view`.

**Legacy coexistence during transition.** `DashboardClient` keeps reading through the same seam via a thin adapter `legacyViewOf(descriptor): { layout, tileOrder, gridTile? }` that reads **section[0]** of a v3 descriptor and reproduces today's `tilesCfg` + the `gridContext`-gated extra cell — so `DashboardClient` renders v3 with no structural change while the new renderer is built behind a flag. Additive; the legacy path keeps working.

---

## 7. Phased implementation plan (incremental, parity-gated, legacy untouched until cutover)

Each phase is shippable; the legacy `DashboardClient` renders identically until Phase 5.

- **Phase 0 — types + migration, no render change.** Add v3 types, `migrateToV3`, `legacyViewOf`, per-section `normalizeDescriptor`. `DashboardClient` reads v3 via `legacyViewOf` and renders byte-identically. **Parity gate:** snapshot of `effectiveDescriptor`-equivalent + DOM of `/dashboard/8` unchanged. **No schema, no data.**
- **Phase 1 — device-bound tiles internally.** Refactor `useTileNodes` → `renderTileView`; add `availableViewsForDevice` + the `grid-signals` view (fed by `gridLatestFromData`). Still rendered by the legacy path; grid tile still sourced via the old `gridContext` for now. **Parity gate:** tile DOM unchanged.
- **Phase 2 — `DashboardRenderer` behind `UNIFIED_RENDERER` flag.** Build `DashboardRenderer`/`AreaSection`/`TilesGrid`/`AreaSiteChartsProvider`. Mount it for `/dashboard/8` only when the flag is on, with a one-element section. **Parity gate:** diff `/dashboard/8` old-vs-new (DOM + screenshots) until byte-equivalent — including the 1-vs-3 `SiteChartsCard` shared-hover/header behaviour (§5.4).
- **Phase 3 — seed VIC1 membership.** 🛑 **Requires explicit approval** (data write). Run the one-time seeder (§4.3 (A)) per binding-area; **gate: `getActivePointsForSystem(8)` byte-identical before/after**. The default v3 strategy now emits the grid-signals tile from membership; flip the `/dashboard/8` grid tile from `gridContext` to the member device under the flag.
- **Phase 4 — point composition renderer at `DashboardRenderer`.** Repoint `CompositionDashboardClient` (multi-section) at `DashboardRenderer`; retire `CompositionDashboard` + `MultiAreaCards`. **Parity gate:** composition routes visually unchanged (now with shared per-section chart state).
- **Phase 5 — cutover + delete.** Collapse `DashboardClient`'s body to "build a one-element section → `DashboardRenderer`," leaving only page chrome (access guard, dialogs, removed-system banner, header wiring). Delete `lib/grid/context.ts`, `lib/grid/types.ts`, the `gridContext` plumbing, the `grid-signals` card type. Remove the flag. The grid-signals retirement lands **with** the unified renderer, not before.

**Approval flags:** only Phase 3 touches data (the `area_devices` INSERT) — explicit approval + the parity assertion. **No schema migration anywhere.**

---

## 8. Risks, edge cases, and adversarial check

### 8.1 Does this reproduce `/dashboard/8` pixel-faithfully?

**Yes, by construction, with one watch-point.** The tile grid uses the identical wrapper classes (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 … auto-rows-fr px-1`) and the identical tile nodes (`renderTileView` keeps the synthesis helpers); the grid-signals tile flows as the 8th cell exactly as the current `tileItems.push(...)`. **The watch-point is §5.4:** the legacy page's shared period header + synced hover live _inside one_ `SiteChartsCard` — naively rendering three instances breaks single-page parity. The `AreaSiteChartsProvider` resolves it. Phase 2's screenshot diff is the gate.

### 8.2 Concrete risks

| Risk                                               | How the design handles it                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Off-grid areas**                                 | No OE member ⇒ strategy emits no grid-signals tile. Absence is the rule; no conditional, no null-three-way.                                                                                                                                                                                                                    |
| **Multi-area**                                     | `buildAreaSections` groups by area; N=1 (legacy) and N>1 (composition) are the same code. VIC-grid appears only in the section whose area has the OE member.                                                                                                                                                                   |
| **Existing saved (v2) descriptors**                | `migrateToV3` lifts byte-parity: reorder/hide preserved; v2 `grid-signals` card → tile (preserving its hidden state); v2 composition → grouped sections. Lazy on-read; DB unchanged until next save. **Risk: a saved descriptor whose area has no OE member yet** → grid tile not appended; idempotent, appears after seeding. |
| **VIC1 membership leaking into system 8's points** | **Proven false** (§4.3): Kinkora resolves via bindings (`point-manager.ts` L268-278 returns before reading `area_devices`). Phase-3 gate asserts `getActivePointsForSystem(8)` byte-identical.                                                                                                                                 |
| **amber/ev/hotWater tiles**                        | Unchanged data path (whole-area, no `deviceSystemId`); `renderTileView` reuses the exact existing nodes incl. `hasVal(latest, "ev.battery/soc")`, `load.hws/temperature`, `bidi.grid.import/rate`. Features (sparkline etc.) ship inert-with-defaults — no behavior change.                                                    |
| **Region label without `gridContext`**             | Derived from the OE device's `vendorSiteId` (== `VIC1`), carried in `dashboardDataQuery(12)`. No location lookup.                                                                                                                                                                                                              |
| **Legacy/composition coexistence**                 | `DashboardClient` reads v3 via `legacyViewOf` (section[0]) and renders unchanged behind the flag; only the final cutover (Phase 5) removes the legacy path. Each phase is independently shippable + parity-gated.                                                                                                              |
| **Triple `siteDataQuery` fetch in composition**    | One `AreaSiteChartsProvider` per section dedupes to one fetch (also fixes legacy parity).                                                                                                                                                                                                                                      |
| **`isSiteVendor` gate on charts**                  | `EnergyChartCard`/`EnergyFlowCard` pass the area's `system` (vendorType ∈ {mondo, composite}) from `dashboardDataQuery` — the existing session fix; without it `SiteChartsCard` renders "No data".                                                                                                                             |
| **Share/read-only view**                           | The descriptor arrives via `sharedDescriptor`; per-area/per-device fetches carry the share token via the existing fetcher; `migrateToV3` runs on the share route too. No new auth surface.                                                                                                                                     |
| **Phase-3 data write fails / partial**             | Idempotent INSERT (`ON CONFLICT DO NOTHING` on `(area_id, system_id)`); seeder is re-runnable; explicit approval + before/after parity assertion is the gate; rollback = delete the row (no point/flow impact, proven).                                                                                                        |

### 8.3 Residual unknowns to confirm during implementation

- The exact Kinkora area uuid and the live `area_devices.ordinal` for VIC1 (placed after the inverter/meter members so the tile renders last, matching today's 8th-cell position).
- Whether any _other_ located grid-connected binding-area exists (the seeder loops all of them; each gets the same before/after parity assertion).
- That `useTileNodes`'s per-tile `available` flags, once driven by a member device's `latest`, still grey-out correctly in the Customize dialog's new two-step (device → view) picker.
