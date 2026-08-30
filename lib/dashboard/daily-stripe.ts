/**
 * The pure half of the `daily-stripe` card — config resolution, the
 * fixed-offset local-day window, the OpenNEM → `Map<intervalEndMs, value>` parse, and the colour
 * domain.
 *
 * It lives in lib/ rather than beside the plugin for one concrete reason: jest's `roots` are
 * lib/app/scripts/packages, so anything under components/ is UNTESTABLE by construction (stage 1,
 * finding 2). The plugin (components/dashboard/cards/daily-stripe.tsx) is the thin React shell over
 * these functions plus `<DailyStripes/>`.
 *
 * Server-safe: no React, no DOM, no db.
 */
import {
  dailyStripeConfigSchema,
  DAILY_STRIPE_DEFAULT_PALETTE,
  type DailyStripeConfig,
} from "./card-types";
import { PointInfo } from "@/lib/point/point-info";

export const STRIPE_SLOT_MS = 5 * 60 * 1000;
export const STRIPE_SLOTS_PER_DAY = 288;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The stripe's VERTICAL geometry. It lives here, next to the window maths, because two callers need
 * it and they must not drift: `<DailyStripes/>` sizes its SVG from it, and the card plugin's
 * `footprint` reserves the same space BEFORE any history has arrived — which it can do exactly,
 * because the height is a function of `config.days`, not of the data.
 */
export const STRIPE_AXIS_H = 20;
export const STRIPE_STATE_H = 11;
export const STRIPE_VALUE_H = 32;
export const STRIPE_DAY_GAP = 8;
/** The wrapper's own `sm:p-4` top+bottom. */
export const STRIPE_PADDING_H = 32;

/** The SVG's height: a top axis, then one row per day with a gap between rows. */
export function dailyStripeSvgHeight(
  dayCount: number,
  hasState: boolean,
): number {
  const dayH = (hasState ? STRIPE_STATE_H : 0) + STRIPE_VALUE_H;
  return STRIPE_AXIS_H + dayCount * dayH + (dayCount - 1) * STRIPE_DAY_GAP;
}

/**
 * The whole card's reserved height, from its config alone. `null` config (unparseable — the plugin
 * renders a notice instead) falls back to the schema's own `days: 7` default so the placeholder is
 * still the right order of magnitude.
 */
export function dailyStripeFootprint(config: DailyStripeConfig | null): number {
  return (
    STRIPE_PADDING_H +
    dailyStripeSvgHeight(config?.days ?? 7, config?.state != null)
  );
}

/**
 * Parse a card node's opaque `config` (§8.4) into the resolved shape, with schema defaults applied
 * (`days: 7`, `state.onThreshold: 0`). `null` ⇒ the config does not satisfy the schema, which the
 * doc validator rejects on write but which a doc persisted by another build could still carry — the
 * plugin renders a notice rather than guessing.
 */
export function resolveDailyStripeConfig(
  config: unknown,
): DailyStripeConfig | null {
  const r = dailyStripeConfigSchema.safeParse(config ?? {});
  return r.success ? r.data : null;
}

/** The `logicalPath`'s metric — the part after the `/` (`load.hws/temperature` → `temperature`). */
export function metricOf(logicalPath: string): string {
  const i = logicalPath.indexOf("/");
  return i < 0 ? "" : logicalPath.slice(i + 1);
}

/**
 * The `/api/history` `series` term for one stripe series: the logical path plus its aggregation
 * suffix. The suffix is the config's `agg` when pinned, else the metric's preferred aggregation
 * (energy → delta, soc → last, everything else → avg) — the same rule `HeatmapChart` applies.
 */
export function seriesTermFor(series: {
  logicalPath: string;
  agg?: string;
}): string {
  const agg =
    series.agg ??
    PointInfo.getPreferredAggregationForMetricType(
      metricOf(series.logicalPath),
    );
  return `${series.logicalPath}.${agg}`;
}

export interface DailyStripeWindow {
  /** UTC ms of the oldest local midnight drawn — `DailyStripes`' `firstDayMidnightMs`. */
  firstDayMidnightMs: number;
  /** UTC ms the fetch stops at: `now` floored to a 5m boundary (never ≤ the start). */
  endMs: number;
  dayCount: number;
}

/**
 * The fixed-offset local-day window: `days` local days ending with today-so-far.
 *
 * Fixed offset, not a tz database zone — the same simplification `DailyStripes` bakes in (every real
 * offset is a whole number of 5m slots, so local midnight lands exactly on a slot boundary). The end
 * is capped at `now` and floored to 5m for two reasons: `/api/history` REJECTS an unaligned 5m
 * bound, and the in-progress bucket is future-dated (its `intervalEnd` is in the future), so
 * including it would paint a partial average as a full slot.
 */
export function dailyStripeWindow(
  nowMs: number,
  tzOffsetMin: number,
  days: number,
): DailyStripeWindow {
  const offsetMs = tzOffsetMin * 60_000;
  const todayMidnightMs =
    Math.floor((nowMs + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const firstDayMidnightMs = todayMidnightMs - (days - 1) * DAY_MS;
  const flooredNow = Math.floor(nowMs / STRIPE_SLOT_MS) * STRIPE_SLOT_MS;
  // `startTime < endTime` is a 400 from /api/history, and exactly-at-local-midnight makes them
  // equal for days === 1. One slot is the smallest legal window.
  const endMs = Math.max(flooredNow, firstDayMidnightMs + STRIPE_SLOT_MS);
  return { firstDayMidnightMs, endMs, dayCount: days };
}

/** `"5m"` → 300000. Mirrors `HeatmapChart`'s local parser; 0 for anything unrecognised. */
export function parseIntervalMs(interval: string): number {
  const m = /^(\d+)([smhd])$/.exec(interval);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return (
    n * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] as number)
  );
}

interface OpenNemSeries {
  id?: string;
  path?: string;
  history?: {
    firstInterval?: string;
    interval?: string;
    data?: (number | null)[];
  };
}
interface OpenNemPayload {
  data?: OpenNemSeries[];
}

/**
 * One series out of an OpenNEM `/api/history` payload as `Map<intervalEndMs, value>`.
 *
 * `history.firstInterval` is the END of the first bucket (the whole serving layer keys on interval
 * END), so `intervalEndMs = firstIntervalMs + i * intervalMs` — the same keys `DailyStripes` looks
 * up per slot.
 *
 * 🛑 NULLS ARE SKIPPED, and that is load-bearing rather than tidiness. The served array is DENSE
 * (a gap is a `null` entry), but `DailyStripes` treats "the map has this key" as *the device
 * reported something*: a present slot with a null `state` paints the no-data grey. Keeping the
 * nulls would therefore paint a grey on/off strip straight across every real outage, where the lab
 * page — which reads sparse rows out of the DB — shows the background. Skipping restores that.
 */
export function seriesToMap(
  payload: unknown,
  seriesTerm: string,
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  const series = (payload as OpenNemPayload | null | undefined)?.data?.find(
    (s) => (s.path ?? s.id?.split(".").slice(2).join(".")) === seriesTerm,
  );
  const h = series?.history;
  if (!h?.firstInterval || !h.data) return out;
  const firstMs = new Date(h.firstInterval).getTime();
  const intervalMs = parseIntervalMs(h.interval ?? "");
  if (!Number.isFinite(firstMs) || intervalMs <= 0) return out;
  h.data.forEach((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    out.set(firstMs + i * intervalMs, v);
  });
  return out;
}

/**
 * The colour domain: each end taken from config when pinned, else from the non-null values.
 * With neither pinned and no data at all, `[0, 1]` — a scale that renders rather than a NaN one.
 */
export function resolveDomain(
  values: Map<number, number | null>,
  min?: number,
  max?: number,
): [number, number] {
  if (min !== undefined && max !== undefined) return [min, max];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values.values()) {
    if (v === null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const seen = lo <= hi;
  return [min ?? (seen ? lo : 0), max ?? (seen ? hi : 1)];
}

/** The ramp: the config's pair when set, else the shared default (§"Shared wiring" palette note). */
export function resolvePalette(
  color: DailyStripeConfig["color"],
): [string, string] {
  return color
    ? [color.from, color.to]
    : [DAILY_STRIPE_DEFAULT_PALETTE[0], DAILY_STRIPE_DEFAULT_PALETTE[1]];
}
