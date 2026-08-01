/**
 * Run periods → stacked-band overlays.
 *
 * A run period (an EV charge session, a generator run) is a persisted interval on a device
 * (`derived_intervals`, served by `/api/device/{id}/run-periods`). The stacked site chart already
 * draws that device's power as one band of the stack, so the run can be drawn as a slice OF THAT
 * BAND — the same energy, bracketed in time.
 *
 * This module is the pure half: which runs overlap the rendered window, which series each belongs
 * to, and what x-range it spans. The drawing and hit-testing live in `DashboardChart`.
 *
 * ## Why the clamping matters
 *
 * A run is not aligned to anything the chart knows about. It can start before the window, end after
 * it, or still be open (`endTimeISO: null` — "charging now"). Clamping to the window is what lets
 * the overlay be drawn as a plain clip rectangle rather than needing its own path geometry, and an
 * open run has to be clamped to the window END rather than to the wall clock: the chart's last
 * sample may be minutes behind now, and an overlay extending past the data would sit over empty
 * plot area.
 *
 * The clamp is for GEOMETRY ONLY. The tooltip reports the run's own figures — a session that began
 * before the window still charged what it charged — so `event` is carried through untouched.
 */
import type { RunPeriodEvent } from "@/lib/queries/runPeriods";
import { ROLES, type RoleId } from "@/lib/roles/registry";
import type { SeriesData } from "./types";

export interface RunBand {
  /** Stable across renders: the identity the hover state is held by. */
  id: string;
  /** `SeriesData.id` of the band this run is drawn over. */
  seriesId: string;
  /** Window-clamped span, epoch ms. */
  startMs: number;
  endMs: number;
  /** True when the run is still open — the overlay reaches the window edge but the run does not. */
  running: boolean;
  /** The run itself, UNCLAMPED. Its figures cover the whole run, not the visible slice. */
  event: RunPeriodEvent;
  role: RoleId;
}

/**
 * The visible series a trackable role's runs should be drawn over, or null when this chart has none.
 *
 * Matched on `SeriesData.flowPath` — the canonical flow-matrix node id (`load.ev`) — rather than on
 * the chart's own `id`, which is a display slug and is ambiguous by design (grid export and grid
 * import share one). `flowPathForSeries` resolves it upstream precisely so consumers don't re-derive
 * the mapping.
 */
export function seriesForRole(
  role: RoleId,
  series: readonly SeriesData[],
  visible: ReadonlySet<string>,
): SeriesData | null {
  const path = ROLES[role].device?.chartFlowPath;
  if (!path) return null;
  return series.find((s) => s.flowPath === path && visible.has(s.id)) ?? null;
}

/**
 * Clamp `events` to `[windowStartMs, windowEndMs]` and drop anything that doesn't overlap it.
 *
 * A run that only TOUCHES an edge (ends exactly at the window start) is dropped: it would render as
 * a zero-width band that can be hovered but not seen.
 */
export function runBandsForSeries(
  events: readonly RunPeriodEvent[],
  seriesId: string,
  role: RoleId,
  windowStartMs: number,
  windowEndMs: number,
): RunBand[] {
  const out: RunBand[] = [];
  for (const event of events) {
    if (!event.startTimeISO) continue;
    const rawStart = Date.parse(event.startTimeISO);
    if (!Number.isFinite(rawStart)) continue;
    // An open run has no end; it covers everything up to the window edge.
    const running = event.running === true || event.endTimeISO == null;
    const rawEnd = running ? windowEndMs : Date.parse(event.endTimeISO!);
    if (!Number.isFinite(rawEnd)) continue;

    const startMs = Math.max(rawStart, windowStartMs);
    const endMs = Math.min(rawEnd, windowEndMs);
    if (endMs <= startMs) continue;

    out.push({
      // The run's own start, not the clamped one: scrolling the window must not re-key a band and
      // drop the hover mid-gesture.
      id: `${seriesId}:${event.startTimeISO}`,
      seriesId,
      startMs,
      endMs,
      running,
      event,
      role,
    });
  }
  return out;
}

/**
 * Widen `[startMs, endMs]` outward to the chart's own sample instants.
 *
 * 🛑 Without this the outline does not trace the band it is outlining. A detector closes a run at
 * its last on-sample (offset by half an interval under `midpoint` boundaries), which lands PART WAY
 * DOWN the band's falling edge — so the overlay's vertical edge cuts through the middle of the
 * shape, leaving a sliver of un-outlined band beside it and reading as a misalignment rather than as
 * the (real) few minutes of difference it is.
 *
 * Snapping outward to the enclosing samples puts each vertical edge exactly on a VERTEX of the
 * drawn band, where the silhouette's own rise and fall are, so the outline closes on the shape.
 * The cost is at most one sample interval of visual width at each end — smaller than the detector's
 * own boundary uncertainty, and it never shrinks the run below what actually happened.
 *
 * Geometry only: the tooltip still reports the run's own figures.
 */
export function snapToSamples(
  startMs: number,
  endMs: number,
  timestamps: readonly Date[],
): { startMs: number; endMs: number } {
  if (timestamps.length === 0) return { startMs, endMs };
  let lo = startMs;
  let hi = endMs;
  for (const t of timestamps) {
    const ms = t.getTime();
    if (ms <= startMs) lo = ms;
    if (ms >= endMs) {
      hi = ms;
      break;
    }
  }
  return { startMs: lo, endMs: hi };
}

/** The run's renewable share, or null when it can't be stated honestly. */
export function renewablePct(event: RunPeriodEvent): number | null {
  if (event.renewableKwh == null || !event.energyKwh) return null;
  return (event.renewableKwh / event.energyKwh) * 100;
}
