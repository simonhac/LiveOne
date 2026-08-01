/**
 * Day × time-of-day bucketing for the heatmap.
 *
 * Pure and dependency-free so it can be unit-tested: `components/HeatmapChart.tsx` is a client module
 * that pulls in Chart.js and `chartjs-chart-matrix`, so Jest cannot import it, and the heatmap has no
 * screenshot baseline. Without this split, the code deciding which reading lands in which cell would
 * have no coverage at all.
 *
 * ## Why the fixed offset, not the IANA zone
 *
 * This used to bucket with `fromDate(ts, ianaZone)` — the DST-aware *display* zone — against a
 * hardcoded 48 × half-hour grid. A local day has 46 or 50 half-hour slots across a DST boundary, so:
 *
 *  - **fall-back**: two distinct UTC intervals produced the same `HH:mm` key and the second silently
 *    overwrote the first. An hour of real data vanished, once a year, with no indication.
 *  - **spring-forward**: 02:00/02:30 never occurred, so those cells rendered as the no-data grey —
 *    a gap that was never a gap.
 *
 * Bucketing by the area's FIXED offset (`areas.day_offset_min`) makes every day exactly 48 slots, so
 * both defects dissolve rather than being special-cased — and the heatmap's day rows finally agree
 * with `point_readings_agg_1d`, the Sankey and the daily stripe, all of which have always used the
 * fixed offset. See docs/architecture/data-model.md → "Time: fixed-offset days".
 *
 * The visible cost is that a routine appears to shift by an hour across a DST boundary, because
 * relative to standard time it genuinely does. {@link daysOffFrame} marks those rows so the chart can
 * say so rather than letting the reader assume their habits changed.
 */

export const SLOTS_PER_DAY = 48;
const MIN_MS = 60 * 1000;

/** `HH:mm` labels for a 48-slot day: 00:00, 00:30, … 23:30. Stable, because every day has 48. */
export function buildTimeLabels(): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    out.push(`${String(h).padStart(2, "0")}:00`);
    out.push(`${String(h).padStart(2, "0")}:30`);
  }
  return out;
}

/** Shift a UTC instant into the fixed-offset local frame, so UTC getters read as local wall clock. */
function toFixedLocal(utcMs: number, offsetMin: number): Date {
  return new Date(utcMs + offsetMin * MIN_MS);
}

/** `YYYY-MM-DD` for an instant in the fixed-offset frame. */
export function dayKeyAt(utcMs: number, offsetMin: number): string {
  const d = toFixedLocal(utcMs, offsetMin);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** `HH:mm` half-hour slot for an instant in the fixed-offset frame. */
export function slotKeyAt(utcMs: number, offsetMin: number): string {
  const d = toFixedLocal(utcMs, offsetMin);
  const mins = d.getUTCMinutes() < 30 ? "00" : "30";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${mins}`;
}

export interface HeatmapCell {
  /** Time of day, `HH:mm`. */
  x: string;
  /** Date, `YYYY-MM-DD`. */
  y: string;
  v: number | null;
}

export interface BucketedHeatmap {
  cells: HeatmapCell[];
  /** Date keys, most recent first (the row order the chart draws). */
  dayKeys: string[];
  timeLabels: string[];
  min: number;
  max: number;
}

/**
 * Bucket a dense reading series into the day × slot grid.
 *
 * `firstIntervalEndMs` is the END of the first interval (what `/api/history` reports), and each value
 * is placed by its interval START — so the 00:00–00:30 reading lands in the 00:00 column.
 */
export function bucketHeatmap(
  values: readonly (number | null)[],
  opts: {
    firstIntervalEndMs: number;
    intervalMs: number;
    dayOffsetMin: number;
  },
): BucketedHeatmap {
  const { firstIntervalEndMs, intervalMs, dayOffsetMin } = opts;
  const timeLabels = buildTimeLabels();

  const byDay = new Map<string, Map<string, number | null>>();
  values.forEach((value, i) => {
    const intervalStartMs = firstIntervalEndMs + i * intervalMs - intervalMs;
    const dayKey = dayKeyAt(intervalStartMs, dayOffsetMin);
    const slotKey = slotKeyAt(intervalStartMs, dayOffsetMin);
    let day = byDay.get(dayKey);
    if (!day) {
      day = new Map();
      byDay.set(dayKey, day);
    }
    day.set(slotKey, value);
  });

  const dayKeys = Array.from(byDay.keys()).sort().reverse();

  const cells: HeatmapCell[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const dayKey of dayKeys) {
    const day = byDay.get(dayKey)!;
    for (const slot of timeLabels) {
      const v = day.get(slot) ?? null;
      cells.push({ x: slot, y: dayKey, v });
      if (v !== null) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }

  // All-null series: give the caller a usable, non-infinite domain.
  if (min === Infinity || max === -Infinity) {
    min = 0;
    max = 1;
  }

  return { cells, dayKeys, timeLabels, min, max };
}

/**
 * Which day rows were on a different real UTC offset than the frame the axis is labelled in.
 *
 * With fixed-offset bucketing the columns mean standard time for every row. On a day the site was
 * actually observing DST, the wall clock read an hour later than the column says — so those rows are
 * marked, and the chart footnotes what the mark means. Returns a Set of `YYYY-MM-DD` keys.
 *
 * Days are compared at local midday, deliberately: it is far from any transition instant, so the
 * lookup can never land inside the ambiguous or non-existent hour itself.
 */
export function daysOffFrame(
  dayKeys: readonly string[],
  ianaZone: string,
  frameOffsetMin: number,
): Set<string> {
  const off = new Set<string>();
  for (const key of dayKeys) {
    const actual = offsetMinAt(`${key}T12:00:00Z`, ianaZone);
    if (actual !== null && actual !== frameOffsetMin) off.add(key);
  }
  return off;
}

/**
 * The UTC offset (minutes) an IANA zone was on at a given instant.
 *
 * Derived by formatting the instant in the target zone and differencing against UTC, because
 * `Intl` exposes no offset directly. Returns null if the zone is unusable.
 */
export function offsetMinAt(iso: string, ianaZone: string): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: ianaZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const { type, value } of fmt.formatToParts(at)) p[type] = value;
    // `formatToParts` renders hour 24 for midnight in some engines; normalise before reassembling.
    const hour = p.hour === "24" ? "00" : p.hour;
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(hour),
      Number(p.minute),
      Number(p.second),
    );
    return Math.round((asUtc - at.getTime()) / MIN_MS);
  } catch {
    return null;
  }
}

/** Render a fixed offset as `UTC+10:00` / `UTC-03:30`, for stating which frame the axis is in. */
export function formatUtcOffset(offsetMin: number): string {
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}
