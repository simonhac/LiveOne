# Colour Tokens — colour is meaning, not hue

> **Status:** current — introduced 2026-09-20. Migration in progress; see "Where we are" below.

Every colour on the dashboard is reached for by **what it means**, not by which hue it happens to
be: `text-ink-muted`, never `text-gray-400`; `bg-surface`, never `bg-[#1C1C1E]`.

Source of truth for the _what_: the `@theme` block at the top of `app/globals.css`. This document
holds the _why_. Same split as [chart-style.md](chart-style.md) ↔ `lib/charts/style.ts`, and for the
same reason: a rule that lives only in prose gets re-typed slightly differently at every call site.

## Why

Two reasons, one of which is a bug we shipped for months.

**1. A hue is not a decision.** `text-gray-400` appeared 324 times across this repo and meant at
least four different things — muted body text, a chart tick label, a disabled control, a unit
suffix. Nothing recorded which, so "make secondary text a little brighter" had no safe
find-and-replace, and a new component's author picked whichever grey looked close.

**2. Tailwind v4's palette is `oklch`, and ours was sRGB.** `--color-green-400` in
`node_modules/tailwindcss/theme.css` is `oklch(79.2% 0.209 151.711)` — deliberately more vivid on a
wide-gamut display than the `#4ADE80` everyone remembers. `lib/chart-colors.ts` meanwhile says
`battery.main = "rgb(74, 222, 128)"`, because an SVG stroke cannot be a utility class. So a battery
tile's hero number and the ring drawn directly beneath it were **two different greens on every Mac
and iPhone**, and had been since the v4 upgrade.

`lib/__tests__/role-chrome.test.ts` exists precisely to catch that class of drift — it was written
after Solar's icon quietly sat on `yellow-400` while the solar series was `yellow-200`. It could not
see this one, because its `class -> rgb` lookup table was a hand-copied Tailwind **v3** table: it
compared a stale table against itself and passed.

The token layer fixes both. `--color-series-battery` is defined AS `rgb(74, 222, 128)`, the class
and the stroke are one value, and the test now reads `app/globals.css` instead of a table.

## The rules

1. **A token per meaning, not per hue.** Where one paint serves two meanings, that is two tokens
   with the same value — `--color-series-ev` and `--color-danger-solid` are both red-600, and that
   is the point: either can move without dragging the other. Conversely, do not mint a token per
   call site. ~40 tokens covers the dashboard.

2. **🛑 Alias values are copied from `node_modules/tailwindcss/theme.css`, never from memory.** See
   reason 2 above. The Tailwind key each value came from goes in a comment beside it, and
   `lib/__tests__/colour-tokens.test.ts` re-reads `theme.css` on every run — so a Tailwind upgrade
   that retunes the palette fails the build instead of silently re-toning the dashboard.

3. **Name the tone, don't spell the alpha.** `text-tile-ink-muted`, not `text-ink/55`. `/55` is
   exactly the magic number this layer exists to delete, and a named tone is the only form that can
   be re-toned in one line. Keep `/NN` for a genuinely one-off decorative wash with no nameable
   meaning. **Never stack `/NN` on a token that already carries alpha** — the two compound.

4. **Rename, never re-tone — with one narrow exception.** When two files spell ONE meaning two
   ways and the gap is a few percent of alpha or a single palette step, unify them on one token and
   say so in the commit: that *is* the job, and leaving both spellings mints a token that
   memorialises an accident. When an odd tone belongs to a surface that is scheduled to disappear
   (a card that has not moved onto `TileSurface` yet), leave it literal and annotate it. Everything
   else is a rename. **Especially in a shared file** — The dashboard's components are almost
   all shared with `/device/*` (see below). A pass that only renames is safe everywhere by
   construction. A pass that changes a value is a decision about every page that renders it, and
   must be its own commit, called out in the PR.

5. **Identity, state and brand are three things.** The likeliest way to make this layer *worse*
   than literals is to encode a lie:
   - a battery value is `text-series-battery` because it is the battery — not `text-ok`;
   - Amber's cards are `brand-amber` because that is the retailer — not `warn`;
   - `text-ok` / `text-danger` are for status, where green really does mean "fine".

   For every non-grey you convert, ask: **identity, state, or brand?**

## The vocabulary

| Group | Tokens |
| --- | --- |
| Canvas & surface | `canvas` `surface` `surface-raised` `surface-sunken` `surface-panel` `surface-overlay` `surface-control` `surface-control-hover` `scrim` `wash` `rail` |
| Ink (chrome ramp) | `ink` `ink-strong` `ink-secondary` `ink-muted` `ink-faint` `ink-disabled` `ink-inverse` |
| Ink (tile ramp) | `tile-ink-dim` `tile-ink-muted` `tile-ink-idle` |
| Line | `line` `line-strong` `line-soft` `line-hairline` `line-faint` |
| State | `danger` `danger-solid` `danger-solid-hover` `danger-line` `danger-wash` `warn` `warn-line` `warn-wash` `ok` |
| Interactive | `accent` `accent-hover` `accent-ink` `focus` |
| Series | `series-solar` `series-load` `series-hot-water` `series-battery` `series-grid` `series-pool` `series-hvac` `series-ev` |
| Brand | `brand-amber` |

### Picking between two that look alike

| You want… | On a tile | Anywhere else |
| --- | --- | --- |
| primary text | `ink` | `ink` |
| secondary text | `tile-ink-muted` | `ink-secondary` |
| a quieter step still | `tile-ink-idle` | `ink-muted` |

**That split is debt, not design.** Tiles grew a white-alpha ramp (`white/55` over the `#1C1C1E`
slab) while everything else uses greys (`gray-300` over `gray-900`). They are two colours doing one
job. Unifying them is a design decision and is deliberately NOT part of the token sweep — the
`tile-` prefix is there to keep the duplication visible until someone makes that call.

## 🛑 "The dashboard" is not a boundary you can scope to

`components/DeviceViewer.tsx` imports `DashboardV4View`, so the whole node renderer, the registry,
every tile and every card body is shared with `/device/*`. `components/ui/**`, `ErrorPanel`,
`ServerErrorModal`, `DashboardsMenu`, `EnergyFlowSankey` and `components/area-builder/**` reach
further again — `/areas`, `/admin`, `app/test-sankey`, `app/labs/*`, and the global `app/error.tsx`.

There is no wrapper to gate on, and forking a primitive into a dashboard variant would leave two
divergent copies forever. Rule 4 is what makes this a non-problem: **if a token equals the literal
it replaces, the shared pages are byte-identical**, so there is no second decision to make. Any
place the rename is not pure is a place `/device/*` and `/admin` change too.

Admin-only files (device settings, the poll modals) keep their raw Tailwind for now. They are out of
scope, and they render identically either way.

## Verifying a change

The rename is provable, not eyeballed:

- `lib/__tests__/colour-tokens.test.ts` — every aliased token vs Tailwind's own `theme.css`, and
  the non-aliased ones pinned literally.
- 🛑 **A utility that never generated is the failure mode to check for**, because it fails
  *silently*: the class is simply absent from the built CSS and the element loses that colour
  rather than erroring. Grep the build output for each one — and match `(?:\.|\\:)<name>`, not
  `\.<name>`, or every variant-only utility (`hover:bg-accent-hover` →
  `.hover\:bg-accent-hover:hover`) reads as missing when it is fine.
- `lib/__tests__/role-chrome.test.ts` — every role class resolves, through the shipped CSS, to the
  exact `CHART_COLORS` value its SVG uses.
- `e2e/charts.spec.ts` — ~40 chart cases at two widths, zero-diff rule.
- A **computed-colour census** is the portable proof, and catches what screenshots miss: walk the
  DOM of `/labs/card-gallery` and record `getComputedStyle`'s `color` / `backgroundColor` /
  `borderColor` / `fill` / `stroke` per element, before and after. Computed values are resolved
  absolutes, so `oklch`, `rgb` and `color-mix` all normalise and a pure rename diffs to nothing.
  🛑 That gallery's dev bundle is ~10 MB — give it several seconds to hydrate before reading the
  DOM, or you will census an empty page and conclude the render broke.

An unused token costs nothing: Tailwind only emits a utility for a token it sees referenced in the
scanned source. A `text-ok` that nothing uses simply does not exist in the built CSS.

## Where we are

**The dashboard is done.** Every file it renders — `components/ui/**`, `components/dashboard/**`,
the twelve card bodies, the charts, Sankey and tables, the chrome and every dialog,
`components/area-builder/**`, `app/dashboard/**`, and the style-token modules — carries no raw
palette class, bar the handful listed below that say why in place.

Out of scope and still on literals: the admin and device-only screens (`app/admin/**`, the device
settings and poll modals, `DeviceViewer` and its chrome). They render identically either way,
because every token equals the literal it replaced.

## Deliberately left literal

Not every colour should become a token, and these say so where they sit rather than silently:

- **`LoadProvenanceCard`'s and `DeviceMetricsCard`'s own surfaces** — `gray-800/50`, `gray-800/40`,
  `gray-700/60`. Both cards predate [tile-style.md](tile-style.md) and carry a fill and hairlines a
  step off every other card's. Minting a token per accident is how a vocabulary stops being
  navigable, and re-toning them is a decision rather than a rename. They go when those cards move
  onto `TileSurface`.
- **`LoadProvenanceCard`'s cyan car icon** — cyan is the POOL series and this is the EV card, so
  `series-pool` would encode a lie and `series-ev` is a re-tone. Left visible.
- **`AmberNow`'s light panel** (`bg-slate-200`) — the one light-on-dark surface in the app.
- **Two `?debug` badges** (`bg-red-500`) — dev-only affordances, not a `danger` state.

Each is a *question*, not an oversight, which is why none of them is quietly mapped to the nearest
token.

## Deliberate re-tones

Under rule 4's exception. Each was one meaning with two spellings; leaving both would have minted a
token that memorialises an accident.

| Was | Now | Where |
| --- | --- | --- |
| `black/60` | `ink-inverse-muted` (0.55) | `LinkTooltip` — `NodeTooltip` already said 0.55, and they are the same object at two scales |
| `border-white/20` | `line-hairline` (0.25) | `HeatmapChart`'s legend swatch |
| `bg-gray-800/30` | `skeleton-quiet` (gray-700/30) | `SiteChartsCard`'s skeleton |
| `text-blue-400` | `accent-ink` (blue-500) | links and ticks — and blue-400 IS `series-load`, so leaving it risked reading as a series colour |
| `gray-900/60` · `/40` | `surface-panel-strong` (0.7) · `surface-panel` (0.3) | `ShareLinksPanel` spelled four depths of one recess |
| `red-950/40` | `danger-panel` (red-950/30) | a delete control's hover, beside a notice already at 0.3 |
| `gray-700/60` · `gray-800` | `line-soft` (gray-700/70) · `line` | dividers and borders a step off their neighbours |
| `ring-gray-700/80` | `ring-line` | one ring, one spelling |
| `amber-400/90` · `/80` · `amber-200/70` | `warn` · `warn-ink` | a softened warning is still a warning |
| `red-400/90` · `red-500` | `danger` | ditto |
| `green-500` · `/90` | `ok` | ditto |
| `yellow-500` | `warn` | `ServerErrorModal`'s warning triangle |
| `accent-green-600` · `accent-amber-500` | `accent-ok` · `accent-warn` | a range input's native tint |

None is larger than one palette step or a few percent of alpha, and all are inside the dashboard —
nothing that only the admin screens render was re-toned.
