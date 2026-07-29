# Number & Unit Typography

> **Status:** current — introduced 2026-07-29.

How a hero number and its unit are set on dashboard cards. One rule, applied
everywhere, so that `0.0 kW`, `40.0°C` and `$93/MWh` all look like they came from
the same product.

Source of truth for the _what_: `lib/point/unit-typography.ts` (`classifyUnit`)
and `components/ui/value.tsx` (`<Value>`). This document holds the _why_.

## The problem this replaces

Three components each encoded their own tight-vs-spaced rule, and they disagreed:

| Where                    | Rule it encoded                                       |
| ------------------------ | ----------------------------------------------------- |
| `Tile.tsx`               | narrow space before every unit **except `%`**; unmuted |
| `BatteryContentsCard`    | `<Unit>` gap defaults **true**; unit **always** muted   |
| `GridSignalsCard`        | `<Unit>` gap defaults **false**; muting **opt-in**      |

So `40.0 °C` was spaced in the Hot Water tile but tight in the HWS labs page;
`77%` was muted in the battery strip but `37%` was not in the grid card; the
heatmap tooltip fused everything ("3.4kW"). Four copy-pasted `Stat` components had
drifted to two different hero colours.

## The rule

A hero value has up to four parts:

```
[prefix][ NUMBER ][unit][ qualifier]
```

Everything except the NUMBER renders at **`0.72em`, `font-semibold`** — sized in
`em` so it scales with whatever hero size the parent sets (a `text-2xl` tile, a
`text-[32px]` donut).

| Part            | Gap before  | Muted | Examples                                     |
| --------------- | ----------- | ----- | -------------------------------------------- |
| **prefix**      | —           | no    | `$`93                                        |
| **tight unit**  | none        | no    | 83`%` · 40.0`°C` · 4.0`¢`                    |
| **spaced unit** | hair 0.08em | yes   | 0.0` kW` · 2.0` kWh` · 356` g` · 1450` rpm`  |
| **per-tail**    | none        | yes   | $93`/MWh` · 21¢`/kWh`                        |
| **qualifier**   | word 0.3em  | yes   | 763` EI` · 37%` RE`                          |

### Why some units fuse and others don't

The split is typographic, not dimensional.

`%`, `°`, `°C`, `¢`, `$` are **glyph modifiers**. They read as part of the number
itself — "eighty-three percent" is one quantity, not a number and a thing. Putting
a gap in front breaks that reading, and muting them makes the value look like it
was truncated. So they fuse, and they keep the number's colour.

`kW`, `kWh`, `g`, `rpm`, `V`, `Hz` … are **symbols standing for a word**. They are
a separate token you would say separately, so they take a hair space, and they are
the least important thing in the tile — so they mute to `text-gray-400`.

Membership of the tight set lives in `TIGHT_UNITS` in `lib/point/unit-typography.ts`.
Add to it only when the symbol is non-alphabetic (or is a currency letter such as
the ASCII `c` for cents).

### Compound units split at the first `/`

`classifyUnit` splits `¢/kWh` into head `¢` (tight, unmuted) and tail `/kWh`
(tight, muted). The denominator always binds tight to whatever precedes it,
because the slash is what joins them. This one rule covers `¢/kWh`, `$/MWh`,
`g/kWh` (→ `356 g/kWh`, hair-spaced head) and a bare `/MWh`.

### Never emit a space character

The gap is a `margin-left` on the unit span, never a literal space, ` ` or
`&nbsp;`. Two reasons: a word space is far too wide at hero sizes, and it renders
differently across the two fonts in play (DM Sans and TT Interphases Pro,
`lib/fonts/amber.ts`).

Because the unit span is already at `0.72em`, its own `em` is 0.72 of the hero, so
the margins are pre-divided:

- hair gap → `ml-[0.11em]` (= 0.079em of the hero)
- word gap → `ml-[0.42em]` (= 0.30em of the hero)

These live in `GAP_CLASS` so nobody redoes the arithmetic.

### Two supporting rules

- **`tabular-nums` on every hero value.** These numbers update live; without it
  `9.6 → 11.0` shoves the unit sideways on every poll.
- **`whitespace-nowrap`** so a number never wraps away from its unit.

Both are baked into `<Value>` — you get them by using it.

### Colour & size tokens

| Role       | Token                                                      |
| ---------- | ---------------------------------------------------------- |
| Hero value | `text-xl md:text-2xl font-bold text-gray-100`               |
| Unit       | `text-[0.72em] font-semibold`, muted = `text-gray-400`      |
| Caption    | `text-[10px] uppercase tracking-wide text-gray-500 md:text-xs` |
| Card title | `text-xs md:text-sm text-gray-400`                          |

## Using it

`<Value>` is deliberately size-agnostic — the caller owns font-size, weight and
colour. That is what lets one component serve both tiles and donuts.

```tsx
<Value value="0.0"  unit="kW" />                 // 0.0 kW
<Value value="40.0" unit="°C" />                 // 40.0°C
<Value value="93"   prefix="$" unit="/MWh" />    // $93/MWh
<Value value="37"   unit="%" qualifier="RE" />   // 37% RE
<Value value="763"  qualifier="EI" />            // 763 EI
```

`<Stat>` (`components/ui/stat.tsx`) wraps `<Value>` with hero typography plus an
optional caption — use it for the caption-under-value shape.

**Never bake a unit into the value string.** That is what forced the device-metrics
card to render "1234 rpm" entirely at hero size. Formatters should return the bare
number and let the unit travel separately (the convention `lib/provenance-format.ts`
already documents; `lib/energy-formatting.ts:formatValue` already returns
`{ value, unit }`).

## Worked examples, from the real cards

| Card                     | Renders as   | Class                       |
| ------------------------ | ------------ | --------------------------- |
| Solar / Load / Grid tile | `0.0 kW`     | spaced unit                 |
| Hot Water tile           | `40.0°C`     | tight unit                  |
| Battery tile             | `10.0%`      | tight unit                  |
| Amber price              | `21¢`        | tight unit                  |
| Tesla donut              | `83%`        | tight unit                  |
| Grid price               | `$93/MWh`    | prefix + per-tail           |
| Grid emissions           | `763 EI`     | qualifier only              |
| Grid renewables          | `37% RE`     | tight unit + qualifier      |
| Grid demand              | `7,126 MW`   | spaced unit                 |
| Battery strip            | `2.0 kWh`    | spaced unit                 |
| Battery strip            | `4.0¢`       | tight unit                  |
| Battery strip            | `356 g`      | spaced unit                 |
| Device metrics           | `1450 rpm`   | spaced unit                 |

## Deliberately exempt

Not everything is a hero value. Leave these alone:

- **Sankey node labels** — the unit is stacked _beneath_ the value in SVG, by design.
- **Table headers, axis ticks and column units** (`ViewDataModal`,
  `ProvenanceValueTable`, `EnergyTable`, chart axes) — the unit is detached and
  labels a whole column or axis, not one number.
- **Donut captions** such as Amber's `/kWh` under the price — that is a caption on
  its own line, not a suffix.
