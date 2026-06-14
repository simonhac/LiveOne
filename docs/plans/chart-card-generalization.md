# Plan: generalize the two charts into one instance-id'd `chart` card

> **Status:** proposed — not started (drafted 2026-06-14). Handover for the next phase of the
> dashboard-card overhaul. The card-uniformity + tile-rename work (P1–P7) has shipped on
> `simonhac/grid-card-layout-fixes` — the dashboard is now one uniform descriptor-driven card grid.
> This plan is the agreed next substantive piece. **No code for this has been written yet.**

## Why

The dashboard has two time-series chart components that grew up separately:

- **`components/EnergyChart.tsx`** — card type `energy-chart` (sidebar vendors: Selectronic/Enphase).
  Overlaid **lines** on one y-axis (no fill), SOC on a right axis; 30D switches to grouped bars.
  **Self-fetching** (`useQuery(historyQuery)`), owns its period + URL state, transforms the raw
  OpenNEM payload in-component (`buildChartData`). **Hardcoded** series
  `{solar, load, batteryW, batterySOC, grid}`.
- **`components/SitePowerChart.tsx`** — card type `site-charts` (site vendors: mondo/composite),
  rendered **twice** (load + generation). **Stacked areas** (`fill:"stack"`, `y.stacked:true`),
  SOC overlay. **Presentational** — `DashboardClient` owns `siteDataQuery` and
  `lib/site-data-processor.ts` does the transform; the component receives `data`. **Dynamic**
  `series: SeriesData[]` discovered from points (load auto-discovery, battery charge/discharge split,
  rest-of-house). Hover index is lifted to the parent so the two charts stay in sync.

Two problems this creates:

1. **They are mutually exclusive by vendor.** `cards.ts` gates `site-charts` to `isSiteVendor` and
   `energy-chart` to `!amber && !site` (`canRender`). A dashboard can show one _or_ the other, never
   both. The user wants charts to be **first-class, vendor-independent cards** so a dashboard can
   show **either or both** line and stacked-area charts, picked in Customize like any other card.
2. **~70% is duplicated scaffolding** — Chart.js registration, the entire x-axis `time` scale +
   1D/7D/30D tick callbacks (~100 lines), the weekday/daytime shading annotations, the SOC min/max
   range band, the `Line`/`Bar` switch. The genuine differences are only (a) two **dataset builders**
   (overlaid-lines vs stacked-areas) and (b) two **data-ownership models**.

This phase also **clears a known caveat from P5**: chart-card reorder already _persists_ in the
descriptor, but the render still draws charts in a fixed order — because charts aren't yet
descriptor instances. Making `chart` a real instance fixes that.

## What this builds on (current state, post P1–P7)

- The dashboard is **one uniform card grid** with no per-vendor layout forks; every card (tile, grid,
  chart) is a reorderable/hideable descriptor citizen. `DashboardClient` renders each card inline,
  gated by `cardVisible(type)` (`components/DashboardClient.tsx:843`).
- Cards are keyed by **`type`** in the descriptor — `ModuleCardInstance` has **no `id`**
  (`lib/dashboard/descriptor.ts:25`). `normalizeDescriptor` reconciles via
  `new Map(cards.map(c => [c.type, c]))` (`descriptor.ts:145`); `isCardVisible` does
  `find(c => c.type === type)` (`descriptor.ts:185`). **This one-card-per-type assumption is the
  thing this plan must change** (see step 4).
- The charts still render inline in `DashboardClient` (`site-charts` ~`:1031–1357`, the two
  `SitePowerChart` at `:1232`/`:1287`; `energy-chart` ~`:1376`). `siteDataQuery` + the
  `processedHistoryData` memo + the ~600-line site-charts state/handlers/effects cluster (period,
  history window, hover-sync, series toggles, prev/next nav, Sankey fallback) live at the top of
  `DashboardClient`. **P5 deliberately left this cluster in place** to be extracted here.
- The two generic data producers are healthy: `/api/data` (live `latest` map) and `/api/history`
  (all series). The legacy descriptor read-shims (`amber`→split, `power-cards`→`tiles`) live in
  `migrateLegacyDescriptor` (`descriptor.ts:100`) and are test-locked.

## Target design

One data contract, one shared scaffold, two pluggable dataset builders, descriptor-driven placement
by **instance id**.

### 1. One `ChartData` contract (`lib/charts/types.ts`)

Adopt SitePowerChart's generic `{ timestamps, series: SeriesData[], mode }` as the single shape;
EnergyChart's fixed `{solar, load, batteryW, …}` becomes a series list — a special case. Delete the
two component-local `ChartData` types.

### 2. One presentational `<DashboardChart>` component (two dataset builders)

A single component takes `variant: "lines" | "stacked-areas"` and `split?: "load" | "generation"`
(for the stacked case), composes the shared scaffold, and dispatches to `buildLineDatasets` vs
`buildStackedAreaDatasets`. `EnergyChart` + `SitePowerChart` collapse into it (or become thin
wrappers, then are deleted). Both are **presentational** — data supplied by the parent.

### 3. Shared scaffold (`lib/charts/`)

Extract the duplicated pieces into tested modules:
`useTimeAxis(timeRange, now, windowStart, mode)` (x-scale + tick callbacks),
`buildShadingAnnotations(...)` (weekday/daytime boxes), `buildSocRangeDatasets(...)` (the band + line),
`useChartWindow(timeRange, chartData)`. Colours already centralised in `lib/chart-colors.ts`.

### 4. Descriptor: instance-id keys + a vendor-independent `chart` card (the structural change)

This is the crux and it touches **persisted data** — do it carefully, expand→migrate→contract, same
pattern as the amber/tiles renames.

- **Add `id: string` to `ModuleCardInstance`** (`descriptor.ts:25`). `id` is the stable identity;
  `type` selects the renderer. Rule: **dispatch keys on `type`; identity flows on the instance.**
- **Re-key the reconcile** in `normalizeDescriptor` from `type` → `id` (`descriptor.ts:145`), and
  generalise `isCardVisible` (`descriptor.ts:185`) + the Customize dialog's per-row key/toggle
  (`components/DashboardCustomizeDialog.tsx`) to instance id. Today's singletons get a deterministic
  `id` (e.g. equal to their `type`) so nothing else changes.
- **Introduce a single `chart` card type** carrying config on the instance:
  `{ variant: "lines" | "stacked-areas", split?: "load"|"generation", series?: string[] }`
  (mirrors how the `tiles` module carries `TilesConfig`). Relax `canRender` so any system with the
  requisite points can show **either** variant — drop the `isSiteVendor` gate.
- **`buildDefaultDescriptor`** seeds the historical per-vendor default for backward-compat: site
  vendors → two `chart` instances (`stacked-areas` load + generation) + the Sankey; sidebar vendors
  → one `chart` instance (`lines`).
- **`migrateLegacyDescriptor` read-shim** (`descriptor.ts:100`): old `site-charts` → two
  `stacked-areas` `chart` instances; old `energy-chart` → one `lines` `chart` instance. KEEP until
  the data migration ships.
- **Deferred data migration** (after deploy to preview+prod, like the tiles/amber one): rewrite
  stored `dashboards` rows to the instance-id'd `chart` shape; then a contract step retires the
  read-shim.

### 5. Data flow — no extra requests

Both charts presentational; **`DashboardClient` (or a small hook) owns the fetch** and feeds each
`chart` card its slice. Walk the visible `chart` instances, take the **union of their `series[]`
specs**, issue **one** `historyQuery({interval, window, series: union})` per active window; the
processor (`lib/site-data-processor.ts`, extended to cover the fixed-series "lines" case) runs once;
each card selects its series client-side. React Query **dedupes by query key**, so N chart cards =
one network request. Fold `EnergyChart`'s `buildChartData`/`buildSeriesParam` into the same processor
path (it's the simpler, fixed-series case). This is already how the two site charts share one
`siteDataQuery` — just generalised.

### 6. Fold in the deferred `SiteChartsCard` extraction

P5 left the ~600-line site-charts cluster inline precisely so it's rewritten **once, here** — where
the `SitePowerChart`-parent-fed vs `EnergyChart`-self-fetching asymmetry is being resolved anyway.
Extract the cluster's state/handlers/effects (period, history window, hover-sync, series toggles,
prev/next nav, keyboard/touch/URL effects, the 3-way Sankey fallback) into the chart card(s) /
a small owning component. Move JSX + state **wholesale, don't rewrite** the interaction logic.

## Suggested sequencing

1. Extract the shared scaffold into `lib/charts/` behind the _existing_ two components (pure
   refactor, no behaviour change) — get it green + tested first.
2. Build `<DashboardChart variant=…>` and reduce `EnergyChart`/`SitePowerChart` to it.
3. Descriptor instance-id migration + the `chart` card type + read-shim + `buildDefaultDescriptor`
   defaults + Customize dialog generalisation.
4. Switch `DashboardClient` to render `chart` instances from the descriptor; extract the site-charts
   cluster; delete the old `site-charts`/`energy-chart` inline branches and the old card types
   (kept readable via the shim).
5. (Deferred) the stored-descriptor data migration, then the contract step.

## Critical files

- `components/EnergyChart.tsx`, `components/SitePowerChart.tsx` → collapse into
  `components/DashboardChart.tsx` (+ thin wrappers, then delete)
- `lib/site-data-processor.ts` → extend to the fixed-series (lines) case; the single transform
- `lib/charts/` (new) — `types.ts`, `useTimeAxis.ts`, `annotations.ts`, `socRange.ts`, dataset builders
- `lib/dashboard/descriptor.ts` — `id` on `ModuleCardInstance`, re-key reconcile, `chart` defaults,
  read-shim; `lib/dashboard/cards.ts` — `chart` card type + relaxed `canRender`
- `components/DashboardClient.tsx` — render `chart` instances; extract the site-charts cluster
- `components/DashboardCustomizeDialog.tsx` — instance-id keys; offer "add line / stacked-area chart"
- `lib/queries/` — shared chart query (union of series); `keys.ts`/`freshness.ts` if touched
- Tests: `lib/dashboard/__tests__/{descriptor,customize}.test.ts` (instance-id + legacy chart
  migration), new `lib/charts/__tests__/`

## Risks

- **Persisted descriptors.** Keep the legacy read-shim (`site-charts`/`energy-chart` → `chart`)
  until the data migration ships; lock it with a legacy-input test. Don't drop the old readers early.
- **The site-charts cluster is high-surface** (period/history-window/hover-sync/series/URL/keyboard/
  touch + the 3-way Sankey fallback) and has no automated coverage — only clicking through catches
  breakage. Move it wholesale; verify every interaction in the browser.
- **Visual parity** for both chart styles across 1D/7D/30D (incl. the 30D energy-bar mode and the SOC
  range band) and the `/dashboard/{id}/...` chart subpages.

## Not in scope (orthogonal)

**WebSockets.** A future poll→push transport switch lives entirely below the card props (a
socket→`setQueryData`/`invalidateSystem` bridge near `app/providers.tsx`, dropping `refetchInterval`).
It needs an external managed pub/sub or the long-running engine (Vercel can't host a WS server) and
hooks at `updateLatestPointValue` (`lib/kv-cache-manager.ts`). It does **not** interact with this
plan — see `docs/architecture/engine-web-separation.md`.

## Verification

- `npm run build:local && npm run typecheck` green; `npm test` for `lib/dashboard` + `lib/charts`,
  including the new instance-id + legacy chart-migration tests.
- Dev card-gallery (`app/labs/card-gallery`) for both chart variants.
- Browser eyeball, logged in: a **site** system — load + generation stacked-area charts render
  identically to today; period switch + cross-chart hover-sync + prev/next + series toggle + the
  Sankey fallback all intact. A **sidebar** system — the lines chart renders identically (incl. 30D
  bars + SOC band). Then via **Customize**: add the _other_ variant to a system that has the data;
  confirm both render, reorder sticks in the render (not just the descriptor), and a **legacy saved
  descriptor** (old `site-charts`/`energy-chart`) still loads via the read-shim.
