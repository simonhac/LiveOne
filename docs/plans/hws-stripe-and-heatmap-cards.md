# HWS daily-stripe & selectable-series heatmap → v4 cards

> **Status: PLANNED — execute at/after config-v4 Phase 9 (post-cutover, v4-native).** Decision by
> Simon, 2026-07-24. This is a deferred work item for the config-v4 epic
> ([config-v4-execution-plan.md](config-v4-execution-plan.md)); nothing is built until the plugins go
> v4-native in Phase 9. Two extractions (see "Component extractions") are safe to pre-land anytime.

## Context

Two UI surfaces predate config-v4 and sit outside the dashboard descriptor system:

1. **HWS 7-day temperature stripe timeline** — `/labs/kinkora-hws`
   (`app/labs/kinkora-hws/{page,Timeline}.tsx`); a hand-drawn SVG, one stripe row per day (power
   on/off strip over a 30–40 °C gradient strip), hardcoded to `simon`/`kinkora` + `load.hws`,
   direct-DB read. Reachable only by direct URL.
2. **Selectable-series heatmap** — `/device/{id}/heatmap` (`components/HeatmapClient.tsx` +
   `HeatmapChart.tsx`); Chart.js `matrix`, 30d × 48 half-hour slots, with a dynamic point selector +
   palette selector. Already generic on `systemId` + point. Reachable only by direct URL.

Neither is a card, so neither can be dropped into an area. Both should become **v4 card plugins** so
they can be placed in any area/device (a `card` node inherits scope from its ancestor envelope
`area`/`device`; scope refs never live in `config`, §8.3).

## Why Phase 9 (not now, and not Phases 6–8)

The config-v4 epic is entering Phase 6 (write surface) → 7 (rehearsal) → 8 (cutover) → **9 (plugins
go v4-native: the two registries merge into one `CARD_RENDERERS` keyed by `CardType`,
`TILE_CATALOG`+`CARD_CATALOG`→`NODE_CATALOG`, and the `CardV3`/`synthCardV3` adapter is deleted)**.

Building these cards in today's v3 idiom would mean:

- Building against the `CardV3` carrier + `synthCardV3` adapter that Phase 9 deletes
  (build-then-migrate).
- Patching the cutover rewriter: `lib/dashboard/v3-to-v4.ts` `rewriteCard` forwards config
  **per-type** (only `chart`/`device-metrics`/tiles `features`), so a v3-placed new card would have
  its config **silently dropped at cutover** unless we also edit that Phase-5 cutover-critical code
  and extend the Phase-7 rehearsal fixtures ("every prod dashboard shape").

Building v4-native at Phase 9 avoids all of that: config lives directly on `node.config`, the plugin
reads it, and post-cutover cards never touch the rewriter or rehearsal fixtures. Slotting the work
into Phases 6–8 is the worst option — it pays the Phase-9 migration anyway *and* adds surface to the
cutover being rehearsed.

## Prerequisite (Phase 9 landing state this plan assumes)

- One unified `CARD_RENDERERS` keyed by `CardType` (the merged
  `components/dashboard/cards/registry.tsx` + `tiles/registry.tsx`), rendered by the recursive
  `<NodeView>` (`components/dashboard/v4/node-view.tsx`).
- One `NODE_CATALOG` (merged `lib/capabilities/catalog.ts`).
- `V4_CARD_TYPES` + `CARD_CONFIG_SCHEMAS` (`lib/dashboard/card-types.ts`) as the card vocabulary +
  strict per-type config validation.
- The v3 `DashboardCardType`/`CardV3`/`synthCardV3`/`v3-to-v4.ts` adapter is retired. Scope resolves
  via the v4 shell/`NodeContext` (area/device → handle/systemId); the permanent `?systemId=` serving
  alias (`legacy_handles`) keeps `/api/history` + `/api/system/{id}/points` addressable by handle.

If Phase 9 has not yet unified the registries when this is picked up, either wait or apply the same
edits in whatever the current (possibly still-dual) shape is — but the intent is the v4-native
single-registry idiom below.

## Shared wiring (v4-native — per card)

1. **`lib/dashboard/card-types.ts`** — add the type string to `V4_CARD_TYPES`; add a strict zod
   config schema; register it in `CARD_CONFIG_SCHEMAS`. Config = render options only, **no scope
   refs** (§8.3). Do not import `lib/heatmap-colors.ts` here (pulls `d3-scale-chromatic` into a
   server-safe module) — inline palette literals with a keep-in-sync comment.
2. **Unified `CARD_RENDERERS`** — implement the plugin (reads `node.config` directly; gets
   `systemId`/timezone from the resolved `NodeContext`) and register it. The
   `satisfies Record<CardType, …>` makes registration a compile gate.
3. **`NODE_CATALOG`** — add an entry (`label`, `scope`, `requires`) for the Add-Card gallery +
   default strategy (not render authority; plugins keep their own data gates).

No `CardV3`, no `synthCardV3`, no `rewriteCard` edit (post-cutover cards never hit the v3→v4
rewriter).

## Card A — generic `daily-stripe`

Generalizes the HWS timeline into a reusable "any point as daily gradient stripes" card; reproduces
the exact HWS view via config.

**New files:**

- **`components/dashboard/DailyStripes.tsx`** (`"use client"`) — the SVG from `Timeline.tsx`,
  generalized off `HwsModelStep`. Props: `values: Map<intervalEndMs, number|null>`, optional
  `state: Map<…>`, `tz` (offset min), `firstDayMidnightMs`, `dayCount`, `slotMs`/`slotsPerDay`,
  resolved `domain:[min,max]`, `palette:[from,to]`, `onThreshold`, `unit?`, `label?`. Color scale
  built per-render from `domain`+`palette` (replaces the hardcoded `faucetScale`). **No `state` ⇒
  collapse the thin strip (`POWER_H=0`)** to a single full-height gradient row per day; with `state`,
  keep the two-row layout. Reuse the 5-min-slot day-bucketing (every real tz offset is a 5-min
  multiple, so keys align to local midnight).
- **Card plugin** (in the unified `CARD_RENDERERS`) — `systemId` + `tz` from the resolved
  `NodeContext`/`useAreaDatum`; fixed-offset local-day window (`days`, capped 7 by the 5m
  `/api/history` window); fetch `interval:"5m"`, `series` = primary (+ optional state) logical-paths
  with agg suffix per metric via `getPreferredAggregationForMetricType`; parse OpenNEM → maps
  (`intervalEndMs = firstIntervalMs + i*intervalMs`); resolve color domain from config or from
  non-null values (fallback `[0,1]`); `ChartSkeleton` while loading, else `<DailyStripes/>`. No
  `collapseKey`.

**Config schema:** `{ primary:{logicalPath, agg?}, state?:{logicalPath, agg?, onThreshold=0}, days=7
(1–7), color?:{min?,max?,from,to}, unit?, label? }`. **Reproduces HWS** via
`primary=load.hws/temperature`, `state=load.hws/power` (`onThreshold=100`), `color.min=30,max=40`,
`days=7`.

**Catalog:** `scope:"area"`, permissive `requires` (a generic card maps to no single capability).
Leave `app/labs/kinkora-hws/*` untouched (accept minor SVG duplication; the lab keeps its HWS-model
carry-forward, which the generic card deliberately drops — gaps show background, no carry-forward).
>7-day horizons = a later `interval:"30m"` switch (the `slotMs`/`slotsPerDay` props already make it
one line).

## Card B — `heatmap` (selector by default + optional pin)

Ports the existing heatmap as a device-scoped card; reuses `HeatmapChart` untouched.

**New/changed files:**

- **`components/heatmap/HeatmapPanel.tsx`** (new) — extract the selector/palette/points-fetch logic
  out of `HeatmapClient` into a URL-free, card-local-state component. Props: `systemId`, `timezone`,
  `pinnedSeries?`, `pinnedPalette?`, `showDebug=false`, `enableKeyboardNav=false`, plus optional
  `initial*`/`on*Change` hooks so the standalone page can still seed/persist via URL. Hides the point
  `<Select>` when `pinnedSeries` set / palette `<Select>` when `pinnedPalette` set; both pinned ⇒
  chart-only. Mounts `HeatmapChart` unchanged.
- **`components/HeatmapClient.tsx`** (slim down) — keep the page chrome + `?point=`/`?palette=` URL
  glue, render `<HeatmapPanel showDebug enableKeyboardNav …/>`. Standalone `/device/{id}/heatmap`
  behavior unchanged.
- **Card plugin** (in the unified `CARD_RENDERERS`) — `systemId` from the resolved device/area
  `NodeContext`; `timezone` from `useAreaDatum`; render `<HeatmapPanel pinnedSeries={config.series}
  pinnedPalette={config.palette}/>` (debug + keyboard-nav off in card mode). Self-managed pending.

**Config schema:** `{ series?: logicalPath, palette?: enum }`. **Catalog:** `scope:"device"`,
minimal `requires` (any device with numeric time-series points).

**Edge cases:** no points ⇒ card-sized "No points" state; **pinned series missing** ⇒ un-hide the
selector + a "pinned series unavailable" note (don't feed an unknown path to the chart); multiple
heatmap cards don't collide (card-local state, no URL writes); not slotted into the fixture-driven
`app/labs/card-gallery/` (needs a live `systemId`).

## Component extractions (safe to pre-land before Phase 9)

The two extractions are pure presentation, idiom-independent, and touch no config-v4 surface — they
can land anytime as a head start, making the eventual card a thin wrapper:

- `DailyStripes.tsx` out of `app/labs/kinkora-hws/Timeline.tsx` (re-point the lab page at it).
- `HeatmapPanel.tsx` out of `components/HeatmapClient.tsx` (re-point the standalone page at it).

## Verification

- `npm run build:local && npm run typecheck` — the `satisfies Record<CardType, …>` (registry) and the
  catalog `Record` turn missing wiring into a compile error (per CLAUDE.md; not `npm run build`, dev
  server stays up).
- **daily-stripe**: place a `daily-stripe` card configured for `load.hws` on Kinkora into a v4 doc;
  render via the v4 path; confirm it reproduces the lab timeline. Confirm the no-`state` variant
  renders a single-row-per-day gradient for a plain point (e.g. `source.solar/power`). Confirm
  graceful gaps + domain fallback.
- **heatmap**: mount the card bound to a system with points; confirm the selector enumerates the
  system's points and the chart matches the standalone page; confirm a pinned `series`/`palette`
  hides the controls and a stale pin falls back to the selector; confirm the slimmed standalone page
  still behaves identically.
- Add unit coverage for the two new zod config schemas via the v4 validator, and a render/scope test
  for each card under `<NodeView>`.

## Out of scope / follow-ups

- Not part of the Phase 6–8 critical path; this is a Phase-9 (post-cutover, v4-native) work item.
- Retire `/labs/kinkora-hws` later if desired once the daily-stripe card is proven.
- Add-Card gallery UX polish for these two cards (catalog entries are ready; interactive gallery is
  separate).
