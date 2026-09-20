"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  FocusLine,
  ShadingBands,
  TimeAxis,
  ValueAxis,
  bandPath,
  buildGeometry,
  buildShadingBands,
  buildTimeTicks,
  indexForSpan,
  linePath,
  nearestIndexForTime,
  niceDomain,
  stackedBands,
  useContainerSize,
  useIsTouchDevice,
  usePointerIndex,
} from "@/lib/charts/svg";
import { CHART_COLORS } from "@/lib/chart-colors";
import { CHART_INK } from "@/lib/charts/style";
import { SOC_DASH, lineSeries } from "@/lib/charts/line-series";
import {
  hitTestRuns,
  snapToBandEdges,
  type RunBand,
  type RunHitBox,
} from "@/lib/charts/run-bands";
import type { ChartTimeRange } from "@/lib/charts/temporal";
import type {
  ChartData,
  LineChartData,
  PaddedSOCData,
  SeriesData,
} from "@/lib/charts/types";

/**
 * The presentational dashboard chart. One component, two visual variants — `lines` (overlaid lines,
 * or grouped bars in energy mode; the sidebar chart) and `stacked-areas` (stacked areas, or stacked
 * bars in energy mode; the site load/generation chart). Data ownership and interaction state stay in
 * the cards.
 *
 * Ported off Chart.js in Stage 5 (docs/plans/chart-library-consolidation.md) — the last and highest
 * risk slice, because the stacked variant is where null handling actually bites.
 *
 * Two props from the Chart.js era are gone rather than carried:
 *  - `chartRef` — a `Chart` instance ref both cards created, passed, and never read.
 *  - `onHover(event, activeElements, chart)` — of which only `activeElements[0].index` was ever used.
 *    Now `onHoverIndex(index | null)`, which is also what `ProvenanceChart` takes.
 */

const SOC_DOMAIN: [number, number] = [0, 100];

/**
 * Where a hovered run is, and what to place its panel against — all in the CHART'S OWN coordinates
 * (origin at the top-left of this component's box, which is also the svg's).
 *
 * 🛑 Not viewport coordinates, and not measured with `getBoundingClientRect`. These come straight
 * out of the same `geo` that drew the band, so they are geometry rather than a snapshot of where the
 * page happened to be scrolled to — which is what lets the caller anchor the panel with a plain
 * `position: absolute` and have it travel with the chart for free. Measured viewport coords went
 * stale the moment anything scrolled, and chasing that with a scroll listener is a JS answer to a
 * question CSS already answers.
 *
 * `plot` is the PLOT BOX, not the SVG's: centring on the svg would pull the panel down by half the
 * time-axis gutter, so it would sit visibly low against the data it describes.
 *
 * No pointer position: the panel sits beside the run and its beak aims at the vertical middle of the
 * run's own band (`yTop`..`yBottom`), so where in the run the pointer happens to be is not part of
 * the answer.
 */
export interface RunTooltipAnchor {
  x0: number;
  x1: number;
  /** The band's stack ceiling and floor over the run, in the same chart-box coords as `x0`/`x1`. */
  yTop: number;
  yBottom: number;
  plot: { left: number; top: number; width: number; height: number };
  /** The chart box's own width. The panel may overhang the axis gutters sideways (covering tick
   *  labels for the duration of a hover), which on a phone is the difference between a panel that
   *  fits beside the run and one dropped on top of it. */
  boxWidth: number;
}

/**
 * Run-period overlay ink.
 *
 * A run is an EVENT worth noticing, not background texture — the distinction `ProvenanceBand` draws
 * for the BMS-recalibration bands, and the reason these are not another pass of `ShadingBands`' 7 %
 * white wash. Two differences follow from it: the overlay is clipped to the band's OWN area rather
 * than running full height (a charge session is a fact about the EV, not about the whole site), and
 * it carries a visible outline at rest so the run can be found without hunting for it with a mouse.
 *
 * The darkening is black rather than a tint of the series colour: it has to read the same way over
 * every band the stack might give it, and it must not become a colour a legend could be looked up by.
 *
 * It is applied as DIAGONAL STRIPES, not a flat wash — half the tile carries the darkening and half
 * is fully transparent. A wash dims the band, which reads as "this data is lesser"; a texture reads
 * as "this region is marked", which is what a run is. Averaged over the tile it is half the ink a
 * flat wash of the same colour would lay down, which is what keeps it subtle.
 */
const RUN_FILL = "rgba(0, 0, 0, 0.14)";
const RUN_FILL_HOVER = "rgba(0, 0, 0, 0.26)";
const RUN_EDGE = "rgba(255, 255, 255, 0.45)";
const RUN_EDGE_HOVER = "rgba(255, 255, 255, 0.95)";
/** Stripe pitch and duty, in px — see `patternUnits` on the pattern for why these are not fractions. */
const RUN_STRIPE_TILE = 8;
const RUN_STRIPE_WIDTH = 4;
/** How far a touch may travel, in px, and still count as a TAP rather than a scrub of the crosshair. */
const TAP_SLOP = 10;
/** How long the axis-tap badge stays up; matches `axis-tap-flash` in globals.css. */
const TAP_FLASH_MS = 700;
const TAP_FLASH_RADIUS = 30;
/** Gap between the badge and the chart's edge. */
const TAP_FLASH_INSET = 4;
/**
 * Height of the axis strip when it is also a tap target.
 *
 * 🛑 `DEFAULT_MARGIN.bottom` is 34px, which is BELOW the 44px minimum touch target — so the axis is
 * not big enough to tap as it stands, and the zone has to buy the height rather than assume it.
 * Desktop geometry is untouched: the strip only grows when `onAxisTap` is wired AND the device is
 * touch.
 */
const AXIS_TAP_HEIGHT = 48;

type CommonProps = {
  timeRange: ChartTimeRange;
  /** End of the rendered window (the last data timestamp), NOT the wall clock. */
  windowEnd: Date;
  windowStart: Date;
  /** Shared focus instant → the crosshair, synced across the section by ChartFocusContext. */
  hoveredTimestamp: Date | null;
  onHoverIndex: (index: number | null) => void;
  /**
   * TOUCH only: a tap on the time-axis strip below the plot steps the shared window — left half
   * older, right half newer. This is the phone's replacement for the `<` `>` buttons, which are
   * hidden at `(pointer: coarse)` (see `TemporalNavigator`). Absent → no zones, no glyphs, and the
   * axis keeps its desktop height.
   */
  onAxisTap?: (dir: "older" | "newer") => void;
  /** False at the latest window: the `newer` zone is inert and its glyph is dimmed. */
  canGoNewer?: boolean;
  className?: string;
};

type LinesProps = CommonProps & {
  variant: "lines";
  chartData: LineChartData;
  paddedSOCData: PaddedSOCData | null;
  maxPowerHint?: number;
};

type StackedProps = CommonProps & {
  variant: "stacked-areas";
  chartData: ChartData;
  effectiveVisibleSeries: Set<string>;
  mode: "load" | "generation";
  /**
   * Draw the Battery SoC overlay (the dashed line, and its min/max band in energy mode)?
   *
   * Separate from `effectiveVisibleSeries` because SoC is not part of the stack: it rides the right
   * axis and contributes to no total, so the stack's membership rules do not apply to it. Toggled
   * from the legend table's SoC row. Defaults to true — a caller that says nothing gets what the
   * chart always drew. The right axis itself is NOT hidden with it, so the plot does not resize
   * under the reader when they flick it off.
   */
  socVisible?: boolean;
  /**
   * Persisted run periods to bracket on their own series' band (EV charge sessions, generator runs).
   * Window-clamped by `runBandsForSeries`; the card owns the fetch and the hover state.
   */
  runBands?: readonly RunBand[];
  hoveredRunId?: string | null;
  /**
   * `at` is the anchor for the card's tooltip, in this chart's own coordinates: the run's left and
   * right edges (so the panel can sit beside the region rather than covering the thing it describes)
   * plus the plot box to place and clamp against. Absent when the hover ends. See
   * {@link RunTooltipAnchor} for why these are not viewport coordinates.
   */
  onHoverRun?: (band: RunBand | null, at?: RunTooltipAnchor) => void;
  /**
   * Click: PIN or unpin this run's panel. Separate from `onHoverRun` because the two mean different
   * things to the card — hover is a transient preview it may discard, a click is a choice it has to
   * hold on to after the pointer leaves. The card decides which of the two it is looking at; this
   * chart only reports that a run was clicked.
   */
  onToggleRun?: (band: RunBand, at: RunTooltipAnchor) => void;
  /**
   * TOUCH only: a tap on the plot that resolved to no run. The chart hit-tests touch taps itself
   * (see the svg's `onPointerUp`), so it — not a document listener — is what knows a tap missed.
   */
  onTapOutsideRun?: () => void;
};

export type DashboardChartProps = LinesProps | StackedProps;

/**
 * Bar geometry for one category.
 *
 * Reproduces Chart.js's `categoryPercentage`/`barPercentage` model rather than inventing spacing: the
 * category gets a slice of the axis, the group takes `categoryPct` of it, and each bar takes `barPct`
 * of its share of the group. Kept local — this is the only chart with bars, so lifting it into the
 * primitives would be a shared abstraction with one consumer.
 *
 * `span` overrides where a category sits and how wide it is: given one, category `i` occupies
 * `[span(i).x0, span(i).x1]` on the TIME scale rather than the `i`-th equal slice of the plot. That
 * is the Y period's one-bar-per-month case — see {@link BarSpan} for why equal slices are wrong
 * there. The insets are computed from whatever width the category turns out to have, so a partial
 * month draws proportionally narrower rather than being padded out to a full one.
 */
function barLayout(
  plotWidth: number,
  categories: number,
  seriesCount: number,
  categoryPct: number,
  barPct: number,
  span?: (i: number) => { x0: number; x1: number },
) {
  const evenW = categories > 0 ? plotWidth / categories : 0;
  const slot = (i: number) => {
    const left = span ? span(i).x0 : i * evenW;
    const categoryW = span ? span(i).x1 - span(i).x0 : evenW;
    const groupW = categoryW * categoryPct;
    const slotW = seriesCount > 0 ? groupW / seriesCount : 0;
    return { left, categoryW, groupW, slotW };
  };
  return {
    /** Width of one bar in category `i` — a function, since categories may differ in width. */
    width: (i: number) => Math.max(0.5, slot(i).slotW * barPct),
    /**
     * Middle of category `i`, in plot coordinates. Read from `slot`, so the crosshair is placed by
     * the same arithmetic that places the bars — the two cannot drift apart.
     */
    center: (i: number) => {
      const { left, categoryW } = slot(i);
      return left + categoryW / 2;
    },
    /** Left edge of series `s`'s bar within category `i`. */
    x: (i: number, s: number) => {
      const { left, categoryW, groupW, slotW } = slot(i);
      return (
        left + (categoryW - groupW) / 2 + s * slotW + (slotW * (1 - barPct)) / 2
      );
    },
  };
}

export default function DashboardChart(props: DashboardChartProps) {
  const {
    timeRange,
    windowStart,
    windowEnd,
    hoveredTimestamp,
    onHoverIndex,
    className,
  } = props;
  const [ref, size] = useContainerSize<HTMLDivElement>();
  // `clipPath` references are document-global, so two charts on one page would otherwise clip each
  // other's run overlays with whichever definition mounted last.
  const clipPrefix = useId().replace(/:/g, "");
  // Touch has no hover, so a run band is opened by a TAP and toggled shut by a second one — see the
  // run-overlay block below, and the outside-tap dismissal in `SiteChartsCard`'s `StackedChart`.
  const isTouch = useIsTouchDevice();
  const isEnergy = props.chartData.mode === "energy";
  /** Are the axis-tap zones live? Both halves of the question, asked once. */
  const axisTap = isTouch && props.onAxisTap ? props.onAxisTap : null;
  const timestamps = props.chartData.timestamps;
  // Uneven bars (the Y period's calendar months). Only trusted when it matches the timestamps
  // one-for-one — a mismatched pair would place bars against the wrong months in silence.
  const barSpans =
    props.chartData.barSpans?.length === timestamps.length
      ? props.chartData.barSpans
      : undefined;

  const series = useMemo(
    () =>
      props.variant === "lines"
        ? lineSeries(props.chartData)
        : props.chartData.series
            .filter(
              (s: SeriesData) =>
                s.seriesType !== "soc" &&
                props.effectiveVisibleSeries.has(s.id),
            )
            .map((s: SeriesData) => ({
              key: s.id,
              colour: s.color,
              values: s.data,
            })),
    [props],
  );

  const geo = useMemo(() => {
    if (size.width === 0 || size.height === 0) return null;
    // The stacked variant's ceiling is the column TOTAL; the lines variant's is the tallest series.
    const forDomain =
      props.variant === "stacked-areas"
        ? timestamps.map((_, i) =>
            series.reduce((sum, s) => {
              const v = s.values[i];
              return sum + (v != null && Number.isFinite(v) ? v : 0);
            }, 0),
          )
        : series.flatMap((s) => s.values);
    return buildGeometry({
      width: size.width,
      height: size.height,
      xDomain: [windowStart, windowEnd],
      yDomain: niceDomain(forDomain, {
        suggestedMax:
          props.variant === "lines" && !isEnergy
            ? props.maxPowerHint
            : undefined,
      }),
      // Sizes the left gutter; must match the `unit` the left ValueAxis is given below. A month's
      // energy total is four digits, which does not fit the default 44 px.
      yUnit: isEnergy ? "kWh" : "kW",
      // The axis doubles as the older/newer control on touch, and 34px is under the 44px minimum.
      ...(axisTap ? { margin: { bottom: AXIS_TAP_HEIGHT } } : {}),
      y1Domain: SOC_DOMAIN,
    });
  }, [
    axisTap,
    size.width,
    size.height,
    windowStart,
    windowEnd,
    series,
    timestamps,
    props,
    isEnergy,
  ]);

  const pointer = usePointerIndex({
    timestamps,
    spans: barSpans,
    // Span-less bars are placed positionally, so the pointer must be resolved positionally too —
    // see `indexForPosition`. Areas/lines keep the time scale.
    positional:
      isEnergy && !barSpans
        ? { categories: timestamps.length, plotWidth: geo?.plot.width ?? 0 }
        : undefined,
    invert: (px) => (geo ? geo.x.invert(px) : new Date(0)),
    plotLeft: geo?.plot.left ?? 0,
    onChange: onHoverIndex,
  });

  // Where a touch went down, so `pointerup` can tell a tap from a drag along the time axis.
  // `zone` is set when the touch landed on the axis strip rather than in the plot — that tap steps
  // the window and must not move the crosshair or hit-test runs on the way.
  const tapStartRef = useRef<{
    id: number;
    x: number;
    y: number;
    zone: "older" | "newer" | null;
  } | null>(null);

  // Every axis tap answers with a badge: `‹` or `›` for the step it took, an X for the one it
  // refused. The step itself can take a fetch to show, and a refusal shows nothing at all — so
  // without this a tap that worked, a tap that was refused and a tap that missed all look alike.
  // `key` restarts the CSS animation when a second tap lands while the first badge is still up.
  const [tapFlash, setTapFlash] = useState<{
    zone: "older" | "newer";
    blocked: boolean;
    key: number;
  } | null>(null);
  useEffect(() => {
    if (!tapFlash) return;
    const id = setTimeout(() => setTapFlash(null), TAP_FLASH_MS);
    return () => clearTimeout(id);
  }, [tapFlash]);

  // The axis tap in flight, kept alive PAST `pointerup` and past `pointercancel` for the `click`
  // that delivers it — see `onClick`. Cleared by that click, or overwritten by the next touch.
  const axisTapRef = useRef<{
    x: number;
    y: number;
    zone: "older" | "newer";
  } | null>(null);

  // `data-unmeasured` so "the container measured zero, so the chart drew nothing" is visible in
  // devtools. Without it this is an anonymous empty div, which is what made the mobile stacked-chart
  // collapse (a `h-full` box whose parent height came from flex growth) read as missing data.
  if (!geo || geo.empty)
    return <div ref={ref} className={className} data-unmeasured="" />;

  const socSeries =
    props.variant === "stacked-areas" && props.socVisible !== false
      ? props.chartData.series.filter((s) => s.seriesType === "soc")
      : [];
  const socLine =
    props.variant === "lines"
      ? props.chartData.batterySOC
      : (socSeries.find((s) => s.description.includes("(Avg)"))?.data ??
        socSeries.find((s) => !s.description.includes("("))?.data ??
        null);
  const socMin =
    props.variant === "lines"
      ? (props.paddedSOCData?.min ?? null)
      : (socSeries.find((s) => s.description.includes("(Min)"))?.data ?? null);
  const socMax =
    props.variant === "lines"
      ? (props.paddedSOCData?.max ?? null)
      : (socSeries.find((s) => s.description.includes("(Max)"))?.data ?? null);
  const socTimestamps =
    props.variant === "lines" && props.paddedSOCData
      ? props.paddedSOCData.timestamps
      : timestamps;

  const bars = isEnergy
    ? barLayout(
        geo.plot.width,
        timestamps.length,
        props.variant === "lines" ? series.length : 1,
        props.variant === "lines" ? 0.8 : 0.95,
        props.variant === "lines" ? 0.9 : 0.95,
        barSpans &&
          ((i) => ({
            x0: geo.x(barSpans[i].start),
            x1: geo.x(barSpans[i].end),
          })),
      )
    : null;

  // On bars the focused instant is the bucket's START — i.e. the column's LEFT EDGE — so the
  // crosshair is drawn through the middle of the category instead. Resolved the same way the pointer
  // resolves it (containment for uneven spans, position for equal ones) so the line lands on the bar
  // the reader actually hit.
  const focusIndex =
    bars && hoveredTimestamp
      ? barSpans
        ? indexForSpan(barSpans, hoveredTimestamp.getTime())
        : nearestIndexForTime(timestamps, hoveredTimestamp.getTime())
      : null;
  const focusPx =
    bars && focusIndex !== null ? bars.center(focusIndex) : undefined;

  const socBand =
    socMin && socMax
      ? bandPath(socTimestamps, socMin, socMax, geo.x, geo.y1!)
      : null;

  // Hoisted out of the JSX so the run overlay can re-use each band's own area path — the overlay IS
  // a slice of the band, so re-deriving it would be a second source of truth for the same geometry.
  // Areas only: in energy mode the stack is daily bars, and a sub-daily run has nothing to bracket.
  const stacked =
    props.variant === "stacked-areas" && !isEnergy
      ? stackedBands(timestamps, series, geo.x, geo.y)
      : null;

  // Every drawable run, laid out ONCE: the overlay draws from this list and the touch tap resolves
  // against it, so what you see and what you can tap are the same geometry.
  const runLayout = (() => {
    if (!stacked || props.variant !== "stacked-areas" || !props.runBands)
      return [];
    const bandIndex = new Map(stacked.map((b, i) => [b.key, i]));
    const num = (v: number | null | undefined) =>
      v != null && Number.isFinite(v) ? v : 0;
    return props.runBands.flatMap((run, i) => {
      const k = bandIndex.get(run.seriesId);
      if (k === undefined) return [];
      const band = stacked[k];
      if (!band.d) return [];
      // Snap out to the foot of the band's own ramp so the outline traces the rise and fall rather
      // than cutting across them — see `snapToBandEdges`.
      const span = snapToBandEdges(
        run.startMs,
        run.endMs,
        timestamps,
        series[k].values,
      );
      const x0 = geo.x(new Date(span.startMs));
      const x1 = geo.x(new Date(span.endMs));
      // Sub-pixel runs are dropped rather than drawn: an invisible band that still answers the
      // pointer reads as a phantom tooltip.
      if (!(x1 - x0 >= 1)) return [];
      // The band's vertical extent over the run — its stack floor and ceiling, in the same order
      // `stackedBands` stacks them (`stackOrderNone`: series order, bottom up).
      let lo = Infinity;
      let hi = -Infinity;
      timestamps.forEach((t, ti) => {
        const ms = t.getTime();
        if (ms < span.startMs || ms > span.endMs) return;
        let floor = 0;
        for (let j = 0; j < k; j++) floor += num(series[j].values[ti]);
        const ceil = floor + num(series[k].values[ti]);
        lo = Math.min(lo, floor, ceil);
        hi = Math.max(hi, floor, ceil);
      });
      if (!Number.isFinite(lo)) return [];
      const box: RunHitBox = {
        id: run.id,
        x0,
        x1,
        yTop: Math.min(geo.y(hi), geo.y(lo)),
        yBottom: Math.max(geo.y(hi), geo.y(lo)),
      };
      // `x0`/`x1` are plot-relative (they come from the translated group), so adding the plot's own
      // offset puts them in the chart's box — the box the panel is positioned inside. No
      // measurement, nothing to go stale.
      const anchor: RunTooltipAnchor = {
        x0: geo.plot.left + x0,
        x1: geo.plot.left + x1,
        yTop: geo.plot.top + box.yTop,
        yBottom: geo.plot.top + box.yBottom,
        plot: {
          left: geo.plot.left,
          top: geo.plot.top,
          width: geo.plot.width,
          height: geo.plot.height,
        },
        boxWidth: size.width,
      };
      return [{ run, index: i, d: band.d, x0, x1, box, anchor }];
    });
  })();

  /**
   * A TOUCH tap, resolved against the runs by geometry rather than by the slice's own `click`.
   *
   * 🛑 iOS Safari drops the synthetic `click` when the tap's own touch-start changed what is on
   * screen — it reads the tap as a "hover" — and `pointerdown` here always moves the crosshair
   * (and with it the energy table and the focused Sankey) unless it lands on the index already
   * focused. So a run's `onClick` fired only on the rare tap that did not move the crosshair. Going
   * through `pointerup` sidesteps the heuristic, and the geometric test is what lets a two-pixel
   * charge session have a fingertip-sized target (`hitTestRuns`).
   */
  /**
   * Which axis-tap zone a touch is in, or null for anywhere in the plot (and for every mouse).
   * Two shapes, one meaning. Below the plot's baseline, left half steps older and right half newer —
   * half the chart wide by {@link AXIS_TAP_HEIGHT} tall, which is the whole strip. And the GUTTERS
   * either side of the plot (the y-axis label columns), at any height: "tap to the left of the
   * chart" is where a thumb goes first, and all a tap there used to do was snap the crosshair to
   * the first or last sample. A DRAG that starts in a gutter is still a scrub — see `onPointerMove`.
   */
  const axisTapZone = (
    e: React.PointerEvent<SVGSVGElement>,
  ): "older" | "newer" | null => {
    if (!axisTap || e.pointerType !== "touch") return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - geo.plot.left;
    if (x < 0) return "older";
    if (x > geo.plot.width) return "newer";
    if (e.clientY - rect.top - geo.plot.top < geo.plot.height) return null;
    return x < geo.plot.width / 2 ? "older" : "newer";
  };

  /**
   * Stepping the window is DELIVERED by `click`, not by the `pointerup` beside it — while the
   * decision (which zone, and was it a tap rather than a scrub) is still made from the pointer
   * pair, recorded here at `pointerdown` and read back when the click lands.
   *
   * 🛑 `pointerup` could not be relied on for the delivery. Two ways it goes missing, both silent,
   * and the stacked chart is exposed to both where the lines chart is not:
   *
   *  - Touch gets IMPLICIT POINTER CAPTURE on the `pointerdown` target — here a `TimeAxis` tick
   *    `<text>` inside the strip. The stacked card re-renders constantly while a finger is down
   *    (run-period queries, `useSettledWindow`, the hover arbitration), and a replaced node takes
   *    the `pointerup` with it: it is dispatched at something detached and never reaches the svg.
   *    A `click` is dispatched at the nearest common ancestor of the two targets instead, so it
   *    still arrives.
   *  - The svg carries `touch-action: pan-y`, so a tap that drifts vertically on a page you have
   *    just been scrolling can be claimed as a scroll: `pointercancel` fires and the `pointerup`
   *    never comes. That is ALSO why `pointercancel` deliberately does not clear
   *    {@link axisTapRef} — if the browser really did take the gesture as a scroll there is no
   *    click either, and if a click does arrive the gesture was a tap after all.
   *
   * The `TAP_SLOP` travel test is kept, measured from the recorded start to where the click lands:
   * scrubbing along the strip must not step the window on release.
   */
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const start = axisTapRef.current;
    axisTapRef.current = null;
    if (!start) return; // not a touch, or the touch began in the plot
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) return;
    // Inert at the latest window, exactly as the `>` button is disabled there — and says so.
    const blocked = start.zone === "newer" && props.canGoNewer === false;
    setTapFlash((prev) => ({
      zone: start.zone,
      blocked,
      key: (prev?.key ?? 0) + 1,
    }));
    if (!blocked) axisTap?.(start.zone);
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const zone = axisTapZone(e);
    axisTapRef.current = zone ? { x: e.clientX, y: e.clientY, zone } : null;
    tapStartRef.current =
      e.pointerType === "touch"
        ? { id: e.pointerId, x: e.clientX, y: e.clientY, zone }
        : null;
    // A tap meant for the axis reports no hover: the crosshair (and with it the energy table and
    // the Sankey) must not jump to wherever the finger happened to land while stepping the window.
    if (zone) return;
    pointer.onPointerDown(e);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const start = tapStartRef.current;
    if (start?.zone) {
      // A finger that set off from a gutter and has travelled INTO the plot is scrubbing, and gets
      // its crosshair; `onClick`'s slop test then declines the step. Along the strip it never does.
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left - geo.plot.left;
      const y = e.clientY - rect.top - geo.plot.top;
      const inPlot = x >= 0 && x <= geo.plot.width && y < geo.plot.height;
      const travelled =
        Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP;
      if (!(inPlot && travelled)) return;
    }
    pointer.onPointerMove(e);
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const start = tapStartRef.current;
    tapStartRef.current = null;
    if (!start || start.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) return;
    // An axis tap is the `click` handler's, not this one's — it must not also hit-test runs on the
    // way past, and the two must never both fire.
    if (start.zone) return;
    if (props.variant !== "stacked-areas") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const id = hitTestRuns(
      runLayout.map((r) => r.box),
      e.clientX - rect.left - geo.plot.left,
      e.clientY - rect.top - geo.plot.top,
    );
    const hit = id ? runLayout.find((r) => r.run.id === id) : undefined;
    if (hit) props.onToggleRun?.(hit.run, hit.anchor);
    else props.onTapOutsideRun?.();
  };

  return (
    <div ref={ref} className={className}>
      <svg
        width={size.width}
        height={size.height}
        data-testid={`dashboard-chart-${props.variant}`}
        // `touch-pan-y`: the browser keeps VERTICAL panning (you must still be able to scroll the
        // page with a finger that happens to land on a chart), but horizontal drags are ours —
        // scrubbing the crosshair along the time axis is exactly a horizontal drag. Without this the
        // browser claims the gesture as a sideways scroll and the crosshair never moves, which reads
        // as the chart ignoring you.
        className="max-w-full touch-pan-y"
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (tapStartRef.current = null)}
        onPointerLeave={pointer.onPointerLeave}
      >
        <g transform={`translate(${geo.plot.left}, ${geo.plot.top})`}>
          <ShadingBands
            bands={buildShadingBands(timeRange, windowStart, windowEnd)}
            x={geo.x}
            plotHeight={geo.plot.height}
          />
          <TimeAxis
            ticks={buildTimeTicks(
              timeRange,
              windowStart,
              windowEnd,
              geo.plot.width,
            )}
            x={geo.x}
            plotHeight={geo.plot.height}
            align={timeRange === "D" ? "center" : "start"}
          />
          {/* 🛑 The affordance, not decoration. Tapping the axis to step the window is invisible
              without something drawn there — the reader has to be told the two halves of the strip
              do anything at all. Below the two label lines, at the ends, faint enough not to
              compete with the data; the `›` dims to near-nothing at the latest window, the same
              fact the `>` button expresses by being disabled. `pointerEvents="none"`: the tap is
              hit-tested against the strip's geometry, so the glyph must not eat it. */}
          {axisTap && (
            <g
              data-testid="axis-tap-hints"
              pointerEvents="none"
              fill={CHART_INK.tickText}
              fontSize={CHART_INK.fontSize + 3}
              fontFamily={CHART_INK.fontFamily}
            >
              <text
                x={2}
                y={geo.plot.height + AXIS_TAP_HEIGHT - 6}
                fillOpacity={0.55}
              >
                ‹
              </text>
              <text
                x={geo.plot.width - 2}
                y={geo.plot.height + AXIS_TAP_HEIGHT - 6}
                textAnchor="end"
                fillOpacity={props.canGoNewer === false ? 0.18 : 0.55}
              >
                ›
              </text>
            </g>
          )}
          <ValueAxis
            scale={geo.y}
            plotWidth={geo.plot.width}
            side="left"
            unit={isEnergy ? "kWh" : "kW"}
          />
          <ValueAxis
            scale={geo.y1!}
            plotWidth={geo.plot.width}
            side="right"
            unit="%"
            // The load chart hides its SoC axis but keeps the layout, as it always has.
            hidden={props.variant === "stacked-areas" && props.mode === "load"}
          />

          {/* The SoC min/max band sits behind everything — it is context, not a reading. */}
          {socBand && (
            <path
              d={socBand}
              fill={CHART_COLORS.battery.socRange}
              stroke="none"
            />
          )}

          {/* Series. Bars in energy mode, otherwise stacked areas or overlaid lines. */}
          {isEnergy && bars
            ? series.map((s, si) =>
                timestamps.map((_, i) => {
                  const v = s.values[i];
                  if (v == null || !Number.isFinite(v)) return null;
                  // Stacked bars accumulate; grouped bars sit side by side.
                  const base =
                    props.variant === "stacked-areas"
                      ? series.slice(0, si).reduce((sum, o) => {
                          const ov = o.values[i];
                          return (
                            sum + (ov != null && Number.isFinite(ov) ? ov : 0)
                          );
                        }, 0)
                      : 0;
                  const y0 = geo.y(base);
                  const y1 = geo.y(base + v);
                  return (
                    <rect
                      key={`${s.key}-${i}`}
                      x={bars.x(i, props.variant === "lines" ? si : 0)}
                      y={Math.min(y0, y1)}
                      width={bars.width(i)}
                      height={Math.abs(y1 - y0)}
                      fill={s.colour}
                      data-series={s.key}
                    />
                  );
                }),
              )
            : stacked
              ? stacked.map((band, i) => (
                  // Fill and stroke are SEPARATE paths. Stroking the filled area would stroke its
                  // closed outline — baseline included — which is not what Chart.js drew.
                  <g key={band.key} data-series={band.key}>
                    {band.d && (
                      <path d={band.d} fill={series[i].colour} stroke="none" />
                    )}
                    {band.topD && (
                      <path
                        d={band.topD}
                        fill="none"
                        stroke={series[i].colour}
                        strokeWidth={CHART_INK.bandEdgeStroke}
                      />
                    )}
                  </g>
                ))
              : series.map((s) => {
                  const d = linePath(timestamps, s.values, geo.x, geo.y);
                  return d ? (
                    <path
                      key={s.key}
                      d={d}
                      fill="none"
                      stroke={s.colour}
                      strokeWidth={CHART_INK.seriesStroke}
                      data-series={s.key}
                    />
                  ) : null;
                })}

          {/* Run periods, bracketed on their own band. Above the series (it darkens them) and below
              the focus line (a crosshair the overlay could hide would be worse than one it crosses).

              THE OUTLINE IS TWO CLIPS, MUTUALLY. The slice's top and bottom edges come from stroking
              the band's own closed area path clipped to the run's x-range; its LEFT and RIGHT edges
              come from stroking a full-height rect clipped to the band. Neither alone is a closed
              shape — a clip cuts a stroke, it does not add one where the cut fell — so a single
              clipped path would draw a run with no ends, and a single rect would draw a box around
              the band rather than a slice of it.

              This is the one place the "🛑 never stroke `d`" rule in lib/charts/svg/paths.ts does not
              apply, and for the reason that rule gives: stroking `d` draws the baseline too. Here the
              baseline IS the slice's bottom edge, which is exactly what is wanted. */}
          {props.variant === "stacked-areas" && runLayout.length > 0
            ? (() => {
                const stripeId = `${clipPrefix}-stripe`;
                const stripeHoverId = `${clipPrefix}-stripe-hover`;
                return (
                  <g data-testid="run-bands">
                    {/* One pair of patterns for the whole chart, not one per run, so the texture is
                        continuous across every run drawn on it.

                        `patternUnits="userSpaceOnUse"` rather than the `objectBoundingBox` default:
                        the pitch has to be a fixed number of PIXELS. As a fraction of each run's own
                        box, a three-hour session and a ten-minute one would carry visibly different
                        textures. The tile is painted only where the rect is, so the other half is
                        fully transparent rather than a lighter wash. */}
                    <defs>
                      {[
                        [stripeId, RUN_FILL],
                        [stripeHoverId, RUN_FILL_HOVER],
                      ].map(([id, fill]) => (
                        <pattern
                          key={id}
                          id={id}
                          width={RUN_STRIPE_TILE}
                          height={RUN_STRIPE_TILE}
                          patternUnits="userSpaceOnUse"
                          patternTransform="rotate(45)"
                        >
                          <rect
                            width={RUN_STRIPE_WIDTH}
                            height={RUN_STRIPE_TILE}
                            fill={fill}
                          />
                        </pattern>
                      ))}
                    </defs>
                    {runLayout.map(({ run, index: i, d, x0, x1, anchor }) => {
                      const hovered = props.hoveredRunId === run.id;
                      // A run id is `<series>:<ISO start>`, so it carries `/`, `:` and `.` — all of
                      // which are legal in an XML id but ambiguous inside a `url(#…)` fragment.
                      // Index rather than sanitise: the ids are internal and need only be unique.
                      const rectId = `${clipPrefix}-rect-${i}`;
                      const bandId = `${clipPrefix}-band-${i}`;
                      return (
                        <g
                          key={run.id}
                          data-run={run.id}
                          style={{ cursor: "pointer" }}
                          // MOUSE ONLY. Touch taps are resolved by the svg's `onPointerUp` instead
                          // (see there for why a touch `click` cannot be relied on); binding the click
                          // on touch too would toggle the run twice whenever iOS did deliver one.
                          //
                          // Click PINS; hover PREVIEWS. Whether a preview is allowed to displace what
                          // is already showing is the card's call, not this chart's. The click is
                          // deliberately NOT stopped from propagating: a run is a region of this
                          // chart, so the shared crosshair should follow it too.
                          {...(isTouch
                            ? {}
                            : {
                                onClick: () => props.onToggleRun?.(run, anchor),
                                onPointerEnter: () =>
                                  props.onHoverRun?.(run, anchor),
                                onPointerLeave: () => props.onHoverRun?.(null),
                              })}
                        >
                          <defs>
                            <clipPath id={rectId}>
                              <rect
                                x={x0}
                                y={0}
                                width={x1 - x0}
                                height={geo.plot.height}
                              />
                            </clipPath>
                            <clipPath id={bandId}>
                              <path d={d} />
                            </clipPath>
                          </defs>
                          <path
                            d={d}
                            clipPath={`url(#${rectId})`}
                            fill={`url(#${hovered ? stripeHoverId : stripeId})`}
                            stroke="none"
                          />
                          <path
                            d={d}
                            clipPath={`url(#${rectId})`}
                            fill="none"
                            stroke={hovered ? RUN_EDGE_HOVER : RUN_EDGE}
                            strokeWidth={hovered ? 1.5 : 1}
                            pointerEvents="none"
                          />
                          <rect
                            x={x0}
                            y={0}
                            width={x1 - x0}
                            height={geo.plot.height}
                            clipPath={`url(#${bandId})`}
                            fill="none"
                            stroke={hovered ? RUN_EDGE_HOVER : RUN_EDGE}
                            strokeWidth={hovered ? 1.5 : 1}
                            pointerEvents="none"
                          />
                        </g>
                      );
                    })}
                  </g>
                );
              })()
            : null}

          {/* SoC on the right axis, dashed so it stays distinct from battery power, which shares its
              colour by design (Stage 3c). */}
          {(() => {
            if (!socLine) return null;
            const d = linePath(timestamps, socLine, geo.x, geo.y1!);
            return d ? (
              <path
                d={d}
                fill="none"
                stroke={CHART_COLORS.battery.soc}
                strokeWidth={CHART_INK.seriesStroke}
                strokeDasharray={SOC_DASH.join(" ")}
                data-series="soc"
              />
            ) : null;
          })()}

          <FocusLine
            at={hoveredTimestamp}
            x={geo.x}
            plotHeight={geo.plot.height}
            xPx={focusPx}
          />
          {/* The axis-tap badge: a translucent disc carrying `‹`, `›` or an X, hard against the edge
              of the chart on the side the tap was for. The plot's own `<g>` is offset by
              `plot.left`, hence the subtraction to get back to the svg's edges. */}
          {tapFlash && (
            <g
              key={tapFlash.key}
              data-testid="axis-tap-flash"
              data-kind={tapFlash.blocked ? "blocked" : tapFlash.zone}
              pointerEvents="none"
              transform={`translate(${
                tapFlash.zone === "newer"
                  ? size.width -
                    geo.plot.left -
                    TAP_FLASH_RADIUS -
                    TAP_FLASH_INSET
                  : TAP_FLASH_RADIUS + TAP_FLASH_INSET - geo.plot.left
              } ${geo.plot.height / 2})`}
            >
              <g className="axis-tap-flash">
                <circle
                  r={TAP_FLASH_RADIUS}
                  fill="rgba(255, 255, 255, 0.16)"
                  stroke="rgba(255, 255, 255, 0.35)"
                />
                <path
                  d={
                    tapFlash.blocked
                      ? "M-10 -10 L10 10 M10 -10 L-10 10"
                      : tapFlash.zone === "older"
                        ? "M5 -12 L-7 0 L5 12"
                        : "M-5 -12 L7 0 L-5 12"
                  }
                  stroke="rgba(255, 255, 255, 0.9)"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </g>
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}
