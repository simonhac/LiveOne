"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The shared "focused instant" for a cluster of charts that share one time window (a dashboard
 * section / one Area: the line chart + the stacked load/generation charts + the Sankey). When the
 * user hovers a point on ANY of them, that chart publishes the instant here; every chart + every
 * {@link TemporalNavigator} in the cluster reads it back, so the navigator labels, the red focus
 * lines, and the Sankey all reflect the same moment — kept in sync regardless of which chart the
 * pointer is over.
 *
 * We share a TIMESTAMP, not a data index: the line chart and the site charts come from different
 * queries (`historyQuery` vs `siteDataQuery`) with independent timestamp arrays, so each chart maps
 * `focusedTime` back to its own nearest index via {@link nearestIndex} when it needs one.
 */
interface ChartFocus {
  /** The instant currently highlighted on any chart in the cluster; null ⇒ nothing focused. */
  focusedTime: Date | null;
  setFocusedTime: (t: Date | null) => void;
}

// Default is a no-op so cards still render outside a provider (graceful degradation: the navigator
// just shows the window range, charts show no shared focus line). Every real host wraps its charts.
const ChartFocusContext = createContext<ChartFocus>({
  focusedTime: null,
  setFocusedTime: () => {},
});

export function ChartFocusProvider({ children }: { children: ReactNode }) {
  const [focusedTime, setFocusedTime] = useState<Date | null>(null);
  const value = useMemo(() => ({ focusedTime, setFocusedTime }), [focusedTime]);
  return (
    <ChartFocusContext.Provider value={value}>
      {children}
    </ChartFocusContext.Provider>
  );
}

export function useChartFocus(): ChartFocus {
  return useContext(ChartFocusContext);
}

/**
 * Index of the timestamp closest to `t` in an ascending `timestamps` array, or null when there's no
 * data / no target. Used by each chart to turn the shared `focusedTime` into its own row index for
 * the red focus line, the energy-table highlight, and the focused-point Sankey.
 */
export function nearestIndex(
  timestamps: readonly Date[] | undefined,
  t: Date | null,
): number | null {
  if (!t || !timestamps || timestamps.length === 0) return null;
  const target = t.getTime();
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const dist = Math.abs(timestamps[i].getTime() - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
