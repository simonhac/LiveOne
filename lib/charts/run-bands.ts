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
 * How far past the enclosing sample a boundary may walk to reach the foot of the band's ramp.
 * A bound on a long slow decline, not a tuning knob — the walk terminates on its own the moment the
 * band stops falling. Four samples is 20 minutes on the D chart.
 */
const MAX_RAMP_SAMPLES = 4;

/**
 * Step outward from `from` while the band is still descending — i.e. to the foot of its ramp.
 *
 * `step` is -1 at the run's start (walking earlier, down the rising edge) and +1 at its end.
 * "Strictly smaller" rather than "is zero" because the band rarely reaches zero in one interval: the
 * last interval of a real session is a PARTIAL AVERAGE, so the descent is 7.2 → 1.5 → 0 and an
 * exact-zero test would never fire on the 1.5. The monotone test needs no threshold and stops by
 * itself — on the flat (0 → 0) and equally on a genuine continuation into a second session, which is
 * what keeps back-to-back runs from swallowing each other.
 *
 * An undefined value stops the walk: a gap BREAKS the drawn band, so a vertical placed there would
 * have nothing to clip against and would leave the outline open on that side.
 */
function walkRamp(
  from: number,
  step: -1 | 1,
  values: readonly (number | null | undefined)[],
): number {
  let i = from;
  for (let n = 0; n < MAX_RAMP_SAMPLES; n++) {
    const here = values[i];
    const next = values[i + step];
    if (here == null || next == null) break;
    if (!(next < here)) break;
    i += step;
  }
  return i;
}

/**
 * Widen `[startMs, endMs]` outward to the foot of the band's own ramp at each end.
 *
 * 🛑 Without this the outline does not trace the band it is outlining. A detector closes a run at
 * its last on-sample (offset by half an interval under `midpoint` boundaries), which lands PART WAY
 * DOWN the band's falling edge — so the overlay's vertical edge cuts through the middle of the
 * shape, leaving a sliver of un-outlined band beside it and reading as a misalignment rather than as
 * the (real) few minutes of difference it is.
 *
 * Two steps. Snapping outward to the enclosing SAMPLES puts each vertical edge on a VERTEX of the
 * drawn band. That is necessary but not sufficient: the vertex it lands on is the band's SHOULDER,
 * and the descent to zero happens over the interval beyond it — so the outline still drops to the
 * axis before the fill does. Walking on down the ramp (`walkRamp`) puts the vertical where the band
 * itself ends, and the top-edge stroke then traces the fall instead of cutting across it.
 *
 * The cost is a few sample intervals of visual width at each end — smaller than the detector's own
 * boundary uncertainty, and it never shrinks the run below what actually happened.
 *
 * Geometry only: the tooltip still reports the run's own figures.
 */
export function snapToBandEdges(
  startMs: number,
  endMs: number,
  timestamps: readonly Date[],
  values?: readonly (number | null | undefined)[],
): { startMs: number; endMs: number } {
  if (timestamps.length === 0) return { startMs, endMs };

  // The last sample at or before the start, and the first at or after the end. -1 means the boundary
  // is outside the grid entirely, and there is no vertex to snap — or to walk — from.
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < timestamps.length; i++) {
    const ms = timestamps[i].getTime();
    if (ms <= startMs) lo = i;
    if (ms >= endMs) {
      hi = i;
      break;
    }
  }

  return {
    startMs:
      lo < 0
        ? startMs
        : timestamps[values ? walkRamp(lo, -1, values) : lo].getTime(),
    endMs:
      hi < 0
        ? endMs
        : timestamps[values ? walkRamp(hi, 1, values) : hi].getTime(),
  };
}

/** The run's renewable share, or null when it can't be stated honestly. */
export function renewablePct(event: RunPeriodEvent): number | null {
  if (event.renewableKwh == null || !event.energyKwh) return null;
  return (event.renewableKwh / event.energyKwh) * 100;
}
