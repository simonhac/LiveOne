/**
 * Bucketing for the tiles' mini bar charts (docs/architecture/tile-style.md, rule 8) — pure, so the
 * time-axis rules are testable without a DOM.
 *
 * A tile's bars follow the dashboard's temporal navigator, like the Grid tile's period totals, and
 * read the SAME `siteDataQuery` payload the site charts do (deduped on one key), so they cost no
 * request on a section that already draws charts. The period decides the bucket:
 *
 *   D → one bar per local HOUR, ticks at 12 am · 6 am · 12 pm · 6 pm (the Activity app's four)
 *   W → one bar per local DAY, ticks on every day (M T W …)
 *   M → one bar per local DAY, ticks on the 1st, 8th, 15th, 22nd
 *   Y → one bar per local MONTH, ticks on Jan · Apr · Jul · Oct
 *
 * A bar is the MEAN of the finite samples in its bucket — for a power series that is proportional to
 * the bucket's energy, which is the thing a bar should compare. A bucket with no finite sample is
 * `null` (a gap, drawn as nothing), never zero: "no reading" and "nothing generated" are different.
 */
import type { NavigatorPeriod } from "@/lib/charts/temporal";
import { DAY_TICK_HOURS, dayTickLabel } from "@/lib/tile-style";

export interface TileBar {
  /** Mean of the bucket's finite samples, or null when it had none. */
  value: number | null;
  /** A time-axis label drawn at this bar's left edge, when this bar starts a tick. */
  tick?: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Wall-clock fields in a FIXED offset (the subject's own), read via the UTC getters. */
function local(ms: number, tzOffsetMin: number): Date {
  return new Date(ms + tzOffsetMin * 60_000);
}

/** Bucket key (local, monotonic) and the tick for the bucket that key starts. */
function bucketOf(
  ms: number,
  period: NavigatorPeriod,
  tzOffsetMin: number,
): { key: number; tick?: string } {
  const d = local(ms, tzOffsetMin);
  if (period === "D") {
    const hour = d.getUTCHours();
    return {
      key: Math.floor(d.getTime() / HOUR_MS),
      tick: (DAY_TICK_HOURS as readonly number[]).includes(hour)
        ? dayTickLabel(hour)
        : undefined,
    };
  }
  if (period === "Y") {
    const month = d.getUTCMonth();
    return {
      key: d.getUTCFullYear() * 12 + month,
      tick: month % 3 === 0 ? MONTH[month] : undefined,
    };
  }
  const day = Math.floor(d.getTime() / DAY_MS);
  if (period === "W") return { key: day, tick: WEEKDAY[d.getUTCDay()] };
  const dom = d.getUTCDate();
  return {
    key: day,
    tick: [1, 8, 15, 22].includes(dom) ? String(dom) : undefined,
  };
}

/**
 * Bucket a positional series into bars. `timestamps[i]` is the start of `values[i]`'s interval.
 * Buckets run contiguously from the first timestamp's to the last's, so a hole in the middle of the
 * window is an empty bar slot rather than a closed-up axis.
 */
export function bucketBars(
  timestamps: readonly Date[],
  values: readonly (number | null | undefined)[],
  period: NavigatorPeriod,
  tzOffsetMin: number,
): TileBar[] {
  if (timestamps.length === 0) return [];
  const sums = new Map<number, { sum: number; n: number }>();
  const ticks = new Map<number, string | undefined>();
  let first = Infinity;
  let last = -Infinity;
  timestamps.forEach((t, i) => {
    const { key, tick } = bucketOf(t.getTime(), period, tzOffsetMin);
    first = Math.min(first, key);
    last = Math.max(last, key);
    if (!ticks.has(key)) ticks.set(key, tick);
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      const acc = sums.get(key) ?? { sum: 0, n: 0 };
      acc.sum += v;
      acc.n += 1;
      sums.set(key, acc);
    }
  });
  const bars: TileBar[] = [];
  for (let key = first; key <= last; key++) {
    const acc = sums.get(key);
    bars.push({
      value: acc ? acc.sum / acc.n : null,
      tick: ticks.get(key),
    });
  }
  return bars;
}

/**
 * Element-wise sum of several positional series of equal length. An index is null only when EVERY
 * series is null there — one missing child must not blank the total the others still describe.
 */
export function sumSeries(
  series: readonly (readonly (number | null)[])[],
): (number | null)[] {
  const length = Math.max(0, ...series.map((s) => s.length));
  return Array.from({ length }, (_, i) => {
    let total: number | null = null;
    for (const s of series) {
      const v = s[i];
      if (typeof v === "number" && Number.isFinite(v)) total = (total ?? 0) + v;
    }
    return total;
  });
}

/**
 * Tick positions for a continuous 24h line (the hot-water sparkline): the fraction along x of every
 * sample that starts a local 12 am / 6 am / 12 pm / 6 pm hour. Positional — `i / (n − 1)` — to match
 * `sparklineGeometry`'s x mapping.
 */
export function dayTicks(
  timestamps: readonly Date[],
  tzOffsetMin: number,
): { at: number; label: string }[] {
  const n = timestamps.length;
  if (n < 2) return [];
  const out: { at: number; label: string }[] = [];
  timestamps.forEach((t, i) => {
    const d = local(t.getTime(), tzOffsetMin);
    const hour = d.getUTCHours();
    if (
      d.getUTCMinutes() === 0 &&
      (DAY_TICK_HOURS as readonly number[]).includes(hour)
    ) {
      out.push({ at: i / (n - 1), label: dayTickLabel(hour) });
    }
  });
  return out;
}
