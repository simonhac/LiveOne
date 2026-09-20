"use client";

/**
 * The two hooks every SVG chart needs: measure the container, and turn a pointer into a data index.
 *
 * `useContainerSize` generalises `useContainerWidth` from `components/dashboard/DailyStripes.tsx`
 * (height as well as width, since these charts size both). `DailyStripes` keeps its own copy for now
 * — it is not part of this migration, and rewiring it would put an untested component in the diff
 * for no benefit. Fold it in when it is next touched.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Does this device deliver its pointer by finger? The repo-wide answer to "can the user hover?",
 * and the switch every tap-to-open panel is gated on.
 *
 * `"ontouchstart" in window` rather than a `(hover: none)` media query: it is the test the charts,
 * the Sankey and `playwright.config.ts`'s `mobile` project (`hasTouch: true`) already agree on, so
 * one literal here replaces copies that could drift apart. The known cost is a hybrid touch laptop,
 * which has a working mouse and is nonetheless put into tap-only mode.
 *
 * 🛑 Reads `window`, so it must NOT be called during render — see `useIsTouchDevice` for that. This
 * form is for effects and event callbacks, where the client has definitely mounted.
 */
export function isTouchDevice(): boolean {
  return typeof window !== "undefined" && "ontouchstart" in window;
}

/**
 * `isTouchDevice()` made safe to branch on during RENDER.
 *
 * It reports `false` on the server AND on the first client render, adopting the real answer in a
 * mount effect, so the two renders agree and hydration cannot mismatch. A touch device therefore
 * spends one frame with the desktop bindings attached; nothing can be tapped in that frame, so the
 * only consequence is a single extra re-render (and, in the Sankey, one extra diagram rebuild —
 * the same cost its `isMobile` state already pays).
 */
export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => setIsTouch(isTouchDevice()), []);
  return isTouch;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Observed size of a container element, `{0,0}` until first measurement.
 *
 * Charts must render nothing at `{0,0}` rather than guessing a size: a chart drawn at a placeholder
 * width and then re-drawn is a visible flash, and under the screenshot harness it is a race.
 *
 * 🛑 The flip side is the CALLER's: because zero measures as "draw nothing", a container whose
 * height fails to resolve is a silent blank box, not a visibly broken chart. Do not give a chart
 * root a percentage height (`h-full`) unless every ancestor up to the nearest definite height is
 * itself definite — a box sized by flex growth keeps `height: auto` as its *specified* value, so
 * `height: 100%` inside it resolves to auto, i.e. to the content, i.e. to zero. That is a real bug
 * that shipped (#350: the stacked chart was blank on mobile for two days, and only on mobile,
 * because the desktop `md:flex-row` branch stretches the column and makes the chain definite).
 * `absolute inset-0` inside a `relative` box resolves against the USED height and is immune.
 * The `site-layout-*` gallery case exists to keep that chain covered.
 *
 * 🛑 **A callback ref, not a ref object with a mount effect.** The obvious implementation —
 * `useRef` plus `useLayoutEffect(..., [])` — silently never measures when the element attaches on a
 * LATER render than the first. That is not a corner case: any chart that returns a spinner while its
 * data loads mounts its container on the second render, so the effect has already run against a null
 * ref and will not run again. `HeatmapChart` hit exactly this and rendered an empty box;
 * `ProvenanceChart` has no loading state, which is the only reason it did not.
 *
 * A callback ref runs whenever the node attaches or detaches, so the observer follows the element
 * rather than the mount.
 */
export function useContainerSize<T extends HTMLElement = HTMLDivElement>(): [
  (el: T | null) => void,
  Size,
] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);

  const setNode = useCallback((el: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      // Round: sub-pixel container sizes make scales produce sub-pixel coordinates, which renders as
      // blurry gridlines and (worse) drifts between runs under the screenshot harness.
      // Width FLOORS rather than rounds: a fractional container would round the svg UP past its
      // parent, and one sub-pixel of sideways overflow is all iOS needs to let the page pan.
      const next = { width: Math.floor(r.width), height: Math.round(r.height) };
      setSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observerRef.current = ro;
  }, []);

  // Disconnect if the whole chart unmounts without the ref being called with null first.
  useEffect(() => () => observerRef.current?.disconnect(), []);

  return [setNode, size];
}

/**
 * Nearest index in an ascending `timestamps` array to a pixel x, or null.
 *
 * Binary search rather than the linear scan `nearestIndex` in `ChartFocusContext` uses: this one runs
 * on every `mousemove` across up to 365 points, where that one runs once per focus change.
 */
export function nearestIndexForTime(
  timestamps: readonly Date[],
  targetMs: number,
): number | null {
  const n = timestamps.length;
  if (n === 0) return null;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid].getTime() <= targetMs) lo = mid;
    else hi = mid;
  }
  const dLo = Math.abs(timestamps[lo].getTime() - targetMs);
  const dHi = Math.abs(timestamps[hi].getTime() - targetMs);
  return dHi < dLo ? hi : lo;
}

/**
 * Index of the span CONTAINING `targetMs`, or the nearest one when it falls outside every span.
 *
 * For unevenly-spaced bars (the Y period's calendar months), "nearest bucket START" is the wrong
 * question: a 31-day month's start is further from the pointer than the next month's for the whole
 * back half of the bar, so `nearestIndexForTime` would hand back the bucket the pointer is not over.
 * Containment is what the reader means when they put the pointer on a bar.
 *
 * Spans are assumed ascending and contiguous (`monthBuckets` builds them that way), so the search is
 * the same binary search as above, over `start`, with an end check to catch a hole.
 */
export function indexForSpan(
  spans: readonly { start: Date; end: Date }[],
  targetMs: number,
): number | null {
  const n = spans.length;
  if (n === 0) return null;
  if (targetMs < spans[0].start.getTime()) return 0;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start.getTime() <= targetMs) lo = mid;
    else hi = mid;
  }
  const at = spans[hi].start.getTime() <= targetMs ? hi : lo;
  if (targetMs < spans[at].end.getTime()) return at;
  // Past this span's end: either the window's right edge, or a hole between two spans. Take
  // whichever neighbour's edge is closer, so the pointer never resolves to nothing mid-plot.
  const next = at + 1;
  if (next >= n) return at;
  return targetMs - spans[at].end.getTime() <
    spans[next].start.getTime() - targetMs
    ? at
    : next;
}

/**
 * Index of the equal-width category containing pixel `px`, or null.
 *
 * 🛑 The counterpart to {@link indexForSpan}, and the reason it is needed: with no `barSpans` a bar
 * chart is laid out POSITIONALLY — category `i` occupies the `i`-th equal slice of the plot
 * (`barLayout`'s `evenW` fallback) — while the x SCALE maps the window's instants across the same
 * width. The two agree only when the window is exactly `n` bucket-durations long, which the M period
 * is not: its window carries a partial bucket at one end (and a DST day is 23 or 25 hours), so the
 * scale's answer walks away from the layout's across the month and the neighbouring bar is selected
 * near the edges. Ask the layout where the bars are, not the scale.
 */
export function indexForPosition(
  px: number,
  plotWidth: number,
  categories: number,
): number | null {
  if (categories <= 0 || plotWidth <= 0) return null;
  const i = Math.floor((px * categories) / plotWidth);
  return Math.min(categories - 1, Math.max(0, i));
}

export interface PointerIndexOptions {
  timestamps: readonly Date[];
  /**
   * The span each `timestamps` entry covers, when the categories are unevenly spaced. Given these,
   * the pointer resolves by CONTAINMENT rather than by nearest timestamp — see {@link indexForSpan}.
   */
  spans?: readonly { start: Date; end: Date }[];
  /**
   * Equal-width bar categories: resolve the index by POSITION rather than by time. Set for a bar
   * chart WITHOUT `spans` — see {@link indexForPosition}. Ignored when `spans` is given (those bars
   * are placed on the time scale, so time is the right question).
   */
  positional?: { categories: number; plotWidth: number };
  /** Inverts a pixel x (relative to the plot area) back to an instant. */
  invert: (px: number) => Date;
  /** Left inset of the plot area within the svg. */
  plotLeft: number;
  onChange: (index: number | null) => void;
}

/**
 * Pointer handlers that report the nearest data index.
 *
 * Replaces Chart.js's `interaction: { mode: "index" }` + `onHover(_, activeElements)`, of which the
 * call sites only ever used `activeElements[0].index`.
 *
 * Two behaviours are deliberate and were learned from the Chart.js versions:
 *
 *  - **Deduplicated.** Only a *change* of index is reported. `ProvenanceChart` documents an infinite
 *    render loop without this (hover → setState → redraw → hover re-fires for the same point).
 *  - **Leave is desktop-only.** On a touch device, clearing focus on leave fights tap-to-focus, so
 *    the tap's selection would vanish immediately. Same `"ontouchstart" in window` test the existing
 *    charts use, via `isTouchDevice`.
 *  - **Press reports too**, so a tap registers without a move — see `onPointerDown`. Bind all three.
 */
export function usePointerIndex({
  timestamps,
  spans,
  positional,
  invert,
  plotLeft,
  onChange,
}: PointerIndexOptions) {
  const lastRef = useRef<number | null>(null);

  const report = useCallback(
    (index: number | null) => {
      if (index === lastRef.current) return;
      lastRef.current = index;
      onChange(index);
    },
    [onChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left - plotLeft;
      if (spans) {
        report(indexForSpan(spans, invert(px).getTime()));
      } else if (positional) {
        report(
          indexForPosition(px, positional.plotWidth, positional.categories),
        );
      } else {
        report(nearestIndexForTime(timestamps, invert(px).getTime()));
      }
    },
    [timestamps, spans, positional, invert, plotLeft, report],
  );

  /**
   * The same reading, on press.
   *
   * 🛑 Required for TOUCH, and easy to miss because it is invisible with a mouse. A stationary
   * finger-tap sends `pointerdown` and `pointerup` and NO `pointermove` — so with move as the only
   * listener, tapping a chart set the crosshair only when the finger happened to drag a pixel or two
   * on the way down. It looked like flaky hardware rather than a missing handler. (Verified in the
   * browser: dispatching down+up leaves the focus line absent; one move puts it there.)
   *
   * Harmless with a mouse: the press lands where the pointer already is, so `report`'s dedup drops it.
   */
  const onPointerDown = onPointerMove;

  const onPointerLeave = useCallback(() => {
    if (isTouchDevice()) return;
    report(null);
  }, [report]);

  // A remote clear (a sibling chart taking focus) must reset the dedup guard, or re-entering this
  // chart at the SAME index would be swallowed. ProvenanceChart carries the same warning.
  const resetDedup = useCallback(() => {
    lastRef.current = null;
  }, []);

  useEffect(() => resetDedup, [resetDedup]);

  return { onPointerDown, onPointerMove, onPointerLeave, resetDedup };
}
