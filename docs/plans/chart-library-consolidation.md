# Consolidating the chart stack onto d3

> **Status: PLAN — Stages 0–3 COMPLETE; Stage 4's type/naming cleanups (#18, #15) also done.
> Remaining: the d3 primitives, then Stage 5 porting.** Written 2026-08-01.
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

- `legend: { display: false }` at every **dashboard** site — series identity lives in `EnergyTable`
  and `ChartTooltip` instead.
- `tooltip: { enabled: false }` at every **dashboard** site — those tooltips are all hand-built.
- ⚠️ **Corrected 2026-08-01 (Stage 2):** an earlier revision of this doc said "every site". That is
  wrong. `app/admin/observations/observations-viewer.tsx` (the `/admin/observations` ops page) uses
  Chart.js's **built-in legend and built-in tooltip** — the only place in the repo that does. It is
  a two-series, admin-only page, so the plan is to **simplify** it during the port rather than
  rebuild Chart.js's legend; see Stage 2's sizing note.
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
| 6 | **The two charts use different colour schemes for the same physical quantity** — see below. | 3 files |

#### Defect 6, in full: the lines chart and the stacked chart disagree on colour

The stacked chart and the Sankey resolve colour through `getColorForPath` → `CHART_COLORS`
(`lib/site-data-processor.ts:709`, `lib/energy-flow-matrix.ts:462`). The lines chart does not — it
hardcodes RGB literals inline in `lib/charts/datasets.ts`, and `ChartTooltip` hardcodes matching
Tailwind classes a third time.

| Quantity | Lines chart (`datasets.ts`) | Stacked / Sankey (`CHART_COLORS`) | |
|---|---|---|---|
| Solar | `rgb(250,204,21)` yellow-400 | `rgb(254,240,138)` yellow-200 | different shade |
| **Battery power** | `rgb(251,146,60)` **orange-400** | `rgb(74,222,128)` **green-400** | **different hue** |
| **Grid** | `rgb(239,68,68)` **red-500** | `rgb(236,72,153)` **pink-500** | **different hue** |
| Battery SoC | `rgb(74,222,128)` green-400 | `rgb(74,222,128)` green-400 | agree |
| Load | `rgb(96,165,250)` blue-400 | no single "load" (`restOfHouse` gray-400) | n/a |

The collisions are the actual harm, not the drift:

- The lines chart's **Battery** orange-400 is *byte-identical* to `CHART_COLORS.hotWater`.
- The lines chart's **Grid** red-500 sits next to `CHART_COLORS.ev` (red-600).

These two charts render **side by side in the same section with synced hover**
(`ChartFocusContext`). So as the user sweeps across them, orange means Battery on one chart and Hot
Water on the other, and red means Grid on one and EV on the other. That is actively misleading, and
it is the kind of thing a faithful port would carry forward forever.

**Fix:** make `CHART_COLORS` the sole source. `datasets.ts` stops hardcoding and resolves through
`getColorForPath`/`CHART_COLORS`; `ChartTooltip` takes its swatch colour as a prop from the same
resolution rather than naming a Tailwind class. Decide deliberately *which* palette wins per
quantity — this is a visible product change, not a refactor, so it gets its own Stage 3 PR and its
own reviewed baseline diff. Gallery cases `colours-lines-vs-stacked-*` exist to make the before/after
obvious.

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

### Stage 1 — Playwright screenshot harness — ✅ DONE 2026-08-01 (heatmap + provenance outstanding)

**34 baselines** (17 cases × desktop/mobile), green and stable across repeated runs. This is the
first automated coverage `components/` has ever had.

- `app/labs/chart-gallery` — the screenshot target, modelled on `card-gallery`: dev/preview-only,
  `notFound()` in prod, allow-listed in `lib/route-matchers.ts`. `?case=<id>` renders one case.
- `app/labs/chart-gallery/cases.ts` — the case list, imported by **both** the page and the spec, so
  they cannot drift.
- `e2e/charts.spec.ts` + `playwright.config.ts`; `npm run test:e2e` / `test:e2e:update` / `test:e2e:ui`.

**No live data, no clocks.** Fixtures are a pure function of the case name against a frozen instant
(2026-06-15 14:30 AEST). Note `card-gallery`'s fixtures stamp ages at *import* — fine for eyeballing,
fatal for a checked-in baseline, so this harness does not reuse them.

Determinism settings that are load-bearing rather than boilerplate, each of which produced a real
failure before being pinned:

- `timezoneId: "Australia/Melbourne"` — the charts format ticks with date-fns `format`, which renders
  in the **browser's** local zone; unpinned, CI-on-UTC and a Melbourne laptop disagree on every axis.
- `deviceScaleFactor: 1` — a retina Mac otherwise writes 2× baselines CI can't match.
- Runs against a **production build** (`next start`, `BUILD_DIR=.next-e2e`), not `next dev` — dev
  injects an indicator and recompiles on first hit.
- `webServer.url` probes `/labs/chart-gallery`, **not** `/`. The root route is Clerk-gated and answers
  the readiness probe with a redirect, so Playwright concludes the server is down, ignores
  `reuseExistingServer`, and then fails to bind a port the running server holds.
- The spec waits on `document.fonts.ready` + a non-zero canvas box + two rAFs. Chart.js paints on a
  rAF after mount; screenshotting earlier yields a blank or fallback-font baseline.
- `@vercel/analytics` requests `/_vercel/insights/script.js`, which 404s off-Vercel on every page.
  Allow-listed narrowly in the spec rather than by relaxing the console-error assertion.

#### Measured sensitivity — know what this does and does not catch

The thresholds were calibrated with a deliberate negative control, not guessed:

| Change | Detected? |
|---|---|
| Solar `rgb(250,204,21)` → `rgb(250,204,26)` (5/255 on one channel) | **No** |
| Solar yellow-400 → yellow-200 (the real Stage 3 change) | **Yes** — 1345 px, 20× over the limit |

The first setting tried (`maxDiffPixelRatio: 0.002`, default `threshold`) **passed the realistic
change by a hair and missed the tiny one entirely** — on a 932×372 frame it permitted ~700 differing
pixels, more than a thin chart line contains. Now split explicitly: `threshold: 0.15` carries the
per-pixel antialiasing tolerance, `maxDiffPixelRatio: 0.0002` (~70 px) carries the count. Sub-
perceptual colour shifts are still missed — an accepted limit, recorded so nobody assumes otherwise.

Also fixed in passing: `/labs/card-gallery` was **never covered** by `route-matchers.test.ts`, and
the `VERCEL_ENV !== "production"` guard means the existing assertions only ever exercised the
non-prod branch. Both galleries are now asserted public in dev **and** gated under a re-imported
`VERCEL_ENV=production`, with a control assertion so the re-import can't pass vacuously.

**Coverage completed 2026-08-01 — now 50 baselines (25 cases × desktop/mobile).**

- `ProvenanceChart` — 4 cases in the gallery with fixture props (it is props-driven; the *panel*
  fetches). Pins the stepped line, the dashed 1px probe overlay, dual axes, recal bands behind the
  crosshair, and `spanGaps: false` breaking rather than bridging a hole.
- `HeatmapChart` — 3 cases fed by Playwright intercepting `/api/history` with
  `heatmapHistoryFixture`. Its own request window still comes from the real clock, but nothing
  rendered depends on it. Covers the ≤50 W black baseline, a non-power metric using the full palette
  (#10/#11), and a window spanning the 5 Apr fall-back — where the asterisks and footnote appear, and
  the solar arc visibly steps one column at the boundary.
- `observations-viewer` — deliberately **not** covered: we are changing how it looks (#17), so a
  baseline would only record something we intend to discard.

> 🛑 **The heatmap cases were flaky on first attempt, and the cause applied to every chart.** They
> passed on generation and failed on re-run with sub-pixel drift plus speckled tick text. Chart.js
> measures tick-label widths at its FIRST layout and never re-measures when a webfont arrives later,
> so mounting before DM Sans loaded sized the axes with the fallback font and shifted `chartArea` by
> an amount that varied with load timing. The heatmap merely exposed it — 60 rotated tick labels, so
> the error accumulates instead of rounding away. Waiting in the test does not help; by then the
> chart has laid out. The gallery now holds every case unmounted until `document.fonts.ready`, and
> `data-case-ready` is the flag the harness waits on. Verified stable over three consecutive runs.

### Stage 2 — Catalogue defects — ✅ DONE 2026-08-01

Swept `HeatmapChart`, `ProvenanceChart` and `observations-viewer`. Register below (#7–#17), joining
#1–#6 from the lines chart. **No code changed here.**

✅ **All decisions signed off 2026-08-01** — the four that needed a judgement call rather than an
obvious fix were: #6 (which palette wins → `CHART_COLORS`, with SoC dashed), #9 (DST → bucket by the
fixed offset, with an asterisked-row convention), #10/#11 (→ true min–max), and #17 (the admin viewer
→ simplify rather than reproduce). Each is written up under **Stage 3**.

#### 🔴 #7 — the heatmap's y-axis plugin corrupts every other chart in the app

The worst thing found, and it is not a heatmap bug — it is a bug the heatmap inflicts on the
dashboard.

`HeatmapChart.tsx:108` registers `customYAxisPlugin` **globally**:

```ts
ChartJS.register(customYAxisPlugin as any);
```

Chart.js plugins registered this way run on **every chart instance in the process**. The plugin's
`afterDraw` has no chart-type guard — only `if (!yAxis) return` — so on the lines and stacked charts
it takes the `else` branch (`:82-90`) and re-draws every `scales.y` tick label, right-aligned at
`chartAreaLeft - 10`, on top of the labels Chart.js already drew at its own padding. Result:
**doubled / ghosted left-axis labels**.

This is live in production. `components/dashboard/registry.tsx` statically imports all 20 card
plugins, `heatmap.tsx` → `HeatmapPanel` → `HeatmapChart`, so the registration happens on **every
dashboard page load** whether or not a heatmap card is present.

Confirmed empirically, not by reading: adding a bare `import "@/components/HeatmapChart"` to the
gallery flipped `lines-d-power`, `stacked-load-d` and `stacked-load-d-focused` to failing, and the
diff was confined to the left axis labels. It only touches `y`, never `y1` — which is exactly why the
right-hand SoC axis is unaffected in the diff. Probe reverted.

> **Harness fidelity gap this exposes:** the gallery imports only `DashboardChart`, so the Stage 1
> baselines capture the charts *uncontaminated* — i.e. **not** what the real dashboard renders. Fix
> #7 before Stage 5 and the gap closes on its own. Do not "fix" it by importing the heatmap into the
> gallery.

**Fix** — scope the plugin to the heatmap instance (pass it in the `plugins` array of that `<Chart>`,
not `ChartJS.register`). This is a one-line change that can ship immediately, independent of the
migration.

#### The rest

| # | Chart | Defect | Proposed |
|---|---|---|---|
| 8 | Heatmap | ✅ **fixed 3f** — **`console.log` spam in production** — `:221,222,242,243,371` log the URL, the *entire* API response (30 days × 48 slots), and `:280` logs **once per series** inside the `find` predicate. | **Fix** |
| 9 | Heatmap | ✅ **fixed 3d** — bucketed by fixed offset. **DST silently loses an hour, twice a year.** Time slots are a hardcoded 48 × half-hour grid (`:306-310`), but a local day has 46 or 50 slots across a DST boundary. On fall-back, two distinct UTC intervals produce the same `timeKey` and `:337` overwrites — one hour of data vanishes. On spring-forward, 02:00/02:30 never exist and render as a fake no-data hole. | **Fix** — see 3d |
| 10 | Heatmap | ✅ **fixed 3e** — true min–max. **Narrow-range series render washed out.** `getNormalizedValue` divides by `Math.max(max - min, 1)` (`:473`). A divide-by-zero guard, but it silently distorts every series whose range is < 1 — a temperature sitting 40.1–40.5 only ever reaches 0.4 of the palette. Common for SoC, temperature, price. | **Fix** |
| 11 | Heatmap | ✅ **fixed 3e** — fixed with #10. **The colour legend lies for those same series.** The gradient always spans `getColor(0)`→`getColor(1)` and is labelled `min`→`max` (`:858-912`), but per #10 the cells never reach 1. Same root cause, separate visible symptom — worth listing so the fix is verified against both. | **Fix with #10** |
| 12 | Heatmap | `parseInterval` returns **0** for an unrecognised interval (`:435,450`). `intervalMs = 0` collapses every reading onto one timestamp and the heatmap silently becomes a single column. Should surface, not guess. | **Fix** |
| 13 | Heatmap | `heatmapData?.min \|\| 0` / `?.max \|\| 1` (`:599,600,773,774`) — `\|\|` where `??` is meant. Harmless for today's values but a latent trap when a legitimate `0` appears. | **Fix** (trivial) |
| 14 | Heatmap | Tooltip hiding is implemented **twice**: a container `mousemove` listener (`:486-524`) and the `external` tooltip's own `isInChartArea` check (`:566-577`) test the same condition. Both vanish in the port. | **Won't fix** — deleted by Stage 5 |
| 15 | Provenance | ✅ **fixed in Stage 4** — `buildTimeScale(timeRange, windowEnd, windowStart)` — the shared helper names that parameter `now`, and in `buildShadingAnnotations` it genuinely is "now". Correct here (no shading), but the name is wrong and invites a real bug. | **Fix** — rename to `windowEnd` in Stage 4 |
| 16 | Provenance | The crosshair red `rgb(239, 68, 68)` is hardcoded a **third** time (`:135`), alongside two copies in `DashboardChart`. Belongs with #6. | **Fix with #6** |
| 18 | Lines chart | ✅ **fixed in Stage 4** — `LineChartData`'s `number[]` element types are false; every field carries nulls, laundered by an `as ChartData` cast. The root enabler of #1–#3. See below. | **Fix in Stage 4** |
| 17 | Admin viewer | Uses Chart.js's **built-in legend and tooltip** — the only site that does (`:344-347`). Not a defect; a scope correction. See the Verdict note and the sizing decision below. | **Simplify**, don't reproduce |

#### #18 — `LineChartData`'s element types are a lie (found during Stage 3b)

`LineChartData` declares `solar: number[]`, `load: number[]`, `batteryW?: number[]`,
`batterySOC: number[]`. **All of them contain `null` in production.** `buildChartData` fills them
from `convertToKw`, whose signature is `(value: number | null, units: string) => number | null`, and
also emits `selectedIndices.map(() => null)` for an absent solar/load series — then launders the
whole mismatch through a blanket `as ChartData` at its own return statement
(`lib/charts/lines-data.ts`).

This is not cosmetic: it is the reason the #1/#2/#3 family was possible to write. Because the type
says "no nulls here", every consumer is free to reason as if a value is always present, and the
compiler cannot object when one conflates "the series is absent" with "this sample is null". It also
propagated into the harness — the fixture's `?? NaN` existed *purely* to satisfy the false type, and
that silently disabled the gap cases.

**Proposed: fix to `(number | null)[]` and delete the `as ChartData` cast**, letting the compiler
find the call sites that assume non-null. Not done in 3b to keep that slice reviewable as one idea.
Natural home is Stage 4, alongside the other type/naming cleanups (#15) — and it wants doing *before*
Stage 5, since the port will otherwise inherit the same blind spot. The gallery fixture carries an
`as unknown as LineChartData` cast with a pointer here; delete it when this lands.

---

`ProvenanceChart` is otherwise the healthiest of the four: honest gaps (`spanGaps: false`), a
documented re-entrancy guard on `onHover`, no console noise, per-series styling driven off the field
registry rather than inline literals. It is the best model for what the ported charts should read
like.

#### What this changes about the plan

- **#7 should ship now**, ahead of Stage 3 — it is one line, it is live in production, and leaving it
  in place means the Stage 5 baselines are being compared against a rendering the dashboard never
  actually produces.
- **#9 is not a mechanical fix.** "What does a 46- or 50-slot day look like?" is a product question.
  It should not be bundled into a refactor PR.
- **The admin viewer should be simplified, not reproduced (#17).** It lives at `/admin/observations`
  (admin sidebar → "Observations"; `page.tsx` redirects non-admins to `/dashboard`), so it is an
  internal ops view of the QStash queue seen by one person — see [[simon-is-sole-user]] reasoning.
  Building general legend + tooltip primitives into Stage 4 *solely* so this page keeps a
  pixel-identical Chart.js legend would be tail-wagging-dog: nothing else in the repo wants them, so
  they would be a generalisation with exactly one consumer.

  Instead: port it with a deliberately minimal legend (two static swatches — it has exactly two
  series, "observations" and "5-min agg") and either a simple hover readout or none. Its screenshot
  baseline is therefore **expected to change**, and that is fine — it is the one chart where "looks
  different" is an acceptable outcome rather than a regression.

  Knock-on: it is still the right **first** slice on low-stakes grounds, but it no longer "proves the
  primitives" — it exercises surface nothing else uses. `ProvenanceChart` is the better proof of the
  shared primitives, so treat *that* as the real first test of Stage 4's design.

### Stage 3 — Fix agreed defects, still on Chart.js

**Decisions taken 2026-08-01.** Everything below is signed off; baseline churn is expected and
reviewed deliberately. **Freeze the baseline at the end of this stage.**

#### 3a — #7, the global plugin — ✅ DONE 2026-08-01
`customYAxisPlugin` is now passed per-instance via the `plugins` prop on the heatmap's `<Chart>`,
instead of `ChartJS.register`.

**The gallery now deliberately side-effect-imports `HeatmapChart`.** The real dashboard loads every
chart module (`registry.tsx` statically imports all 20 card plugins), so a gallery importing only
`DashboardChart` was screenshotting something the dashboard never renders. Keeping the import makes
the baselines faithful *and* turns them into a permanent regression guard: globally register a
chart-specific plugin anywhere in that graph again and every lines/stacked baseline fails.

> **Prediction corrected.** This section previously said "expect the baselines to change — that
> change *is* the fix". Wrong. With the fix **and** the faithful import in place, all 34 baselines
> passed **unchanged**. The baselines were captured uncontaminated, so they already described the
> correct rendering; what was wrong was *production*, not the baseline. Nothing to re-approve.

#### 3b — #1/#2/#3/#5, the legend presence bug — ✅ DONE 2026-08-01
`batteryW` is now optional and `undefined`-when-absent in `LineChartData`, matching `grid`;
`buildLineDatasets` gates on an explicit `!= null` (not truthiness — an all-nulls array is truthy,
which was the whole bug); and `ChartTooltip` takes **`hasBattery`/`hasGrid` presence props separate
from the value props**, mirroring those same dataset gates. Legend and chart now list the same series
by construction. Dead `visible` prop dropped (#5).

Eight baselines changed, all four periods of the lines chart plus the two battery-less and the two
gap cases — and, informatively, the *focused-with-full-data* cases did **not** change, because that
was the one state the old code already got right.

Verified visually, not just by green ticks:
- `lines-m-no-battery-bars` — bars are now full-width and evenly spaced (the phantom dataset was
  stealing a grouped-bar slot), and **Grid appears in the legend with nothing hovered** (#1, #3).
- `lines-d-gap-focused` — crosshair inside the hole, **all five entries remain with blank values**
  where Battery and Grid previously vanished (#2).

##### 🛑 Harness bug found while verifying — worth knowing about
The gap fixtures were emitting `NaN`, not `null` (`holed(...) ?? NaN`, written only to satisfy
`LineChartData`'s `number[]`). `NaN !== null`, so the old value-gated legend still rendered its
entries and **defect #2 never actually reproduced in the harness** — `lines-d-gap-focused` passed
unchanged after the fix, which is what exposed it. Fixed to emit real nulls, which is also what
`buildChartData` genuinely produces. A screenshot suite can be green because the fixture is wrong;
this one nearly was.

#### 3c — #6/#16/#4, one palette — ✅ DONE 2026-08-01
Shipped as decided. `datasets.ts` has **no colour literals left**; the lines chart resolves Solar to
`solar.primary` (yellow-200), Battery to `battery.main` (green-400), Grid to `grid.main` (pink-500)
and SoC to `battery.soc`. `ChartTooltip` renders swatches from the same registry instead of naming
Tailwind classes, SoC is dashed via an exported `SOC_DASH` that the legend swatch draws with
literally (an SVG `strokeDasharray`, so the two cannot drift), and the second "Battery" row is now
"Battery SoC" (#4). The crosshair red moved to `CHART_COLORS.focusLine`, killing its third hardcoded
copy (#16).

Two registry entries were added, because two real quantities had no home in it:
- **`CHART_COLORS.load`** (blue-400) — total site load. Distinct from `restOfHouse`, which is the
  *remainder* after sub-metered loads. Blue was unused, so nothing collides.
- **`CHART_COLORS.focusLine`** (red-500) — not a series colour; it must stay legible against all of
  them. Note it was only *safe* to leave as red once the lines chart's Grid moved off red onto pink.

Verified on `colours-lines-vs-stacked-load`: pink now means Grid in **both** panels, and orange and
red no longer carry two different meanings across a synced-hover pair.

*(Original decision text follows.)* **`CHART_COLORS` wins.** The lines chart stops hardcoding RGB and resolves through it, so Solar
becomes yellow-200, Battery power green-400, Grid pink-500 — matching the stacked chart and Sankey,
and ending the collision where lines-Battery *was* the Hot Water colour.

Because battery power and battery SoC are drawn together on the lines chart and `CHART_COLORS`
gives both the same green, **SoC becomes a dashed line** (`borderDash`) and keeps green-400. Texture
carries the distinction, "battery is green" stays true, and it matches the existing `ProvenanceChart`
idiom for probe-like series. `ChartTooltip` takes its swatch colour as a prop from the same
resolution instead of naming a Tailwind class, and the crosshair red is centralised (#16).

Also fixes #4 — the two rows both labelled "Battery" become "Battery" and "Battery SoC", matching
the dataset labels.

#### 3d — #9, DST and day bucketing — ✅ DONE 2026-08-01
Bucketing moved to **`lib/heatmap-buckets.ts`** — pure, dependency-free, and unit-tested against
**both real 2026 Melbourne transitions** (fall-back 2026-04-05, spring-forward 2026-10-04). That
split was not tidiness: `HeatmapChart` is a client module pulling in Chart.js, so Jest cannot import
it and the heatmap still has no screenshot baseline, which would have left this change completely
unverified. 16 tests now assert that a fall-back day keeps all 48 distinct readings (nothing
overwritten) and a spring-forward day has real data at 02:00/02:30 rather than a fabricated gap.

`areas.day_offset_min` is now plumbed through: `AreaBlock` → `AreaDatum.area` → a new
**`dayOffsetOf(datum)`** helper. Deliberately a helper rather than a field on `AreaDatumSubject`:
the device leg has no day bucket, so supplying one meant `subjectOf` returning a *copy* of
`datum.device` — new identity every render. The props golden caught exactly that, which is what it
is for. The standalone `/device/…/heatmap` page passes the device's tz offset, the same fallback.

Labelling, per the agreed convention: columns are one frame for every row, and any row whose real
offset differed gets an **asterisk** plus a footnote naming the frame (`UTC+10:00`) and saying the
local clock read an hour later that day. The footnote only renders when some row is actually
off-frame, so it never becomes background noise.

> ✅ **Frame convention settled 2026-08-01 — and my first pass was wrong.** I originally used the
> FIXED offset as the frame, reasoning that labels must describe the buckets. Measured, that marks
> **30/30 rows in midsummer** — the asterisk fires on everything and stops meaning anything.
> Anchoring the frame to the **newest day's real offset** marks 0/30 in midsummer, 0/30 in midwinter
> and ~11/30 only when the window actually spans a transition, and it matches the brief literally.
>
> The trade is that day boundaries follow the display offset while DST is in effect. Acceptable
> *here specifically* because the heatmap never shows a daily total, so nothing in it is compared
> against `agg_1d` — do not carry that reasoning to a chart that does. `dayOffsetMin` is retained as
> the fallback when `display_timezone` is unusable. The measurement is now itself a test, so nobody
> reverts to the standard-time frame without seeing why.

*(Original decision text follows.)*
**Bucket by the fixed offset (`areas.day_offset_min`), not the DST-aware IANA zone.** Every day is
then exactly 48 slots, so the silent fall-back overwrite and the fabricated spring-forward gap both
*dissolve* rather than being special-cased — and the heatmap's day rows finally agree with the daily
aggregates, the Sankey and the daily stripe, which have always used the fixed offset
(`docs/architecture/data-model.md` → "Time: fixed-offset days").

The visible cost is that a daily routine shifts one hour on the chart across a DST boundary, because
relative to standard time it genuinely does. Handled in the labelling:

- **Time-of-day (x) labels are drawn in one frame: the most recent day's offset.**
- **Any day row whose actual local offset differs from that frame gets an asterisk** on its date
  label, with a short footnote under the chart explaining that those days were on a different offset
  and the times shown are in the current frame.

#### 3e — #10/#11, honest colour scaling — ✅ DONE 2026-08-01
Shipped as decided, and **extracted to `lib/heatmap-scale.ts` so it could be tested at all**. The
component is a client module pulling in Chart.js + `chartjs-chart-matrix`, so Jest cannot import it,
and the heatmap has no screenshot baseline yet — which left the arithmetic deciding every cell's
colour with no coverage of any kind while it was being changed. 16 unit tests now cover it, including
the 40.1–40.5 °C case that was capped at 0.4 of the palette, the all-equal case, a negative range,
and out-of-range clamping.

The `load*`/`source*` `/power` predicate was spelled out three times inline; it is now
`isBaselinePower()` and the magic `50` / `-1` are `POWER_BASELINE_W` / `BLACK_SENTINEL`.

*(Original decision text follows.)*
Normalise `(value - min) / (max - min)`, with an explicit `max === min` guard painting a single flat
colour rather than dividing by zero. Drops the `Math.max(…, 1)` floor that washed out every
narrow-range series, and makes the colour legend truthful for the first time. Verify against **both**
symptoms — washed-out cells and the over-claiming gradient.

Deliberately **not** doing per-metric fixed ranges (SoC always 0–100 etc.) here; noted as possible
follow-on.

#### 3f — housekeeping — ✅ DONE 2026-08-01
All `console.log` gone (the full-response dump and the per-series log inside the `find` predicate
included); `formatTimeAEST` went with them as its only use was a log line. `parseInterval` now
returns `null` for an unrecognised interval and the caller turns that into the ordinary "no data"
error path — previously it returned `0`, every reading mapped to the same instant, and the heatmap
silently collapsed to a single column looking like a data problem rather than a parsing one. Four
`||` → `??`.

*(Original text follows.)*
#8 (strip the `console.log`s, including the full-response dump and the per-series log inside a `find`
predicate), #12 (`parseInterval` must surface an unrecognised interval instead of returning 0 and
silently collapsing the grid), #13 (`||` → `??`).

**Not fixed:** #14 (duplicate tooltip-hiding logic) — deleted wholesale by Stage 5, so fixing it
first is wasted work. #15 (the `now` → `windowEnd` rename) rides along with Stage 4.

### Stage 4 — Shared d3 primitives

#### Decisions taken 2026-08-01 (before any primitive was written)

**The zero-pixel-diff rule cannot survive the port, and this doc was wrong to promise it.** Canvas
and SVG rasterise differently — text hinting/antialiasing, line joins, fractional coordinates — so a
*correct* port still moves thousands of pixels. Every Stage 5 slice would have failed a
`maxDiffPixelRatio: 0.0002` gate for reasons unrelated to correctness.

Settled instead:

1. **The pixel gate loosens to 2–3%** and stays the primary check, accepting it catches only gross
   breakage. ⚠️ **Loosen it in the first SVG port, not before** — there is no Chart.js work left, so
   holding the tight gate until it must change costs nothing and keeps full sensitivity until then.
2. **A targeted colour guard covers the gate's worst blind spot** — `lib/charts/__tests__/series-colours.test.ts`.
   A whole-series colour change was *measured* at 1,345 px (**0.39%**), which a 2–3% band sails past;
   defect #6 was exactly that and shipped for years. The guard asserts every series resolves to a
   `CHART_COLORS` value, and that Battery/SoC stay separated by the dash given they share a colour.
   Negative-controlled: a hardcoded literal, a repointed entry and a removed dash each turn it red.
3. **Shape: hooks + small presentational pieces**, not a chart framework. `useChartGeometry()` returns
   scales and the plot-area box; `<TimeAxis>`, `<ValueAxis>`, `<ShadingBands>`, `<FocusLine>` and
   `usePointerIndex` alongside; **each chart still owns its own `<svg>` and draws its own series**.
   The heatmap opts out entirely (categorical axes, no focus line), so the real consumer count is
   three — too few to know the right abstraction, and `SiteChartsCard` (1,017 lines of interaction)
   is exactly the sort of consumer that would end up fighting one. The shared layer computes
   *numbers*, which are unit-testable; a wrong number is a bug, a wrong component is a refactor.
4. **Tick selection matches the visible result, not the mechanism.** Same label text, formats and
   rough density per period, chosen by clean `d3-time` interval logic. `buildTimeScale`'s quirks —
   `autoSkip`, five spaces to defeat collision detection, a zero-width space to keep a gridline,
   multi-line label arrays, the 2→3→4 skip ladder — exist to work *around* Chart.js and have no
   equivalent under d3. Ticks may land on slightly different days at M scale; the loosened gate
   allows it. "Measure-to-fit tick density" is noted as possible follow-on, not done here.



**✅ #18 and #15 DONE 2026-08-01** — both landed ahead of the primitives, since the port would
otherwise inherit them.

- **#18** — `LineChartData` and `PaddedSOCData` now declare `(number | null)[]`, and the blanket
  `as ChartData` cast at the end of `buildChartData` is gone. I had deferred this fearing an
  unpredictable cascade; measured, it was **one** type error (`PaddedSOCData` carrying the same lie).
  Types only, zero behaviour change, all 34 baselines unchanged. The gallery's
  `as unknown as LineChartData` cast is deleted with it.
- **#15** — `buildTimeScale`/`buildShadingAnnotations`' `now` parameter, and `DashboardChart`'s `now`
  prop, are renamed `windowEnd` throughout. The name was actively misleading: `LinesChartCard` passes
  `ts[ts.length - 1]` — the last rendered timestamp — and `SiteChartsCard` the same. It is only the
  wall clock in the no-data fallback, which is now the one place still called `now`, with a comment
  saying why. Shading a historical window against the real clock would put the bands in the wrong
  place entirely.

Still to do in Stage 4: the primitives themselves.

#### ✅ Primitives DONE 2026-08-01 — `lib/charts/svg/`

A toolkit, not a chart component. 54 unit tests; proven on screen by four gallery cases before being
used anywhere.

| Module | What it owns |
|---|---|
| `geometry.ts` | `buildGeometry` (plot box + d3 scales), `niceDomain` (zero-anchored, keeps negative room, never degenerate) |
| `time-ticks.ts` | `buildTimeTicks`, `buildShadingBands` |
| `paths.ts` | `linePath`, `bandPath`, `stackedBands`, `definedSegments` |
| `hooks.ts` | `useContainerSize`, `usePointerIndex`, `nearestIndexForTime` |
| `axes.tsx` | `<TimeAxis>`, `<ValueAxis>`, `<ShadingBands>`, `<FocusLine>` |

Three decisions inside it worth knowing:

- **Gridlines and labels are separate.** A tick carries `label: string[] | null`; null means "gridline,
  no label". That distinction is precisely what forced the old zero-width-space and five-space hacks,
  and it is explicit here instead of encoded in whitespace.
- **A null breaks the whole stacked column.** `stackedBands` evaluates `defined` across every series
  at each x, so an outage in one series punches a hole through all the bands. Treating it as zero
  would slide every band above it downward and render a sensor dropout as a genuine trough. Pinned by
  a test that asserts the null and zero cases differ.
- **`usePointerIndex` deduplicates and is desktop-only on leave.** Both are carried from behaviour the
  Chart.js versions had to learn: `ProvenanceChart` documents an infinite render loop without the
  dedup, and clearing focus on leave fights tap-to-focus on touch.

`useContainerSize` generalises `DailyStripes`' `useContainerWidth`, but **`DailyStripes` was not
rewired** — it is not part of this migration and changing it would put an untested component in the
diff for no benefit. Fold it in when it is next touched.

**`PrimitivesDemo`** (`app/labs/chart-gallery/`) is the worked example to copy when porting: it uses
every piece deliberately rather than the minimum that would draw. Its `primitives-d-stack-gap`
baseline is the one to look at — the stacked bands break cleanly through the column at the hole,
which is the behaviour the hardest part of Stage 5 depends on.

> The harness needed one fix to accept it: the readiness poll waited for a `<canvas>`, which no SVG
> chart has. It now accepts a canvas **or** an svg with a non-zero box, which matters throughout
> Stage 5 when the suite covers a mix of both.

### Stage 5 — Migrate, one chart per PR

Acceptance rule from here on: **the screenshots must not change.** Any diff is a bug or a
regression and must be explained.

1. ✅ **`observations-viewer` — DONE 2026-08-01.** Extracted to
   `app/admin/observations/IngestionChart.tsx`; the viewer no longer imports Chart.js at all.

   Simplified as agreed (#17): two static legend swatches and a hover readout replace Chart.js's
   built-in legend and tooltip, rather than rebuilding either for one admin consumer.

   **Drawn as stacked step-after areas, not bars.** The source is 1,441 one-minute buckets; as bars
   across ~850 px that is 0.6 px each — 2,882 sub-pixel `<rect>`s that moiré and read worse than the
   canvas did. Two `<path>`s look like touching bars, and step-after is the honest curve: a
   per-minute count holds for its minute, so a slope would assert readings never taken. `stepAfter`
   was added to `linePath`/`stackedBands` for this and is reused by `ProvenanceChart`'s stepped
   series next.

   The port made it **props-driven**, so it now has baselines it could never have had before —
   `ingestion-24h` and `ingestion-outage`. The outage case is the one worth looking at: a flat-zero
   stretch, which is the question this chart exists to answer.

   ⚠️ The pixel gate is **still tight**. This chart had no prior baseline, so there is no canvas→SVG
   diff to absorb; loosening happens in the ProvenanceChart slice, where the noise floor can actually
   be measured against an existing baseline.
2. ✅ **`ProvenanceChart` — DONE 2026-08-01.** Rebuilt on the primitives: crosshair, recal bands,
   stepped series, honest gaps, dual axes, dedup'd hover. Verified against the canvas baselines by
   eye before re-baselining.

   Three things it surfaced, all of which would have shipped silently:

   - **The recal bands were nearly recoloured.** I had hardcoded the dashboard's 7 % white shading
     into the new chart; the real value is `RECAL_BAND_COLOR` — **amber at 15 %**. Those bands mean
     "the BMS recalibrated here", an event worth noticing, not background texture. The band type now
     carries an optional `fill` defaulting to the registry colour, and the panel passes plain
     `{xMin, xMax}` intervals instead of chartjs-plugin-annotation box specs.
   - **M was drawing twice the gridlines it should.** Measured off the baselines: Chart.js drew ~15
     for a 30-day window; the primitives drew all 31 daily ones. `buildTimeTicks` now drops
     unlabelled M ticks entirely → 8. **D is the opposite** and keeps its unlabelled gridlines,
     because the canvas genuinely draws them there (24 gridlines to 12 labels). So the
     "gridlines and labels are separate" model is right, but the *default* was wrong for M.
   - **The old axis violated the repo's own typography rule.** `axisTicks` emitted
     `${value} ${unit}` unconditionally, so the provenance axes read `100 %` and `3.5 $`.
     `number-typography.md` says `%` is tight. `ValueAxis` now derives the gap from `classifyUnit`
     rather than a caller-supplied boolean — one less thing to get wrong per call site — and renders
     it as a `<tspan dx>`, never a space character, as that doc requires.

#### 🛑 The pixel gate: measured, and the 2–3 % decision does not survive it

The canvas→SVG floor was **measured at 5–6 %** on this chart (10,256–12,352 px), against my estimate
of ~1–1.5 %. It stayed at 5–6 % *after* the gridline and unit fixes, so it is genuine distributed
rasterisation across dense lines and text in a short frame, not a residual difference.

That breaks the agreed gate, because two requirements are now incompatible:

- the tolerance must exceed **5–6 %** or a correct port fails, and
- a whole-series colour change measures **0.39 %**, so anything above ~1 % catches nothing.

There is no number that satisfies both. Tolerance-based comparison simply does not survive a renderer
change.

**Proceeding as: re-baseline at each port, keep the gate tight.** The before/after is reviewed by eye
during the port (which caught all three findings above), `series-colours.test.ts` covers the palette
blind spot, and the tight gate then protects everything *after* the port — which is where regressions
actually accumulate over time. ⚠️ This reverses the Q1b answer; it is reversed by a measurement that
contradicted the assumption behind it, not by preference. Say if you would rather widen the gate.
3. ✅ **`HeatmapChart` — DONE 2026-08-01.** 899 → 675 lines, and it deletes the three things that
   made it the worst of the four: `chartjs-chart-matrix`, the `#chartjs-tooltip` div appended to
   `document.body` (created, measured, placed and cleaned up by hand, and hidden again on refetch and
   unmount), and the `afterDraw` y-axis-label plugin that caused defect #7. The tooltip is now a
   positioned sibling; the day labels are ordinary `<text>` with a bold month `<tspan>`.

   Cells are 1,440 `<rect>`s with `shapeRendering="crispEdges"` — visibly sharper than the canvas,
   which softened every cell edge.

   Two bugs caught by looking at it:

   - **The rows came out upside-down.** `yLabels` is newest-first and I drew row 0 at the top;
     Chart.js's category y-axis puts index 0 at the *bottom*, so the grid reads oldest-at-top. Fixed
     with a `rowY()` flip rather than reversing the data, so tooltip and `offFrameDays` lookups stay
     index-aligned.
   - **🛑 `useContainerSize` never measured — a bug in the PRIMITIVE, not this chart.** The obvious
     `useRef` + `useLayoutEffect(…, [])` silently fails when the element attaches on a later render
     than the first, which is exactly what a chart with a loading spinner does: the effect runs
     against a null ref and never runs again. The heatmap rendered an empty box. `ProvenanceChart`
     has no loading state, which is the only reason it did not hit this. Now a **callback ref**, so
     the observer follows the element rather than the mount.
4. ✅ **`DashboardChart` — both variants, DONE 2026-08-01.** They live in one component, so `lines`
   and `stacked-areas` landed together. **No Chart.js importers remain outside `scaffold.ts`.**

   Two Chart.js-era props were dropped rather than carried:
   - `chartRef` — a `Chart` instance ref both cards created, passed, and never read.
   - `onHover(event, activeElements, chart)` → **`onHoverIndex(index | null)`**, since only
     `activeElements[0].index` was ever used. Same shape `ProvenanceChart` takes.

   Bar geometry reproduces Chart.js's `categoryPercentage`/`barPercentage` model and is kept **local**
   to this component — it is the only chart with bars, so lifting it into the primitives would be a
   shared abstraction with one consumer.

   One real difference caught by looking: the top gridline sat *below* the data, with the series
   running past the last labelled tick. `scale.ticks()` picks round numbers strictly inside the
   padded domain, so a series peaking at 9 in a 0–9.4 domain got a top tick of 5. `buildGeometry`
   now calls **`.nice()`**, which snaps the domain out to tick boundaries — what Chart.js did
   implicitly, and what puts the unit label at the top of the plot instead of adrift.

### Stage 6 — Remove Chart.js — ✅ DONE 2026-08-01

All five packages dropped from `package.json` **and** from `packages/usher/package.json` (declared
there, never imported). `lib/charts/scaffold.ts` is deleted: `registerChartScaffold`,
`buildTimeScale` and `buildShadingAnnotations` were Chart.js config with nothing left to configure.
Its two survivors moved to `lib/charts/temporal.ts` — `ChartTimeRange`, which is the *period*
vocabulary the navigator and query layer speak rather than anything to do with drawing, and
`formatHoverTimestamp`. `d3-array` and `d3-shape`, declared-but-unimported since before this work,
are now genuinely used by `paths.ts`.

#### Bundle: measured, and better than estimated

| | Stage 0 | Now | Δ |
|---|---|---|---|
| Chart.js family (gzip) | **87.0 kB** | **0** | −87.0 kB |
| d3 family (gzip) | 22.6 kB | 30.7 kB | +8.1 kB (`d3-shape` now used) |
| **Net dependency weight** | | | **−78.9 kB gzip** |
| `/dashboard/[...slug]` First Load JS | 446 kB | **363 kB** | **−83 kB** |
| `/device/[...slug]` First Load JS | 534 kB | **451 kB** | **−83 kB** |

Ahead of the 60–75 kB estimate. Chart.js was the largest non-framework dependency in the client
bundle and no longer appears in the top eight at all; that slot is now `lucide-react` at 29.6 kB.

Two things that were not the stated goal and turned out to matter as much:

- **The screenshot suite runs about twice as fast** (~1.8 min → ~42 s). SVG renders quicker than
  canvas, and every future run of the harness pays less.
- **`HeatmapChart` lost 224 lines** (899 → 675) while gaining the DST fix, honest colour scaling and
  a real tooltip — the library was costing more than it provided there.

---

## Where this leaves things

**Done.** Every chart in the app renders SVG via `lib/charts/svg`. 18 defects found, 16 fixed, one
deliberately deferred (#14, deleted by the port anyway) and one carried by design (#17, the admin
chart was simplified rather than reproduced).

**Not done, deliberately:**

- **`EnergyFlowSankey`'s imperative idiom** (1,581 lines). It is already d3, so converting removes no
  library — but the harness that makes it verifiable now exists, which was the blocker. This is the
  natural next project.
- **`DailyStripes` still has its own `useContainerWidth`.** `useContainerSize` generalises it; fold
  it in when that file is next touched. Note it would have been immune to the callback-ref bug either
  way, since it has no loading state.
- **Measure-to-fit tick density.** The 2→3→4 skip ladder is carried over as a heuristic; computing
  how many labels actually fit from measured text width would be better.
- **Per-metric fixed heatmap ranges** (SoC always 0–100 rather than min-observed–max-observed).

**The standing rule for anyone touching these charts:** the pixel gate is tight, and it is tight
*because* every port re-baselined deliberately. If a baseline moves, that is a finding — explain it
before updating it. Three of this project's real bugs were caught exactly that way, and one of them
(a fixture emitting `NaN` instead of `null`) was a case of the suite passing for the wrong reason.

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
