/**
 * Day × time-of-day bucketing for the heatmap.
 *
 * Pure and dependency-free so it can be unit-tested: `components/HeatmapChart.tsx` is a client module
 * that pulls in Chart.js and `chartjs-chart-matrix`, so Jest cannot import it. Without this split, the
 * code deciding which reading lands in which cell would have no coverage at all.
 *
 * ## One offset for the whole grid — the "frame"
 *
 * This used to bucket with `fromDate(ts, ianaZone)`, the DST-aware zone, against a hardcoded 48 ×
 * half-hour grid. A local day has 46 or 50 half-hour slots across a DST boundary, so:
 *
 *  - **fall-back**: two distinct UTC intervals produced the same `HH:mm` key and the second silently
 *    overwrote the first. An hour of real data vanished, once a year, with no indication.
 *  - **spring-forward**: 02:00/02:30 never occurred, so those cells rendered as the no-data grey —
 *    a gap that was never a gap.
 *
 * The fix is to bucket every row against a SINGLE fixed offset, so every day is exactly 48 slots and
 * both defects dissolve rather than being special-cased.
 *
 * ## Why that frame is the most recent day's offset, not standard time
 *
 * The obvious choice was the area's `day_offset_min` (always standard time), which would also keep
 * the day rows aligned with `point_readings_agg_1d`. It was tried and rejected on measurement: with a
 * standard-time frame, **every row of a midsummer window is off-frame** (30/30), so the asterisk that
 * marks off-frame rows fires on everything and stops meaning anything.
 *
 * Anchoring the frame to the newest day instead marks 0/30 in midsummer, 0/30 in midwinter, and only
 * ~11/30 for a window actually spanning a transition — which is what the mark is for. It also means
 * the columns match the wall clock the reader last experienced.
 *
 * The trade is that day boundaries follow the display offset rather than `day_offset_min` while DST
 * is in effect. That is acceptable *here specifically* because the heatmap never displays a daily
 * total — it is a time-of-day pattern view — so nothing in it is ever compared against `agg_1d`.
 * Do not copy this reasoning to a chart that does show daily figures.
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

/**
 * The offset the whole grid is bucketed and labelled in: whatever the site was really on for the
 * newest reading. Falls back to `fallbackOffsetMin` (the area's fixed day offset) if the zone is
 * unusable, so a bad `display_timezone` degrades to standard time rather than breaking the chart.
 */
export function resolveFrameOffsetMin(
  lastReadingMs: number,
  ianaZone: string,
  fallbackOffsetMin: number,
): number {
  const actual = offsetMinAt(new Date(lastReadingMs).toISOString(), ianaZone);
  return actual ?? fallbackOffsetMin;
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
    /** The single offset every row is bucketed in — see {@link resolveFrameOffsetMin}. */
    frameOffsetMin: number;
  },
): BucketedHeatmap {
  const { firstIntervalEndMs, intervalMs, frameOffsetMin } = opts;
  const timeLabels = buildTimeLabels();

  const byDay = new Map<string, Map<string, number | null>>();
  values.forEach((value, i) => {
    const intervalStartMs = firstIntervalEndMs + i * intervalMs - intervalMs;
    const dayKey = dayKeyAt(intervalStartMs, frameOffsetMin);
    const slotKey = slotKeyAt(intervalStartMs, frameOffsetMin);
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
 * Every column means the frame offset for every row. On a day the site was really on a different
 * offset, the wall clock read an hour out from what the column says — so those rows are marked and
 * the chart footnotes what the mark means. Returns a Set of `YYYY-MM-DD` keys.
 *
 * With the frame anchored to the newest day (see the module doc) this is empty for any window that
 * does not span a transition, which is what keeps the mark meaningful.
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
