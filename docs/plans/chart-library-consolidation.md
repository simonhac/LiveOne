# Consolidating the chart stack onto d3

> **Status: PLAN — assessment complete, execution approved. Stage 0 done; Stage 1 next.**
> Written 2026-08-01.
> Answers "we have three chart libraries, can we consolidate to just d3?". The premise is wrong in a
> useful way (there are two), the answer is yes, and the hard part is not the porting.

## The premise: there are two libraries, not three

| | Declared | Used by |
|---|---|---|
| **Chart.js** | `chart.js`, `react-chartjs-2`, `chartjs-adapter-date-fns`, `chartjs-chart-matrix`, `chartjs-plugin-annotation` | 4 render sites |
| **d3 (modular)** | `d3-sankey`, `d3-scale`, `d3-scale-chromatic`, `d3-time`, `d3-interpolate` (+ `d3-array`, `d3-shape` declared but **unimported**) | Sankey, DailyStripes, heatmap palettes |

The phantom third is **Recharts**. `README.md` and `architecture/overview.md` both list it in the
stack; it is absent from `package.json` and has zero imports anywhere in the tree. It was real once
— `EnergyChart` was Recharts-based, see [project-history.md](../project-history.md) — and the docs
were never updated when it went. Those two lines are fixed as part of Stage 0.

There is also a third *idiom* that is not a library: hand-rolled inline SVG and CSS-div charts
(`HwsSmallCard` sparkline, `AmberPriceIndicator`, the `AmberCard`/`GridSignalsCard` price strips,
`PollTimeline`). Nothing to remove there — out of scope.

## Verdict

**Feasible, and worth doing.** Chart.js is barely used *as a charting library*:

- `legend: { display: false }` at **every** site — series identity lives in `EnergyTable` and
  `ChartTooltip` instead.
- `tooltip: { enabled: false }` at **every** site — all four tooltips are hand-built.
- `animation: false` everywhere, deliberately, so focus tracking stays crisp.
- No `chartjs-plugin-zoom`, no brush, no pan. Windowing is URL-state paging
  (`lib/charts/useTemporalRange.ts`).

What is actually being used is: a time axis, linear axes, line/bar/stacked-area geometry, hover→index,
and annotation boxes. `d3-scale` + `d3-shape` + JSX cover all of it. The heatmap is already actively
fighting the library — it disables the tooltip and rebuilds it as a raw `#chartjs-tooltip` div
appended to `document.body`, and draws its own y-axis labels from an `afterDraw` plugin.

**The risk is not difficulty. It is that there is no visual test net at all** — no jsdom, no
testing-library, no Playwright, no snapshots. `components/` is not even in Jest's `roots`, and
`testMatch` only collects `.test.ts`, never `.tsx`. Every chart bottoms out in a `<canvas>`, so
there is nothing to assert against.

## What makes it tractable

- **Cross-chart hover sync is already library-agnostic.** `lib/charts/ChartFocusContext.tsx` shares
  a `focusedTime: Date` — deliberately a timestamp, not a data index, because the lines chart and
  the site charts come from different queries with independent timestamp arrays. Each chart maps
  back via `nearestIndex()`. This survives the migration untouched, and it is the single biggest
  de-risker.
- **The hover contract is trivial.** Both consumers use only `activeElements[0].index`
  (`LinesChartCard.tsx:144`, `SiteChartsCard.tsx:158`). An x→nearest-index lookup replaces it.
- **Data volumes are tiny.** D = 288 points, Y = 365; the heatmap is 30 × 48 = 1,440 cells. SVG is
  comfortable — no canvas required.
- **A good in-house precedent already exists.** `components/dashboard/DailyStripes.tsx` is the
  target idiom: d3 for *math only* (`scaleTime`, `scaleLinear().interpolate(interpolateHsl)`,
  `timeHour`), every element emitted as JSX, `ResizeObserver` for sizing, a local tooltip component.
  Copy this, not the Sankey.
- **Dark-only theming.** No light mode, no `dark:` variants in any chart code.

## What it actually costs

- **`buildTimeScale` must be rewritten, not ported.** `lib/charts/scaffold.ts:131-212` is dense
  Chart.js-specific tick hackery: `autoSkip`, returning `"     "` (five spaces) to defeat collision
  detection, a zero-width space to keep a gridline while hiding its label, multi-line label arrays,
  and a skip interval stepping 2→3→4 by tick count. Computing the tick set directly with `d3-time`
  is *cleaner* — but the current pixel behaviour is nuanced and easy to regress silently.
- **Stacked areas with gaps are the hard part.** Chart.js `Filler` + stacking semantics have to be
  reproduced with `d3-shape` `stack()` + `area()` + `.defined()`. Null handling and the SoC overlay
  on the `y1` axis are where subtle regressions live. Hence: done last.
- **ESM-only d3 breaks Jest today.** `d3-scale`/`d3-time`/`d3-interpolate`/`d3-scale-chromatic`
  throw `SyntaxError: Unexpected token 'export'` because `node_modules` is untransformed.
  `DailyStripes` is currently `jest.mock`'d out wholesale to dodge it
  (`lib/dashboard/__tests__/v4-render-props.test.ts`). Widening d3 use widens the problem — fix
  `transformIgnorePatterns` once, up front.
- **`v4-render-props.test.ts` is a byte-for-byte props golden** over what each card plugin passes to
  its leaf. The config-v4 record calls it "what made the riskiest change of the epic reviewable".
  Any prop-shape change must update it deliberately.
- **`SiteChartsCard.tsx` is 1,017 lines** and its interaction cluster (hover sync, series toggling,
  the cycling metric column, touch) was already flagged as untested by the now-shipped
  chart-generalization plan.

## Scope

| Site | Lines | Renders | Risk |
|---|---|---|---|
| `app/admin/observations/observations-viewer.tsx` | bar chart within 930 | Admin queue histogram | Low |
| `components/battery-provenance/ProvenanceChart.tsx` | 207 | N-series line + crosshair + recal bands | Low |
| `components/HeatmapChart.tsx` | 917 | 30d × 48-slot matrix | Medium — biggest win |
| `components/DashboardChart.tsx` — `lines` | 287 shared | Overlaid lines / energy bars | Medium |
| `components/DashboardChart.tsx` — `stacked-areas` | 287 shared | Stacked load/generation + SoC overlay | **High** |

Plus `lib/charts/scaffold.ts` (238) and `lib/charts/datasets.ts` (338) — pure Chart.js config,
rewritten.

**Deliberately excluded:**

- **`EnergyFlowSankey.tsx` (1,581 lines).** It is *already* d3, so converting it removes no library.
  It would be a pure-consistency rewrite of the most interaction-dense component in the app —
  post-d3 column reflow, tooltip beak placement, touch tap-to-pin, minimum hit-target strokes for
  thin ribbons — with zero coverage. It is worth doing eventually (see below), but after this work
  has built the harness that makes it verifiable.
- **The hand-rolled SVG/CSS visuals.** No library to remove.

### Follow-on: the Sankey's imperative idiom

Recorded here so the reasoning isn't lost. There are two competing hand-rolled styles in the repo:

- **`EnergyFlowSankey` — imperative.** React renders an empty `<svg ref={svgRef} />`; one large
  `useEffect` does `svg.innerHTML = ""` then builds every element with `document.createElementNS` /
  `setAttribute` / `addEventListener`. Consequences: any data change is a full teardown and rebuild
  (hence bespoke code to *restore* an open tooltip by matching keys against the new layout); hover
  emphasis loops over a collected `linkEls[]` array calling `setAttribute("opacity", …)` because
  there is no re-render to drive it; state hides in refs (`hoveredRef`, `geomRef`,
  `nodeTooltipRef`) specifically to avoid retriggering the rebuild; resize is a window listener
  rather than a `ResizeObserver`.
- **`DailyStripes` — declarative.** d3 computes, React renders. Diffing, event handling, and
  tooltip persistence come free.

Nothing about `d3-sankey` requires the imperative style — it returns plain data (`node.x0/y0/x1/y1`,
`link.width`) that maps onto JSX directly. This is a good project *once the harness exists*.

## Known defects — fix before porting, not after

A like-for-like port would faithfully reproduce every existing bug and make it much harder to tell a
regression from a pre-existing fault. Everything below was found while scoping the lines chart; the
other three charts have **not** yet been swept (Stage 2).

### Root cause of the reported legend bug

**The legend gates on the hovered value; the dataset builder gates on series presence.** They
disagree.

`lib/charts/datasets.ts:156` — correct, structural:

```ts
...(chartData.batteryW ? [ { label: "Battery", … } ] : []),
```

`components/ChartTooltip.tsx:66` — wrong, value-dependent:

```tsx
{battery !== null && battery !== undefined && ( /* the whole legend entry */ )}
```

With nothing hovered, `LinesChartCard.tsx:167-174` supplies an all-nulls object, so the **Battery
and Grid entries do not exist in the DOM**. Solar, Load and Battery SOC are always rendered (their
value slot just blanks), which is why only two of the five entries jump around.

### Register

| # | Defect | Location |
|---|---|---|
| 1 | Battery/Grid legend entries appear only on hover | `ChartTooltip.tsx:66,88` |
| 2 | Same gate makes them **flicker mid-hover** when the focused index lands on a null sample (a data gap) | `ChartTooltip.tsx:66,88` |
| 3 | `batteryW` is built as an **all-nulls array**, never `undefined` (`lines-data.ts:150-154`); `[null,…]` is truthy, so a phantom "Battery" dataset is added for battery-less devices and in energy mode, where `batteryWData` is deliberately nulled (`lines-data.ts:61`). `grid` correctly uses `undefined` (`:167`) — **the two fields are inconsistent**. In energy mode this is likely *visible*: Chart.js allocates a grouped-bar slot per dataset, so a phantom fourth dataset narrows and offsets the real bars. **Confirm empirically in the harness.** | `lines-data.ts`, `types.ts:38` |
| 4 | Two rows both labelled **"Battery"** — battery power (orange) and battery SOC (green) — distinguishable only by swatch colour. The dataset labels correctly say "Battery" vs "Battery SOC". | `ChartTooltip.tsx:69,108` |
| 5 | Dead `visible` prop — hardcoded `true` at `LinesChartCard.tsx:310`, never read in the component | `ChartTooltip.tsx:11,21` |
| 6 | **Three independent sources of truth for series colour**: Tailwind classes in `ChartTooltip` (`bg-yellow-400`…), hardcoded RGB literals in `datasets.ts` (`rgb(250, 204, 21)`…), and `CHART_COLORS` in `lib/chart-colors.ts` (used only for the SoC range fill and dynamic series). They agree today purely by coincidence of two hand-copied palettes. | 3 files |

**Defects 1–3 share one fix:** make `batteryW` optional and `undefined`-when-absent in
`LineChartData`, matching `grid`. Both the dataset gate and the legend gate then become the same
structural `!= null` test, and the legend is derived from *which series exist* rather than from the
hovered sample. 4–6 are independent tidy-ups; 6 should route both the swatch and the line colour
through `CHART_COLORS`.

## Sequencing — and why this order

Two constraints were set: build the screenshot harness first, and don't reimplement known bugs.
**They interact.** A baseline captured before the bug fixes would enshrine the bugs as "correct",
and every later fix would churn it. So:

> harness → catalogue defects → fix defects **on Chart.js** → freeze baseline → migrate under a
> zero-pixel-diff rule

Fixing first also means the port itself is a pure like-for-like, which is far easier to review —
the same tactic the config-v4 epic used with its props golden.

### Stage 0 — Measure and unblock (no visual change) — ✅ DONE 2026-08-01

- ✅ Added `@next/bundle-analyzer` (pinned to the Next 15 line), opt-in via `npm run analyze`
  (`ANALYZE=true`, `openAnalyzer: false`, writes to the gitignored `.next-analyze/`). Baseline below.
- ✅ Fixed the Jest ESM-d3 transform. See [Jest and ESM d3](#jest-and-esm-d3).
- ✅ Fixed the stale Recharts claims in `README.md` and `architecture/overview.md`.

#### Bundle baseline (2026-08-01, `next@15.5.15`)

The payoff is no longer assumed. Per-package client totals, from the analyzer:

| Package | gzip | parsed |
|---|---|---|
| `next` | 254.9 kB | 616.0 kB |
| **`chart.js`** | **66.5 kB** | **195.3 kB** |
| `react-dom` | 53.1 kB | 167.3 kB |
| `chartjs-plugin-annotation` | 11.7 kB | 35.5 kB |
| `chartjs-adapter-date-fns` | 6.8 kB | 21.4 kB |
| `chartjs-chart-matrix` | 1.3 kB | 4.0 kB |
| `react-chartjs-2` | 0.7 kB | 2.1 kB |
| **Chart.js family total** | **87.0 kB** | **264.1 kB** |
| **d3 family total** (7 pkgs) | **22.6 kB** | **56.6 kB** |

**Chart.js is the largest non-framework dependency in the entire client bundle — larger than
`react-dom`.** It is ~3.8× the whole d3 stack for four render sites.

Next's reported First Load JS: `/device/[...slug]` 534 kB, `/dashboard/[...slug]` 446 kB,
`/labs/card-gallery` 395 kB, `/test-sankey` 112 kB; 102 kB shared by all.

Expect the migration to *return* most of the 87 kB. It will not be all of it — axis tick formatting
needs `d3-time-format`/`d3-format` and the stacked areas need `d3-shape`, none of which are in the
client bundle today (`d3-shape` and `d3-array` are declared in `package.json` but unimported, so
`d3-array`'s 0.9 kB arrives only via `d3-sankey`). A net saving in the **60–75 kB gzip** range is the
realistic target; re-measure at Stage 6 rather than trusting this estimate.

#### Jest and ESM d3

Reproduced, then fixed. The failure was real: importing `d3-scale` from any test threw
`SyntaxError: Unexpected token 'export'`.

The fix needed **two** parts, and the second is the one that's easy to miss:

1. `transformIgnorePatterns: ["/node_modules/(?!(d3-[^/]+|internmap)/)"]` — un-ignore d3.
2. A `^.+\.js$` transform. The configs previously transformed **only** `.tsx?`, so un-ignoring d3
   alone would have left it with no transformer at all.

Both now live in `jest.shared.js`, consumed by all three configs (they had three hand-copied
transform blocks; the regex is too subtle to duplicate). Guarded by
`lib/charts/__tests__/d3-esm-imports.test.ts`, which covers `d3-sankey` specifically because npm
gives it nested `node_modules/d3-sankey/node_modules/{d3-array,d3-shape}` copies — proving the
lookahead re-evaluates at a second `/node_modules/` segment. Full suite: 156/156 green.

**The `DailyStripes` mock in `v4-render-props.test.ts` stays.** It was documented as having two
causes; only the ESM one is fixed. The other — its props embed a `Date.now()`-derived
`firstDayMidnightMs` (`components/dashboard/cards/daily-stripe.tsx:67`), which would bake today's
date into the checked-in golden and turn it red at the next local midnight — is load-bearing on its
own. The comment there has been corrected so ESM is no longer cited as a blocker.

### Stage 1 — Playwright screenshot harness

- Add Playwright, driving the dev server against `liveone-dev`.
- **Fixture data, not live data** — a live-data baseline is not reproducible. Extend the
  `app/labs/card-gallery` fixture approach to the chart cards, or add a `?fixture=` route param.
- Cover 4 charts × D/W/M/Y × power/energy × mobile + desktop.
- This is the first automated coverage `components/` has ever had.

### Stage 2 — Catalogue defects

Sweep all four charts the way the lines legend was swept. Land the result in this doc with an
explicit **fix / carry-forward / won't-fix** decision per item. No code — this is the artefact to
review before any porting starts.

### Stage 3 — Fix agreed defects, still on Chart.js

One PR per cluster; baseline churn is expected and reviewed deliberately. Start with the `batteryW`
optionality fix (defects 1–3). **Freeze the baseline at the end of this stage.**

### Stage 4 — Shared d3 primitives

`lib/charts/svg/`, extracted from the `DailyStripes` idiom rather than invented: `useContainerSize`
(lift the existing `useContainerWidth`), `<TimeAxis>`, `<ValueAxis>`, `<ShadingBands>` (replacing
`buildShadingAnnotations`), `<FocusLine>`, `usePointerIndex`, `<Tooltip>`.

### Stage 5 — Migrate, one chart per PR

Acceptance rule from here on: **the screenshots must not change.** Any diff is a bug or a
regression and must be explained.

1. `observations-viewer` bar chart — admin-only, lowest stakes, proves the primitives.
2. `ProvenanceChart` — exercises crosshair, annotation bands, `stepped`, `spanGaps`.
3. `HeatmapChart` — biggest win. Deletes `chartjs-chart-matrix`, the `#chartjs-tooltip` body-append
   hack, and the custom `afterDraw` y-axis-label plugin. Expect the file to get *shorter*.
4. `DashboardChart` `lines`.
5. `DashboardChart` `stacked-areas` — highest risk, last, with everything else proven.

### Stage 6 — Remove Chart.js

Drop the five packages from `package.json` and from `packages/usher/package.json` (declared there
but never imported). Delete `registerChartScaffold()`. Re-measure against the Stage 0 baseline.

## Verification

- `npm run build:local && npm run typecheck` before each commit.
- `npm test` — `lib/charts/` and `lib/dashboard/` suites stay green; the `v4-render-props` golden
  unchanged except where deliberately updated.
- Playwright: zero pixel diff from Stage 5 onward.
- Manual, per PR, for what screenshots can't catch: cross-chart hover sync (hover the lines chart →
  the stacked chart, energy table and Sankey all follow), series toggling in `EnergyTable`, the
  cycling metric column, D/W/M/Y paging via URL state, and touch on a real phone — the
  `"ontouchstart" in window` branches at `LinesChartCard.tsx:177`, `SiteChartsCard.tsx:250,485,510`
  and `ProvenanceChart.tsx:193`.

## Estimate

~2,000 lines rewritten. Net LOC flat to slightly down; the heatmap should shrink noticeably. The
migration itself is the predictable part — Stages 1–3 (harness and defect cleanup) are where the
uncertainty is, and they are worth doing whether or not the consolidation proceeds.
