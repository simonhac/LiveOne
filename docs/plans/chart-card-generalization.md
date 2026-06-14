# Plan: generalize the two charts into one instance-id'd `chart` card

> **Status:** proposed — not started (drafted 2026-06-14). The agreed next substantive phase after
> the card-uniformity + tile-rename work (P1–P7) shipped to `main` in **#77**. Line refs below are
> verified against the current **post-#77** code; delivery is decided (one PR); coordination with the
> parallel descriptor-migration chat is captured. No code written yet.

## Context

The dashboard has two time-series chart components that grew up separately and are **mutually
exclusive by vendor**: a system gets `energy-chart` (sidebar — Selectronic/Enphase) **or**
`site-charts` (site — mondo/composite), never both. The user wants charts to be **first-class,
vendor-independent cards** so a dashboard can show **either or both** line and stacked-area charts,
picked in Customize like any other card. ~70% of the two components is duplicated Chart.js
scaffolding.

This is the agreed next phase after the card-uniformity + tile-rename work shipped to `main` in
**#77** ("Unify dashboard cards: one data path, one card grid, tiles rename"). Working branch:
`simonhac/chart-card-generalization` (cut from #77).

## Verified current state (post-#77)

- `ModuleCardInstance` keys cards by **`type`**, no `id` (`lib/dashboard/descriptor.ts:25`).
  Reconcile is `new Map(s.cards.map(c => [c.type, c]))` (`descriptor.ts:145`); `isCardVisible` does
  `find(c => c.type === type)` (`descriptor.ts:189`). **The one-card-per-type assumption is what
  this plan must break.**
- `CARD_REGISTRY` gates `site-charts`/`sankey` to `isSiteVendor` and `energy-chart` to
  `!amber && !site` (`lib/dashboard/cards.ts:71-87`). `getLayout` at `:109`.
- `DashboardClient.tsx` renders each card inline, gated by `cardVisible(type)`
  (`:843`). Chart regions: `site-charts` block `:1031-1375` (two `SitePowerChart` at `:1232` load /
  `:1287` generation; Sankey `:1341`); `energy-chart` block `:1376-1411`. Imports `EnergyChart`
  (`:25`) and `SitePowerChart` + `ChartData` (`:29`).
- **The ~600-line site-charts cluster** lives at the top of `DashboardClient`: useState
  `:310-408` (period, `historyTimeRange` + ~70-line URL init, `hoveredIndex`, `activeChart`,
  series-visibility sets), queries+effects `:427-494` (`siteDataQuery`, mirror effect, window
  normalize, `flowMatrixQuery`), handlers `:507-693` (`handlePageNewer/Older`, hover sync). **#77
  deliberately left this inline to be extracted here.**
- `EnergyChart.tsx` — props `:45-51` (no `data`; **self-fetches** `historyQuery` `:262`); local
  fixed-field `ChartData` `:53-63`; `buildSeriesParam` `:66`, `buildChartData` `:89`, `findSeries`
  `:96`.
- `SitePowerChart.tsx` — props `:45-62` (**receives `data`**; hover lifted via `onHoverIndexChange`
  `:328`); exported generic `ChartData {timestamps, series: SeriesData[], mode}` `:72-76`,
  `SeriesData` `:64-70`; `generateSeriesConfig` `:107` (called by the processor).
- `lib/site-data-processor.ts` — `fetchAndProcessSiteData(systemId, period, startTime?, endTime?)`
  `:743`; output `ProcessedSiteData {load, generation, requestStart, requestEnd, flowMatrix}`
  `:13-20`; `processMode` `:514`, `processSiteData` `:683`.
- Dev gallery exists: `app/labs/card-gallery/` (tiles only today — add chart variants here).
- `DashboardCustomizeDialog.tsx` — module rows keyed `key={`mod:${c.type}`}` (`:147`), toggled by
  `toggleModule(type, hide)` (`:181`); tiles keyed `tile:${id}`. **Per-type keying — must
  generalise to instance id.**

## Target design (one contract, one scaffold, two builders, instance-id placement)

1. **One `ChartData` contract** — adopt SitePowerChart's generic `{timestamps, series: SeriesData[],
mode}` as the single shape (`lib/charts/types.ts`); EnergyChart's fixed `{solar, load, batteryW,
…}` becomes a series list. Delete both component-local `ChartData` types.
2. **One `<DashboardChart variant="lines"|"stacked-areas" split?>` component** — composes the shared
   scaffold, dispatches to `buildLineDatasets` vs `buildStackedAreaDatasets`. Both **presentational**
   (parent supplies `data`). `EnergyChart`/`SitePowerChart` collapse into it, then are deleted.
3. **Shared scaffold (`lib/charts/`, tested)** — extract `useTimeAxis`, `buildShadingAnnotations`,
   `buildSocRangeDatasets`, `useChartWindow`. Colours already in `lib/chart-colors.ts`.
4. **Descriptor instance-id keys + a `chart` card type (the structural change, expand→migrate→contract):**
   - Add `id: string` to `ModuleCardInstance` (`descriptor.ts:25`). **Rule: dispatch on `type`,
     identity flows on the instance.**
   - Re-key reconcile `descriptor.ts:145` and `isCardVisible` `:189` from `type`→`id`; generalise
     the Customize dialog row key/toggle (`DashboardCustomizeDialog.tsx:147/181`). Today's
     singletons get a deterministic `id == type` so nothing else changes.
   - Add one `chart` card type carrying `{variant, split?, series?}` on the instance (mirrors how
     `tiles` carries `TilesConfig`). Relax `canRender` — drop the `isSiteVendor` gate.
   - `buildDefaultDescriptor`: site → two `chart` (stacked load+generation) + Sankey; sidebar → one
     `chart` (lines). `migrateLegacyDescriptor` read-shim: `site-charts`→two stacked `chart`,
     `energy-chart`→one lines `chart`. **Keep the shim until the data migration ships.**
5. **Data flow — no extra requests.** `DashboardClient` (or a small hook) owns the fetch, walks
   visible `chart` instances, takes the **union of their `series[]`**, issues **one**
   `historyQuery({interval, window, series: union})`; the processor (`site-data-processor.ts`,
   extended to the fixed-series "lines" case) runs once; each card selects its series client-side.
   React Query dedupes by key → N chart cards = one request. Fold EnergyChart's
   `buildChartData`/`buildSeriesParam` into the same processor path.
6. **Fold in the deferred `SiteChartsCard` extraction.** Move the `:310-693` state/handlers/effects
   - `:1031-1411` JSX cluster (period, history window, hover-sync, series toggles, prev/next nav,
     keyboard/touch/URL effects, 3-way Sankey fallback) **wholesale** into the chart card(s) / a small
     owning component — move JSX + state, don't rewrite the interaction logic.

## Delivery: ONE PR (user-chosen), built in green internal phases

Land the whole refactor as a single PR on `simonhac/chart-card-generalization`. The phases below are
internal commits, each green (`build:local` + `typecheck` + `npm test`), not separate PRs:

1. **Scaffold extraction** → `lib/charts/` behind the existing two components (pure refactor, no
   behaviour change). Green + unit-tested first.
2. **`<DashboardChart>`** built; reduce `EnergyChart`/`SitePowerChart` to thin wrappers over it.
3. **Descriptor instance-id + `chart` card type** + read-shim + `buildDefaultDescriptor` defaults +
   Customize-dialog generalisation. New tests in `lib/dashboard/__tests__/{descriptor,customize}.test.ts`.
4. **Switch `DashboardClient`** to render `chart` instances from the descriptor; extract the
   site-charts cluster; delete the old `site-charts`/`energy-chart` inline branches and card types
   (still readable via the shim).

The **stored-descriptor data migration is a SEPARATE, LATER follow-up** (user-chosen "leave for
later"), run only after this PR deploys to preview+prod — exactly the tiles/amber pattern. The PR
ships the read-shim only.

## Critical files

- `components/EnergyChart.tsx`, `components/SitePowerChart.tsx` → collapse into
  `components/DashboardChart.tsx` (+ thin wrappers, then delete)
- `lib/charts/` (new) — `types.ts`, `useTimeAxis.ts`, `annotations.ts`, `socRange.ts`, dataset builders
- `lib/site-data-processor.ts` — extend to the fixed-series (lines) case; single transform
- `lib/dashboard/descriptor.ts` — `id` on `ModuleCardInstance`, re-key reconcile, `chart` defaults,
  read-shim; `lib/dashboard/cards.ts` — `chart` card type + relaxed `canRender`
- `components/DashboardClient.tsx` — render `chart` instances; extract the site-charts cluster
- `components/DashboardCustomizeDialog.tsx` — instance-id keys; "add line / stacked-area chart"
- `lib/queries/` — shared chart query (union of series)
- Tests: `lib/dashboard/__tests__/{descriptor,customize}.test.ts`, new `lib/charts/__tests__/`

## Risks

- **Persisted descriptors** — keep the legacy read-shim (`site-charts`/`energy-chart`→`chart`) until
  the data migration ships; lock it with a legacy-input test. Don't drop old readers early.
- **The site-charts cluster is high-surface** (period/history-window/hover-sync/series/URL/keyboard/
  touch + 3-way Sankey fallback) with **no automated coverage** — only click-through catches
  breakage. Move it wholesale; verify every interaction in the browser.
- **Visual parity** for both styles across 1D/7D/30D (incl. 30D energy-bar mode + SOC range band)
  and the `/dashboard/{id}/...` chart subpages.

## Coordination with the other chat (descriptor data migration)

A parallel chat is shipping the **write-side data migration for #77's renames** (`power-cards`→`tiles`,
`amber`→`amber-now`/`amber-timeline`) — a tsx script that `--apply`s the existing
`migrateLegacyDescriptor` transform to persist the `dashboards.descriptor` JSONB. That is a
**different, earlier** migration than this plan's deferred chart migration. To avoid collisions:

- **Keep `migrateLegacyDescriptor` strictly additive.** It is exporting that function (no logic
  change) for its script; this plan **adds new `else if` branches** (`site-charts`→two stacked
  `chart`, `energy-chart`→one lines `chart`) and must **not** touch or remove the existing
  tiles/amber branches. Rebase on their PR once merged before finalizing the descriptor edits.
- **`id`-less saved rows must normalize cleanly.** Their migration persists rows in the current
  type-keyed shape (no `id`). This plan's `normalizeDescriptor` already assigns deterministic
  `id == type` to singletons, so previously-persisted rows (incl. their migrated ones) reconcile
  without error. Lock this with a test.
- **Descriptor readers.** The share/consumption endpoint (PR #72) and any other descriptor consumer
  must route through `normalizeDescriptor` so they tolerate both the new `id`/`chart` shape and
  legacy rows. Verify before deleting old card types.

## Not in scope (orthogonal)

**WebSockets.** A future poll→push transport switch lives below the card props (a
socket→`setQueryData`/`invalidateSystem` bridge near `app/providers.tsx`, dropping
`refetchInterval`; hook at `updateLatestPointValue`, `lib/kv-cache-manager.ts:97`). Does not interact
with this plan.

## Verification

- `npm run build:local && npm run typecheck` green; `npm test` for `lib/dashboard` + `lib/charts`
  (new instance-id + legacy chart-migration tests).
- Dev card-gallery (`app/labs/card-gallery`) for both chart variants.
- Browser, logged in: a **site** system (8) — load + generation stacked-area render identically;
  period switch + cross-chart hover-sync + prev/next + series toggle + Sankey fallback intact. A
  **sidebar** system (1) — lines chart identical (incl. 30D bars + SOC band). Then via **Customize**:
  add the _other_ variant to a system that has the data; confirm both render, reorder sticks in the
  render (not just descriptor), and a **legacy saved descriptor** still loads via the read-shim.

---

## Aside: why composite systems still exist

The Areas/Dashboards work **was** meant to make composite-as-a-fake-`systems`-row obsolete, and the
non-destructive part of that **has shipped** — but the destructive tail that actually deletes the
composite system row is **deliberately deferred behind a soak gate**. So composites still exist as
the legacy substrate Areas now reads _through_, not as the long-term model.

State today (`docs/architecture/areas-and-dashboards.md`, `docs/deferred/areas-p3-tail-and-p4-plan.md`):

- A composite is a `systems` row with `vendorType='composite'` (#7 Craig, #8 Kinkora) whose
  `metadata.mappings` JSON maps roles→child points. It never polls; its live values are fanned out
  at KV-write time via the subscription registry, and dashboards gate the "site" layout on
  `isSiteVendor` (`lib/dashboard/cards.ts:47`).
- **P3 shipped (flag `AREAS_TABLE=true`, live):** first-class `areas` + typed `area_bindings` +
  `roles` tables. A composite Area (`kind='composite'`) is just rows in those tables — **no fake
  system row needed**. The read layer is dual-mode: `area_bindings` when the flag is on, legacy
  `metadata.mappings` when off, with byte-identical semantics (parity-tested).
- **Why the fake row is still there:** the destructive tail is gated. It needs (a) dropping
  `point_readings_flow_1d.system_id` and re-keying the flow matrix to `area_id` (P3-tail-1, Phase A
  shipped in #69), and (b) retiring the `metadata` shim + the orphaned `CompositeAdapter`
  pseudo-vendor (P3-tail-2). Until those land, the composite `systems` row is kept so nothing
  reading the old path breaks during the soak.

**Short version:** composites aren't the future model — Areas already replaces them — but they're
kept alive as a compatibility shim until the soak-gated P3 destructive tail drops the fake system
row. It's a not-yet-removed legacy, not a missing feature.

Relevant to _this_ chart plan: the `chart` card's `canRender` should gate on **data presence**
(does the system/Area expose the requisite series), not on `isSiteVendor` — which moves one more
consumer off the composite-as-vendor assumption, consistent with the Areas direction.
