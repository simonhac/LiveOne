"use client";

/**
 * The two hooks every SVG chart needs: measure the container, and turn a pointer into a data index.
 *
 * `useContainerSize` generalises `useContainerWidth` from `components/dashboard/DailyStripes.tsx`
 * (height as well as width, since these charts size both). `DailyStripes` keeps its own copy for now
 * — it is not part of this migration, and rewiring it would put an untested component in the diff
 * for no benefit. Fold it in when it is next touched.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface Size {
  width: number;
  height: number;
}

/**
 * Observed size of a container element, `{0,0}` until first measurement.
 *
 * Charts must render nothing at `{0,0}` rather than guessing a size: a chart drawn at a placeholder
 * width and then re-drawn is a visible flash, and under the screenshot harness it is a race.
 */
export function useContainerSize<T extends HTMLElement = HTMLDivElement>(): [
  React.RefObject<T | null>,
  Size,
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      // Round: sub-pixel container sizes make scales produce sub-pixel coordinates, which renders as
      // blurry gridlines and (worse) drifts between runs under the screenshot harness.
      const next = { width: Math.round(r.width), height: Math.round(r.height) };
      setSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size];
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

export interface PointerIndexOptions {
  timestamps: readonly Date[];
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
 *    charts use.
 */
export function usePointerIndex({
  timestamps,
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
      report(nearestIndexForTime(timestamps, invert(px).getTime()));
    },
    [timestamps, invert, plotLeft, report],
  );

  const onPointerLeave = useCallback(() => {
    if (typeof window !== "undefined" && "ontouchstart" in window) return;
    report(null);
  }, [report]);

  // A remote clear (a sibling chart taking focus) must reset the dedup guard, or re-entering this
  // chart at the SAME index would be swallowed. ProvenanceChart carries the same warning.
  const resetDedup = useCallback(() => {
    lastRef.current = null;
  }, []);

  useEffect(() => resetDedup, [resetDedup]);

  return { onPointerMove, onPointerLeave, resetDedup };
}
