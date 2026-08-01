/**
 * Value → palette-position mapping for the heatmap.
 *
 * Split out of `components/HeatmapChart.tsx` so it can be unit-tested: the component is a client
 * module that pulls in Chart.js and `chartjs-chart-matrix`, so Jest cannot import it, and the
 * heatmap has no screenshot baseline yet either. That left this — the arithmetic that decides what
 * colour every cell is — with no coverage of any kind while it was being changed.
 *
 * Deliberately free of d3 and React so it stays importable from a plain node test (the same reason
 * `lib/chart-colors.ts` is kept apart from `lib/heatmap-colors.ts`).
 */

/**
 * Load and source POWER series get a black floor: at or below standby a cell reads as background
 * rather than as the bottom of the colour ramp, so an idle house looks idle. Other metric families
 * (energy, SoC, temperature, price) have no such notion and scale across their full range.
 */
export const POWER_BASELINE_W = 50;

/** Out-of-band result meaning "paint the baseline black" — not a position on the 0–1 ramp. */
export const BLACK_SENTINEL = -1;

/** Where an all-equal series sits on the ramp: the middle, since there is no gradient to express. */
export const FLAT_POSITION = 0.5;

/** True for the `load*`/`source*` `/power` series that {@link POWER_BASELINE_W} applies to. */
export function isBaselinePower(pointPath: string): boolean {
  return (
    (pointPath.startsWith("load") || pointPath.startsWith("source")) &&
    pointPath.endsWith("/power")
  );
}

/**
 * Map `value` onto 0–1 for the palette, or {@link BLACK_SENTINEL}.
 *
 * The span is the REAL `max - lo`. It used to be `Math.max(max - lo, 1)` — nominally a
 * divide-by-zero guard, but the floor silently capped how much of the palette a narrow series could
 * reach: a tank sitting 40.1–40.5 °C only ever got to 0.4 of the gradient and rendered washed out,
 * while the colour legend went on claiming the full min→max range. One clamp, two symptoms (defects
 * #10 and #11 in docs/plans/chart-library-consolidation.md). The degenerate case it was really
 * guarding — every value identical — is handled explicitly instead.
 */
export function normalizeHeatmapValue(
  value: number,
  min: number,
  max: number,
  opts: { baselinePower: boolean },
): number {
  const lo = opts.baselinePower ? POWER_BASELINE_W : min;
  if (opts.baselinePower && value <= POWER_BASELINE_W) return BLACK_SENTINEL;

  const span = max - lo;
  if (span <= 0) return FLAT_POSITION;

  return Math.min(1, Math.max(0, (value - lo) / span));
}

/**
 * The colour domain for a metric: a FIXED range where the metric has one by definition, otherwise
 * the observed min/max.
 *
 * Only `soc` qualifies. State of charge is 0–100 % by definition, and scaling it to the observed
 * range actively misleads: a battery that idled between 60 % and 65 % renders as a full-palette
 * sweep, reading like a dramatic day. Fixing the domain makes that a narrow band in the middle of
 * the ramp, which is the truth, and makes SoC heatmaps comparable across days, points and devices.
 *
 * Everything else keeps observed min/max deliberately. Power and energy are site-dependent, and
 * temperature has no universal band — a hot-water tank and an ambient probe share the metric and
 * nothing else. Fixing those needs a per-POINT range, which is a different feature; see the
 * follow-on note in docs/plans/completed/chart-library-consolidation.md.
 */
export function heatmapDomain(
  metricType: string,
  observedMin: number,
  observedMax: number,
): { min: number; max: number; fixed: boolean } {
  if (metricType === "soc") return { min: 0, max: 100, fixed: true };
  return { min: observedMin, max: observedMax, fixed: false };
}
