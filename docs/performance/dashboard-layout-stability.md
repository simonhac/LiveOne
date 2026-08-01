# Dashboard layout stability

> Status: current. Companion to [dashboard-fetch-waterfall.md](dashboard-fetch-waterfall.md), which
> measures WHEN a dashboard's data arrives. This one is about what the page does to itself while it
> waits — and the recipe for re-measuring the numbers the renderer depends on.

## The problem

`/dashboard/[...slug]` SSR-prefetches `/api/data` for every section handle and every
authorization-safe device pin, so tiles paint filled in the first HTML. Nothing else is prefetched.
Every non-tile card owns a second query — history, sankey, amber, latest readings, run periods,
provenance, heatmap points — and each settles on its own timeline. For that interval the card is a
placeholder, and if the placeholder is not the size of the card, the page moves under the reader as
each one resolves.

Before 2026-08-01 the entire placeholder vocabulary was two constants — a 120px tile box and a
360px "chart" box — standing in for twenty card types. Several cards reserved nothing at all.

**Measured on prod, 2026-08-01**, switching client-side into Kinkora (1960px viewport, 1247px
section container), sampling every 50ms:

| t     | tile row | site-charts | battery-contents | home-energy |
| ----- | -------- | ----------- | ---------------- | ----------- |
| +0.0s | 387      | **806**     | 143              | **125**     |
| +1.0s | 387      | **1570**    | 143              | **185**     |

The site-charts block grew by **764px** — the sankey (a 680px SVG plus its header and label) had
zero space reserved and simply appeared. Home Energy grew 60px, its `h-16` loading stub being less
than half the height of the stat grid that replaced it.

> **CLS is the wrong metric here** and reads 0.0 on both Kinkora and Daylesford. The
> `layout-shift` entry type only scores elements that move _inside the viewport_; the shifts above
> are mostly below the fold on a desktop, and they are exactly what a reader scrolling a dashboard
> experiences. Measure element heights over time instead — the recipe below.

## The mechanism

Two layers, in `components/dashboard/`:

1. **A declared footprint per card type** — `CardPlugin.footprint(node)`, a REQUIRED field, with the
   numbers tabled in [`cards/footprints.ts`](../../components/dashboard/cards/footprints.ts). The
   registry's `satisfies { [T in KnownCardType]: PluginFor<T> }` makes a new card type that doesn't
   declare one a build error. Where the height follows CONFIG rather than data it is computed, not
   estimated: `daily-stripe` is `days` rows tall (`dailyStripeFootprint`), the collapsed site-charts
   block is additive in its collapse keys (`siteChartsFootprint`).
2. **A remembered height per node** — `<CardSlot>` measures each settled card and files the height in
   the `lo_ch` cookie ([`lib/dashboard/card-heights.ts`](../../lib/dashboard/card-heights.ts)), so
   the next visit reserves the real number. This is what covers the cards whose height is a property
   of their DATA — a device-metrics grid is as tall as the device has points, a generator-run table
   as tall as the period has runs — where no static footprint can be right.

A cookie rather than `localStorage` because the RSC has to be able to read it: a height applied
after hydration would ADD a paint, not remove one. Everything about the trade-offs is documented in
those two files.

Placeholders all carry `data-skeleton`; `<CardSlot>` refuses to record a height while one is in its
subtree, so a placeholder can never be remembered as if it were the card.

## Recorded footprints

Measured off the settled cards at a 1960px viewport (1247px section container).

| card                                   | px    | source                            |
| -------------------------------------- | ----- | --------------------------------- |
| `chart` (lines)                        | 360   | prod Daylesford / Kutis           |
| site-charts, one stacked chart + table | 403   | prod Kinkora (806 for two)        |
| site-charts, sankey block              | 764   | prod Daylesford (sankey alone)    |
| `battery-contents`                     | 143   | prod Daylesford + Kinkora         |
| `renewables` (Home Energy)             | 185.5 | prod Daylesford + Kinkora + Kutis |
| `generator-runs` (empty)               | 115   | dev Daylesford                    |
| `device-metrics` (grid, one row)       | 92    | dev Daylesford (DeepSea)          |
| `device-metrics` (table)               | 192   | matched the existing `h-48` stub  |

`amber-now`, `amber-timeline`, `heatmap`, `ev-provenance` and `battery-provenance-history` are
**not placed on any dashboard**, so there was nothing settled to measure; their footprints are
derived from the components' own box models and are flagged `estimated` in the table. Re-measure
with the recipe below the first time one is placed.

## After

Same measurement, same client-side switch into Kinkora, **first visit with no learned heights**, so
every reservation is a declared footprint. `*` marks a card still holding a placeholder:

| t      | tile row | site-charts | battery-contents | home-energy |
| ------ | -------- | ----------- | ---------------- | ----------- |
| +23.2s | 388      | 1570\*      | 143.5            | 185.5\*     |
| +27.3s | 388      | 1570        | 143.5            | 185.5       |

**Zero movement** across the swap, against 824px before.

> Measure with FRACTIONAL heights (`getBoundingClientRect().height`, not rounded). An earlier run
> of this appeared to show a residual 1px on the Home Energy card; unrounded it was 0.5px, and the
> cause was real: that card's skeleton used a hard `h-[14px]` for a `text-[11px]` line. Tailwind's
> ARBITRARY font-size utilities set no line-height, so the real line box is `normal` — a fractional
> ~13.5px that no `h-*` can name. The fix is the general principle stated above, applied one level
> deeper: the placeholder rows are now transparent text in the real classes, so real glyphs
> generate the line box and the placeholder is exactly the size of what replaces it (and stays that
> way if the typography changes). Rounded measurement would have hidden the defect.

On the SECOND visit the reservations come from the cookie and the SSR HTML already carries them:

```
$ curl -s <dashboard url> | grep -o 'min-height:[0-9]*px'
min-height:387px   min-height:1570px   min-height:143px   min-height:185px
```

## Recipe — re-measuring

Run in a signed-in tab on the target dashboard. Records every card's height over time and prints
only the samples where something changed.

```js
// 1. Install the probe. Heights are FRACTIONAL on purpose (see the note above — rounding hid a
//    real half-pixel defect), and each card also reports whether it still holds a placeholder.
window.__probe = [];
const snap = () =>
  [...document.querySelectorAll("main section")].flatMap((s) =>
    [
      ...(s.querySelector(":scope > div.flex.flex-col.gap-4")?.children ?? []),
    ].map((c) => ({
      h: +c.getBoundingClientRect().height.toFixed(2),
      sk: !!c.querySelector("[data-skeleton]"),
    })),
  );
window.__probeId = setInterval(() => {
  window.__probe.push({ t: Math.round(performance.now()), k: snap() });
}, 50);

// 2. Client-side navigate INTO the dashboard under test (a hard reload can't be probed from
//    before load; the switcher route exercises the same card mounts).
document.querySelector("h1").parentElement.click();
await new Promise((r) => setTimeout(r, 300));
[...document.querySelectorAll("a")]
  .find((a) => a.getAttribute("href") === "/dashboard/id/<db_…>")
  .click();
await new Promise((r) => setTimeout(r, 10000));

// 3. Collapse to the transitions.
clearInterval(window.__probeId);
const out = [];
let prev = null;
for (const s of window.__probe) {
  const k = JSON.stringify(s.k);
  if (k !== prev) (out.push(s), (prev = k));
}
// Each row: the card heights, `*` where a placeholder is still up. A correct dashboard shows the
// SAME numbers before and after the `*` clears.
out.map((s) => ({ t: s.t, k: s.k.map((x) => x.h + (x.sk ? "*" : "")) }));
```

**Clear `lo_ch` first** (`document.cookie = 'lo_ch=; path=/; max-age=0'`) — otherwise you are
measuring the remembered heights, not the declared footprints. Measure at 375 / 768 / 1440 too: the
cookie's tier bucket (`sm`/`md`/`lg`) exists because these heights are width-dependent.

To read a single card's settled height for the footprint table, let the page settle and inspect the
section's direct children:

```js
[
  ...document.querySelectorAll("main section > div.flex.flex-col.gap-4 > *"),
].map((c) => ({
  h: Math.round(c.getBoundingClientRect().height),
  minH: c.style.minHeight,
  txt: c.innerText.trim().replace(/\s+/g, " ").slice(0, 40),
}));
```

`minH` is the reservation and `h` is the truth; when they disagree by more than a pixel or two, the
footprint needs updating.
