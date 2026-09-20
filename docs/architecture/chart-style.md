# Chart Style

> **Status:** current — introduced 2026-08-31.

How a chart is housed, drawn and labelled. One set of rules, applied everywhere, so that the lines
chart, the stacked charts, the heatmap and the provenance chart look like they came from the same
product.

Source of truth for the _what_: `lib/charts/style.ts` (surface classes, ink, legend classes) and
`components/ui/panel.tsx` (`<Panel>`). This document holds the _why_. Series **colours** are a
different question and live in `lib/chart-colors.ts` + the `series-*` tokens
([colour-tokens.md](colour-tokens.md)) — that module is about identity (which hue
means Solar); this one is about furniture.

## The problem this replaces

Two dashboards of the same site, drawn by the same component (`components/DashboardChart.tsx`) off
the same primitives, did not look like the same product:

- `/dashboard/simon/daylesford` (lines) put the chart in a filled roundrect —
  `md:bg-gray-800 md:border md:border-gray-700 md:rounded md:p-4` — nested inside the section's own
  box. Two frames, and the inner one only above `md`.
- `/dashboard/simon/daylesford-stacked` had no frame at all, and read better for it.

That was one instance of a wider drift. Every chart-bearing surface had grown its own:

| Surface                   | Frame it drew                                                       |
| ------------------------- | ------------------------------------------------------------------- |
| v4 section                | `rounded-lg border-gray-700/70 bg-gray-900/30 p-2 sm:p-3`           |
| `LinesChartCard`          | `md:bg-gray-800 md:border md:border-gray-700 md:rounded md:p-4`     |
| `SiteChartsCard` load     | `px-2 sm:px-4 pt-1 sm:pt-2 pb-2 sm:pb-4` — none                     |
| `SiteChartsCard` gen      | `p-2 sm:p-4` — none                                                  |
| `HeatmapChart`            | `rounded-lg border-gray-700 bg-gray-900 p-4`                        |
| `HeatmapPanel`            | `bg-gray-900 rounded-lg border-gray-700`                            |
| `BatteryProvenancePanel`  | `bg-gray-800/50 border-gray-700 rounded-lg p-2 sm:p-4`              |
| `RunsCard`                | `bg-gray-800 rounded-lg border-gray-700`                            |
| `DeviceMetricsCard`       | `rounded-lg border-gray-700/50 bg-gray-900/30`                      |
| `DailyStripes`            | `-mx-6 px-3 py-3 sm:mx-0 sm:bg-gray-800 sm:rounded sm:p-4`          |
| `AmberCard`               | none                                                                 |

Four backgrounds, three border alphas, two radii, two breakpoint-gated frames — and the axis ink was
duplicated too: `lib/charts/svg/axes.tsx` and `components/HeatmapChart.tsx` each held a private,
byte-identical `TICK_TEXT` and `FONT_FAMILY`.

## The rules

### 1. One frame per nesting level, and the host owns it

A dashboard has exactly one box around a card, and the **section** draws it. A card body inside a
section adds no background, no border and no radius — only padding.

`<Panel>` is that box. A dashboard SECTION is no longer one of its users: a section is a bold
heading on the black page, and the runs of cards under it carry padding only (`SECTION_RUN_PAD`).
What is left for `Panel` is a surface that genuinely stands alone on a page background — the
standalone pages (`/device/{id}/heatmap`, the labs pages) that mount a panel component with no
section around it, and the short notices (unknown card type, misconfigured card, area unavailable),
which are prose with no shape of their own.

This is why `HeatmapPanel` and `DailyStripes` render frameless and their standalone hosts wrap them
— the same component appears in both places, so the frame cannot belong to the component.

### 2. A frame is never breakpoint-gated *per surface*

`md:bg-gray-800`, `sm:rounded` — a frame that materialises at a breakpoint means the chart matches
its neighbours on a phone and diverges on a laptop. The lines chart and the daily-stripe card each
did this, in different directions. What the rule protects is AGREEMENT between neighbours: no card
may carry a gate its neighbour does not.

There are now no exceptions at all. There used to be one — `CHART_PANEL_BLEED` dropped the
**section** frame below `sm`, for every section at once, because on a phone the chrome cost ~20px a
side once the page inset, the section padding and the card body padding had each taken their cut,
and a 600px Sankey had to fit in what was left. That frame is gone at every width (see rule 3: the
things inside it already have an edge), so the gate went with it and only the padding remains, as
`SECTION_RUN_PAD`. `CHART_BODY_PAD` still goes horizontally to zero at `sm` for the matching reason
— the section reaches the screen edge there, and keeping the body inset just moves the gutter
inwards. Vertical padding is untouched at every width: it keeps stacked charts off each other,
which has nothing to do with screen width.

If you find yourself wanting such a gate, it is almost certainly a per-surface one. Don't.

### 3. A chart delimits itself; a table does not

A chart has axes down its left, gridlines across it and tick labels below — it states its own
extent, so a box around it is redundant ink. A **table** has no such shape, and a scroll region
needs an edge to scroll within. So a tabular card may draw `CHART_HAIRLINE` — a border with **no
fill** — around the table, and only around the table. Never a filled card around the whole card.

`DeviceMetricsCard` qualifies. `RunsCard` deliberately does NOT: it sits directly beneath a stacked
chart whose own `EnergyTable` is frameless, and two tables describing the same window should start
at the same pixel and carry the same ink. It uses `CHART_BODY_PAD` + `TABLE_GUTTER`, the energy
table's gutters, and leans on its sticky header/footer rules instead of an outline.

### 4. One of each token

| Role       | Token                                             |
| ---------- | ------------------------------------------------- |
| Frame      | `CHART_PANEL` — `rounded-lg border-line-soft bg-surface-panel` |
| Frame pad  | `CHART_PANEL_PAD` — `p-2 sm:p-3`                  |
| Body pad   | `CHART_BODY_PAD` — `p-2 sm:p-4`                   |
| Hairline   | `CHART_HAIRLINE` — `rounded-lg border-line-soft`, no fill |

`rounded` (4px), `border-gray-700`, `border-gray-700/50`, `bg-gray-800`, `bg-gray-800/50` and
`bg-gray-900` are retired as chart-surface values.

### 5. Ink lives in one place

`CHART_INK` holds everything drawn into an `<svg>` that is not a series: gridline stroke, tick text
colour, tick font size and family, two-line tick leading, series stroke weight, band-edge hairline,
focus-line weight, and the daytime shading wash.

Two stroke weights, deliberately different: a **line series** is 2px, because on the lines chart the
stroke IS the data; a **stacked band's top edge** is 1px, because there the stroke is only a
boundary, and at 2px a series resting at zero reads as a heavy rule along the axis.

Run-period overlay ink (`RUN_FILL`, `RUN_EDGE`, the stripe pitch) stays local to
`DashboardChart.tsx`. It is not chart furniture — it marks an event, and its reasoning is specific
to that.

### 6. One legend vocabulary, two legend forms

Placement legitimately differs. The lines chart labels its series in a **row under the plot**
(`components/ChartTooltip.tsx`) — five fixed series, doubling as the focused-value readout. The
stacked chart uses a **table beside it** (`components/EnergyTable.tsx`) — a variable series set you
can toggle, with totals and a cycling metric column. A row suits the first; a table suits the second.

The ink does not differ. `LEGEND_ROW`, `LEGEND_SWATCH`, `LEGEND_LABEL`, `LEGEND_HEADER`,
`LEGEND_VALUE` and `legendSwatchStyle` are the same in both. The table was the more careful of the
two, so the direction of travel was table → row: the row had four copy-pasted inline `style` blocks
each re-declaring a min-width, a flex and DM Sans, and drew a hard-edged swatch beside the table's
`rounded-sm` one.

A swatch is filled **and** bordered in the series colour, so an entry can express "hidden" by
dropping the fill and keeping the outline — the stacked table's toggle idiom.

**Where the unit goes.** In a table it belongs to the column header (`Energy (kWh)`); in a row there
is no header, so it rides inline on each value via `<Value>`. Both are consistent with
[number-typography.md](number-typography.md), which already exempts a detached column or axis unit
from the hero-value rule.

## Deliberately exempt

- **The stat-card family** — `Tile.tsx`, `ui/stat-card-shell.tsx`, and the cards built on them
  (`BatteryContentsCard`, `HomeEnergyCard`, `LoadProvenanceCard`, `GridSignalsCard`, the Amber and
  Tesla small cards). A stat card _is_ a filled chip; the fill is its whole shape. It no longer
  carries a role colour there: [tile-style.md](tile-style.md) made every one of them the same
  neutral `surface` slab with no border and no tint, and put the role on the DATA instead — the
  `bg-gray-800/50`-plus-tinted-border this line used to describe is gone. Note the membership test
  is the shape, not the node kind: `battery-contents` and `ev-provenance` are full card plugins,
  not tile views, and are still in this family.

  🛑 A stat card is also **self-surfaced**, which is a layout fact and not just a visual one: it
  states its own extent, so a section must not wrap it in `SECTION_RUN_PAD`. Card plugins say so
  with `CardPlugin.selfSurfaced` — `battery-contents` lacked it and rendered 12px narrower per side
  than the Home Energy card beside it at `sm` and up.
- **Modals, menus and popovers** — `bg-gray-800` on a shadow is a floating surface, a different
  problem from an in-page panel.
- **The Sankey** — its own layout and ink, out of scope here.

## Verifying a change

`app/labs/chart-gallery/` renders ~40 frozen cases and `e2e/charts.spec.ts` screenshots each at two
widths under a stated zero-diff rule. Note what the gallery does and does not cover: it mounts
`DashboardChart`, `ChartTooltip`, `ProvenanceChart` and `HeatmapChart` **directly**, not the cards
around them — so a surface change shows up there only where it reaches the chart itself. Card-frame
changes need eyes on a real dashboard, at desktop width *and* below `md`.
