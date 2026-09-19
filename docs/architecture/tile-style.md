# Tile Style — "silent card, loud data"

> **Status:** current — introduced 2026-09-19.

How a dashboard tile looks. The visual language is Apple's Activity app and iOS widgets, and
the whole idea is one inversion of what the tiles used to do: **the card is silent, the data is
loud.** Every tile is the same borderless dark-grey slab on a true-black page. Each tile keeps its
role's theme colour — the one its series has in every chart — but wears it on the header and the
data (number, ring, bars, chevron), never on the box.

Source of truth for the _what_: `lib/tile-style.ts` (tokens), `components/ui/tile-surface.tsx`
(the shell), `lib/role-chrome.ts` (role colours). This document holds the _why_.

## What it replaced

Tiles grew up one at a time and carried their identity in the **chrome** — a role-tinted
background and a role-coloured 1px border — while every number was neutral grey. Four shells
duplicated the same class string (`Tile`, `StatCardShell`, `AmberSmallCard`/`TeslaSmallCard`,
`GridSignalsCard`), and each carried its own copy of the staleness timer and tooltip.

## The rules

1. **One surface.** `TILE_SURFACE`: `#1C1C1E`, no border, no tint, no shadow. Role never touches
   the chrome. Idle is expressed in the data (the value greys), never by greying the box.
2. **Colour is the tile's theme, and it lives on the data.** Every role tile keeps the colour its
   series has everywhere else (`CHART_COLORS`: solar yellow, load blue, hot water orange, battery
   green, grid magenta, EV red), via `ROLE_CHROME[role].value` (a class) and `.rgb` (for SVG) —
   `role-chrome.test.ts` pins both to the palette. The theme colours the header's icon and title
   (the iOS widget header), the hero value and its unit, the ring, the bars and the chevron — never
   the surface. Labels are white; captions `white/55`. A tile with no role (generator, device
   metrics) has no theme and stays white. At most three hues per tile.
3. **Radius 22 / padding 16**, stepping down to 18 / 12 under 180px of tile width.
   🛑 The `@container` and the surface are **two elements** (`TILE_ROOT` wraps `TILE_SURFACE`): a
   container query never matches the container itself, so width-dependent radius and padding must
   live one level in.
4. **Type is rounded and heavy.** `.tile-scope` (app/globals.css) sets `ui-rounded` — the real SF
   Pro Rounded on every Apple device, no font file shipped — over the TT Interphases face the tiles
   already used. Scale: title 15/600 · label 13/400 · caption 11/500 · hero 22→28→34/700 · supporting
   value 17/700, all `tabular-nums`.
5. **Units take the value's colour and keep their case** (`3.2 kW`, `16.3 kWh`, `$84/MWh`). Done
   in CSS on `<Value>`'s `data-unit` spans inside `.tile-scope`, so every nested value follows
   without being told; outside a tile, units stay muted ([number-typography.md](number-typography.md)).
   Units are never upper-cased: SI case is load-bearing (`mW` is not `MW`), and `KW`/`G/KWH` read
   as typos.
6. **The narrowest tile is ~150px — never design a tier below it.** `lib/dashboard/tile-grid.ts`
   never drops under 2 columns and never lets a column fall under 176px, so a tile in a multi-tile
   row runs ~150–280px, and a tile alone in its row is as wide as the section (~1000px). Those are
   the only two cases. Amber and Tesla each carried `@[90px]`/`@[120px]` tiers from before that
   policy, rendering for nobody — Tesla's ring overflowed at 66px in the gallery for months, because
   only the gallery ever went there. `app/labs/card-gallery`'s preset widths are now the reachable
   ones, so a form that looks wrong there is a form a reader can actually get.
7. **One hero per tile**, glanceable in under two seconds: hero plus at most two supporting facts in
   a small tile. A **medium** tile (`TilePlugin.span: 2`) may carry a viz _and_ a stat column.
8. **Rings are fat.** `ProgressRing` defaults to a 0.14 stroke ratio, round caps, a track of the
   same hue at 25%, an optional gradient, a glyph riding the arc's tip (turned to its tangent) and an
   optional notch for a target. `ConcentricRings` is the Activity Rings set. **One size**: every
   ring tile (Battery, EV, Amber's price disc, the NEM grid) takes `TILE_RING` — 108px, 76px under
   180px of tile width — with its centre number in `TILE_RING_VALUE`, and the same skeleton: header,
   ring centred in the free height, one bottom row.
9. **Mini charts are bars on hairlines** (`MiniBars`): thin round-capped bars in the series colour,
   a faint hairline per slot, a stronger one under each time label. No axes, gridlines or tooltip.
   Bars follow the dashboard's navigator period (`bucketBars`: D hourly, W/M daily, Y monthly) and
   read the site charts' own `siteDataQuery`, so they cost no request and always agree with the
   stacked chart beside them.
10. **Direction is a chip** (`DirectionChip`): a coloured chevron in a grey disc. **Up** = energy
   leaving (export, battery discharge), **down** = energy arriving (import, battery charge), a dash
   = idle (under 100 W). It replaced chevrons glued to the role icon, whose meaning flipped with the
   icon's side of the header.
11. **Stale is quiet.** No diagonal hatch, no dimmed box, and never a grey-out: LIVE values (a hero
    "now", a ring, a direction row) keep their hue and dim (`TILE_STALE`), and the header shows a
    clock + the reading's age with the exact time on hover (`useStaleness` / `StaleBadge`, one
    implementation for every shell). Greying erased what a tile IS — the renewables ring stopped
    being green — exactly when the feed lagged, and on a dev machine (crons off) that is always.
    🛑 PERIOD data — the bars, the Grid/Generator totals, the Home Energy rings — is not dimmed at
    all: a total over the navigator's window is not made wrong by a lagging live feed.
12. **Motion is small.** Rings and bars ease 400ms (`.tile-ease`); nothing moves under
    `prefers-reduced-motion`.
13. **Brand marks are guests.** The Amber and Tesla marks sit in the title slot. Amber's price disc
    is a plain disc in its brand gradient — it _is_ the data — with no ring or halo around it.

## Page-level consequences

- **Dashboard pages are true black.** `#1C1C1E` on `gray-900` reads muddy.
- **A section is a bold header, not a frame.** Tile rows stand bare under it. Charts draw no frame
  of their own (chart-style.md rule 1), so each run of non-tile children in a section keeps a
  `Panel` — the frame the whole section used to be. Moving that panel onto the tile surface is the
  chart-side follow-up.
- **The gutter is tight** (`gap-2.5`, `gap-3` once there is room): on borderless slabs the gap _is_
  the edge.
