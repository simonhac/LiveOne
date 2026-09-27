# Colour Tokens — colour is meaning, not hue

> **Status:** current — introduced 2026-09-20. The dashboard is converted and gated; what remains
> on literals is the admin and device-only screens, out of scope by design. See "Where we are".

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
| Canvas & surface | `canvas` `surface` `surface-raised` `surface-sunken` `surface-panel` `surface-overlay` `surface-control` `surface-control-hover` `row-hover` `scrim` `wash` `rail` |
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
- **`npm run test:e2e:census`** — `e2e/cards.spec.ts`, the computed-colour census over
  `/labs/card-gallery`. This is the portable proof, and catches what screenshots miss. Regenerate a
  baseline with `npm run test:e2e:census:update` and read the diff.

  It asserts **two different things**, and both are needed. **(A) every colour is a known value** —
  a `--color-*` token or a listed literal. That is the claim this document actually makes, it is
  immune to element-count drift, and it is the only check that sees an **inline `style`**, which the
  `prebuild` gate structurally cannot. **(B) the set of `(property, colour)` pairs equals the
  committed baseline** — the receipt for "my change was a pure rename". A alone passes a re-tone
  from one legal token to another; B alone cannot tell "changed" from "changed correctly".

  🛑 **Alpha is recovered with two backdrops, not one.** Compositing a colour onto a 1×1 canvas
  PREMULTIPLIES it, so `rgba(255,255,255,0.55)` reads back as an opaque mid-grey and collides with a
  genuinely opaque tone — destroying the distinction between `tile-ink-muted` and a solid colour.
  Painting over black and over white and solving (`a = 1 − (white − black) / 255`) is what keeps the
  ramp visible. Verified both ways: `color-mix(in oklab, #fff 55%, transparent)` and
  `rgb(255 255 255 / 0.55)` compute to *different strings* and normalise identically, while
  Tailwind's `oklch(70.7% 0.022 261.325)` and the v3 `rgb(156,163,175)` stay apart — so the census
  can still see the drift this whole layer exists for.

  🛑 Read the **four border longhands**, never `borderColor`: it is a shorthand that computes to
  `""` whenever the sides differ, so an asymmetric border vanishes from the record silently.

  Counts are recorded but **not** asserted (they follow render races); `elementCount` is asserted as
  a tripwire. The gallery's readiness gate (`data-gallery-ready`, a `useIsFetching` latch) is what
  makes that stable — measured at 10/10 identical on the generator section, which is where the
  drift used to be.

  **Blind spots, stated rather than discovered later:** `DeviceMetricsCard` has no gallery section;
  the resizable playground is not censused (its size is user state behind a `ResizeObserver`).

An unused token costs nothing: Tailwind only emits a utility for a token it sees referenced in the
scanned source. A `text-ok` that nothing uses simply does not exist in the built CSS.

## Where we are

**The dashboard is done.** Every file it renders — `components/ui/**`, `components/dashboard/**`,
the twelve card bodies, the charts, Sankey and tables, the chrome and every dialog,
`components/area-builder/**`, `app/dashboard/**`, the style-token modules, and the point-format
modules (`lib/point/unit-typography.ts`, `lib/point/format-value.tsx`) — carries no raw palette
class, bar the handful listed below that say why in place.

🛑 **`lib/point/format-value.tsx` is the reason the gate grew a reachability check.** It renders its
own `<span>` for the json/location metric, and `ChartTooltip`, `EnergyTable` and
`dashboard/DailyStripes` all import it — so the dashboard shipped a `text-gray-400` for as long as
the file sat outside `SCOPE`, with the gate reporting green the whole time. A hand-maintained
allow-list cannot see a literal one import away from the thing it is guarding; see "The gate".

Out of scope and still on literals: the admin and device-only screens (`app/admin/**`, the device
settings and poll modals, `DeviceViewer` and its chrome). They render identically either way,
because every token equals the literal it replaced.

## The gate

`npm run check:colours` (`scripts/check-colour-tokens.mjs`), wired into `prebuild` and
`prebuild:local` beside its sibling boundary guards. It fails the build on any raw palette class in
a scoped path.

🛑 **Why a gate rather than code review.** A reintroduced `text-gray-400` still *renders* — `@theme`
adds to the default palette rather than replacing it, which is exactly what let the sweep land file
by file. So a literal ships silently and the vocabulary decays one dialog at a time back to the 728
it started from. The gate is the only thing that makes "done" a stable state rather than a
high-water mark.

It checks three things, and each of the last two earned its keep by finding something on first run:

1. a **palette class** — `text-gray-400`, `bg-black/50`;
2. a **hard-coded colour in an arbitrary value** — `bg-[#1C1C1E]`. Three surfaces were still
   hard-coded (the skeleton, the stale badge, Amber's panel) and no palette-class grep could ever
   have seen them;
3. 🛑 **reachability** — a literal in a file the scoped set *imports* but does not itself scope.

**Why (3) exists.** `lib/point/format-value.tsx` renders its own `<span className="text-xs
text-gray-400">` for the json/location metric, and `ChartTooltip`, `EnergyTable` and
`dashboard/DailyStripes` all import it. Because the file was not itself listed, the gate reported a
clean dashboard over a raw palette class for the entire life of the token layer. **An allow-list
cannot see a literal one import away from the thing it is guarding** — so the guard now follows
`import`, `export … from`, `export * from` and dynamic `import()` out of `SCOPE` and asserts that
everything it reaches is either scoped or clean. Measured: ~261 files reached, 93 ms.

It does **not** replace `SCOPE` with that closure, on purpose. 255 of those files are pure server
modules (`lib/db`, `lib/kv`, `lib/readings`); calling them "files the dashboard renders" would turn
this vocabulary into noise, and a computed scope would make the frontier implicit — one new
`import` in an unrelated module silently conscripting a subtree, and a PR that touched nothing
visual failing on a file it never opened. `SCOPE` growing by hand **is** the ratchet; the closure's
job is to name the line you must add, not to add it behind your back.

🛑 **What it still cannot see: an inline `style`, or a gradient.** All three checks match CLASSES,
so `style={{ color: "rgb(0,0,0)" }}` and `radial-gradient(..., rgb(255,198,36) ...)` are both
invisible to the gate. `AmberNow`'s price circle carries the first; `lib/amber-utils.ts`'s five
price-level gradients are the second, and the census found all five on its first real run. They are
legitimate — a gradient stop cannot be a utility class — but nothing stops a NEW one being wrong.

That hole is why the census is not optional: it reads computed style, so it sees both. Proven by
putting `style={{ color: "rgb(1,2,3)" }}` in a card body — `check:colours` reported the dashboard
clean, and the census named the element.

`SCOPE` is therefore still an allow-list, so the admin screens stay out. `EXEMPTIONS` is the list
below, and `scripts/__tests__/check-colour-tokens.test.ts` § "the exemption list" holds it: the
count may only fall, every entry is re-derived from its file (so a stale one fails the build), each
file must be in `SCOPE`, and the "Deliberately left literal" section below is checked to name
exactly those files and no others. None of that existed until 2026-09-21 — the rule lived only in a
comment, which is to say it did not live anywhere.

## Deliberately left literal

Not every colour should become a token, and these say so where they sit rather than silently:

One entry. It is a *question*, not an oversight, which is why it is not quietly mapped to the
nearest token:

- **The `?debug` size badge** (`bg-red-500`) — a dev-only affordance, not a `danger` state. It was
  two entries until `AmberSmallCard` and `TeslaSmallCard` were found to be carrying verbatim copies
  of the same badge, URL check and `ResizeObserver`; it now lives once, in
  `components/ui/debug-size-badge.tsx`. A `--color-debug` would put "this colour means nothing" into
  a vocabulary premised on every colour meaning something, and would invite reaching for red in real
  UI. So it stays literal, and stays named here.

The list has been 5. What retired the other four is worth keeping, because three of the four were
answered by fixing something else rather than by choosing a token:

- `DeviceMetricsCard` was filed as "the same pre-tile-style surface family" as `LoadProvenanceCard`.
  **It never was one** — its `gray-800/40` was a single `<tr>` hover inside a `CHART_HAIRLINE` table,
  and its `grid` variant has always rendered `<Tile>`. There was nothing to move; it is now
  `hover:bg-row-hover`. A wrong reason is worse than no reason: it parks a question under a heading
  where nobody will look for it again.
- `AmberNow`'s `bg-slate-200` became `surface-inverse` once it was clear the `ink-inverse` ramp —
  minted for the Sankey tooltips — was always this surface's ramp too.
- `LoadProvenanceCard`'s surface and **its cyan car icon were one exemption wearing two hats.** The
  icon could be neither `series-pool` (cyan is the POOL series; on the EV card that encodes a lie)
  nor `series-ev` (a re-tone) *for as long as the card painted its own shell*. Moving it onto
  `StatCardShell` → `TileHeader` dissolved the question instead of answering it: `tone` on a tile
  header IS the role's colour, so the EV card takes the EV series by construction. See the re-tone
  table below — this one is a real visual change.

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
| `text-ink-faint` on a LIGHT panel | `ink-inverse-secondary` (black/70) | `AmberNow`'s SUMMARY heading — gray-500, a dark-surface token, on the one light surface in the app. Legible by accident; the token asserted the opposite of the surface it sat on |
| `text-cyan-400` | `series-ev` (red-600) | `LoadProvenanceCard`'s car icon — **and its title with it**, because `TileHeader` tones icon and title together. The largest re-tone in this layer, and not cosmetic: cyan was the POOL series on the EV card. Rule 5 (identity, not decoration) is the whole argument; the card simply could not obey it until it was on the shared header |

None is larger than one palette step or a few percent of alpha, and all are inside the dashboard —
nothing that only the admin screens render was re-toned.
