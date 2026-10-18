/**
 * Sigenergy daily ENERGY collector.
 *
 * Turns the statistics endpoint's 5-minute `itemList` (cumulative-since-local-midnight kWh counters)
 * into per-interval energy readings and publishes them as 5m-native aggregates (via the queue → the
 * single-writer receiver). This is the ENERGY path — a daily/hourly batch job — distinct from the
 * live 5-minute POWER poll (`adapter.ts`), which is unchanged.
 *
 * How the numbers are derived (see the plan + `point-metadata.ts` for the full rationale):
 *   - The `itemList` energy fields are cumulative counters sampled at the START of each 5-min interval
 *     (`dataTime`), rounded to 0.01 kWh, reset to 0 at local midnight.
 *   - Interval energy for [dataTime[i], dataTime[i+1]) = counter[i+1] − counter[i], labelled at
 *     `interval_end = dataTime[i+1]` (the app's agg_5m is keyed by interval end).
 *   - Differencing telescopes, so rounding error does NOT accumulate over the day (it stays ≤ one ULP).
 *   - For a COMPLETED day we also emit a final interval whose energy is the residual
 *     `dayTotal − Σ(interval deltas)`, so the day reconstructs to the vendor's reported daily total
 *     EXACTLY. Today (partial) gets no tail and is left un-reconciled until it completes.
 */

import { DateTime } from "luxon";
import { PointManager, type SessionInfo } from "@/lib/point/point-manager";
import type { PollCollector } from "@/lib/observations/poll-collector";
import type { SigenergyClient } from "./sigenergy-client";
import {
  SIGENERGY_ENERGY_POINTS,
  sigenergyIntervalPowerToW,
  type SigenergyEnergyCounterField,
} from "./point-metadata";
import type { SigenergyEnergyInterval, SigenergyEnergyTotals } from "./types";
import {
  deleteDerivedPowerRows,
  deriveDayPowerReadings,
  type VendorPowerSample,
} from "./derive-power";

const FIVE_MIN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A day is meant to reconstruct EXACTLY; warn if a completed day drifts by more than this (Wh).
const RECONCILE_TOLERANCE_WH = 5;

/**
 * Every UTC instant at which the wall clock in `timeZone` reads `dataTime` ("YYYYMMDD HH:MM"),
 * ascending. Usually one; two inside a DST fall-back hour (02:00–02:59 repeats); none inside a
 * spring-forward gap. Returns null on an unparseable string.
 *
 * 🛑 **`dataTime` is the station's CIVIL time, daylight saving included** — it is not at the fixed
 * day offset the rest of the app keys days on. This used to subtract `timezoneOffsetMin` (+600 for
 * Melbourne), which is right for half the year and an hour wrong for the other half: from the
 * 2026-10-04 transition every interval energy row Kutis had — this route is its ONLY source of
 * interval energy — was labelled an hour late, as was every recovered power and SoC sample.
 * Measured on 2026-10-17, |energy×12 − live solar| was 716 W aligned and 92 W shifted by an hour;
 * the raw itemList's `pvTotalPower` against the live poll was 735 W parsed at +10 and 78 W at +11.
 */
export function dataTimeInstantsUtcMs(
  dataTime: string,
  timeZone: string,
): number[] | null {
  const m = dataTime.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const wallMs = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  const offsetMinAt = (ms: number) =>
    DateTime.fromMillis(ms, { zone: timeZone }).offset;
  // A wall time can only be read at an offset the zone actually uses near it. Sample the offsets a
  // day either side (no zone transitions twice in a day) and keep each candidate that round-trips.
  const offsets = new Set([
    offsetMinAt(wallMs - DAY_MS),
    offsetMinAt(wallMs + DAY_MS),
  ]);
  const out: number[] = [];
  for (const off of offsets) {
    const instant = wallMs - off * 60 * 1000;
    if (offsetMinAt(instant) === off) out.push(instant);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Resolve one day's time-ascending `dataTime`s to UTC instants, in order.
 *
 * A wall time read twice in a fall-back hour is the earlier instant the first time it appears and
 * the later one the second, which is exactly "the first candidate after the previous row". So the
 * result is strictly increasing whenever the input is, and `null` only for a time that cannot exist
 * (a spring-forward gap) or does not parse.
 */
export function resolveDataTimes(
  dataTimes: readonly string[],
  timeZone: string,
): (number | null)[] {
  let prev = -Infinity;
  return dataTimes.map((t) => {
    const candidates = dataTimeInstantsUtcMs(t, timeZone);
    const pick = candidates?.find((c) => c > prev) ?? null;
    if (pick != null) prev = pick;
    return pick;
  });
}

/** UTC-ms of local midnight starting the given YYYYMMDD, in `timeZone`. */
function dayStartUtcMs(date: string, timeZone: string): number | null {
  return dataTimeInstantsUtcMs(`${date} 00:00`, timeZone)?.[0] ?? null;
}

/** UTC-ms of midnight starting YYYYMMDD at a FIXED offset — the app's own day boundary. */
function fixedDayStartUtcMs(date: string, tzOffsetMin: number): number {
  return (
    Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) -
    tzOffsetMin * 60 * 1000
  );
}

/** The YYYYMMDD after `date`. */
function nextDay(date: string): string {
  const ms =
    Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) +
    DAY_MS;
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

export type Agg5mReading = {
  pointMetadata: (typeof SIGENERGY_ENERGY_POINTS)[number]["metadata"];
  rawValue: number; // Wh
  intervalEndMs: number;
  dataQuality?: string | null;
};

export interface PullEnergyDayResult {
  date: string;
  intervalsFetched: number;
  readingsWritten: number;
  reconciled: boolean; // true for a completed day (tail residual applied)
  empty: boolean; // no itemList rows (e.g. a pre-go-live day)
  /** Power/SoC rows recovered for intervals the live poll missed (see `derive-power.ts`). */
  derivedWritten: number;
  /** Earlier fill rows deleted first, under `replaceDerived`. */
  derivedReplaced?: number;
  /**
   * The vendor's verbatim `statistics/energy` response, when the caller asked for it.
   *
   * Off by default — it is ~288 itemList rows per day and nothing in the write path needs it. It
   * exists because the differenced output CANNOT answer questions about the input: the counters
   * occasionally drop to ~0 for one sample (see `derive-power.ts`), and whether the vendor SENT
   * that zero or we coerced a non-numeric sentinel into one is not decidable from a stored delta.
   * Reading it back through this field is the only way to look at the actual payload, because
   * `pullEnergyDay` does not archive it (see
   * `docs/plans/sigenergy-counter-dropout-forensics.md`).
   */
  raw?: unknown;
}

/**
 * Difference the `itemList` cumulative counters into per-5-min energy readings (Wh) for all six
 * metrics. PURE (no I/O) so the differencing + tail-reconciliation is unit-testable. `rows` must be
 * the valid, time-ASCENDING intervals for a single local day; `isComplete` enables the residual tail.
 */
export function computeDayEnergyReadings(
  rows: SigenergyEnergyInterval[],
  totals: SigenergyEnergyTotals,
  timeZone: string,
  isComplete: boolean,
  date = "",
): Agg5mReading[] {
  const readings: Agg5mReading[] = [];
  if (rows.length === 0) return readings;
  const instants = resolveDataTimes(
    rows.map((r) => r.dataTime),
    timeZone,
  );

  for (const { counterField, metadata } of SIGENERGY_ENERGY_POINTS) {
    const field: SigenergyEnergyCounterField = counterField;
    let sumWh = 0;

    // Consecutive-sample differences → interval energy, labelled at the later sample's instant.
    for (let i = 0; i < rows.length - 1; i++) {
      const c0 = rows[i][field];
      const c1 = rows[i + 1][field];
      const endMs = instants[i + 1];
      if (c0 == null || c1 == null || endMs == null) continue;
      // SIGNED diff — do NOT clamp to ≥0. On low-volume metrics (e.g. a self-sufficient day's tiny
      // grid import) the 0.01-kWh-rounded counter FLICKERS (…0 → 0.01 → 0 → 0.01…); clamping the −0.01
      // ticks to 0 while keeping the +0.01 ticks systematically inflates the total (grid import came
      // out 37× high). Signed diffs telescope to counter[last]−counter[0] exactly, so flickers cancel
      // and the completed-day tail then reconciles to the vendor total. (No mid-day reset to guard:
      // we fetch one day at a time, so the counter starts at 0 and only grows across the day.)
      const wh = Math.round((c1 - c0) * 1000);
      sumWh += wh;
      readings.push({
        pointMetadata: metadata,
        rawValue: wh,
        intervalEndMs: endMs,
        dataQuality: "good",
      });
    }

    // Completed day: put the residual (dayTotal − Σdeltas) in the final [last, last+5) interval so the
    // day reconstructs to the vendor headline exactly. Skip for today (no authoritative total yet).
    if (isComplete) {
      const lastEndMs = instants[rows.length - 1];
      const total = totals[field];
      if (lastEndMs != null && total != null) {
        const tailWh = Math.round(total * 1000) - sumWh;
        const reconstructed = sumWh + Math.max(0, tailWh);
        if (
          Math.abs(reconstructed - Math.round(total * 1000)) >
          RECONCILE_TOLERANCE_WH
        ) {
          console.warn(
            `[Sigenergy] ${date} ${field}: reconstructed ${reconstructed}Wh vs total ${Math.round(total * 1000)}Wh (tail ${tailWh}Wh)`,
          );
        }
        readings.push({
          pointMetadata: metadata,
          rawValue: Math.max(0, tailWh),
          intervalEndMs: lastEndMs + FIVE_MIN_MS,
          dataQuality: "good",
        });
      }
    }
  }
  return readings;
}

/**
 * The day's rows in time order.
 *
 * Sorted by `dataTime` as a string — EXCEPT on a fall-back day, where 02:00–02:55 appears twice and a
 * string sort would interleave the two hours (02:00, 02:00, 02:05, 02:05 …), leaving no order in
 * which `resolveDataTimes` could tell daylight from standard time. There the vendor's own order,
 * which is chronological, is the only one that means anything, so it is kept.
 */
export function orderedRows<T extends { dataTime: string }>(rows: T[]): T[] {
  const repeats = new Set(rows.map((r) => r.dataTime)).size !== rows.length;
  return repeats
    ? rows
    : [...rows].sort((a, b) => a.dataTime.localeCompare(b.dataTime));
}

/**
 * Fetch one day's statistics and publish its per-interval energy for all six metrics.
 *
 * `now` defaults to the wall clock; injectable for tests. Requires a `session` (5m-native publish is
 * gated on it) and should be given the poll `collector` so the observations flush on session close.
 */
async function pullEnergyDay(params: {
  client: SigenergyClient;
  systemId: number;
  stationId: string;
  date: string; // YYYYMMDD — the vendor's (civil) day
  /** The station's IANA zone, which `dataTime` is written in. */
  timeZone: string;
  /**
   * Only readings whose interval ENDS in `(fromMs, toMs]` are written — the caller's fixed-offset
   * window. A civil day and a fixed-offset day disagree by the DST hour, so one vendor day can
   * straddle two of ours; clipping keeps a fetch from writing a day nobody asked to recompute.
   */
  clip: { fromMs: number; toMs: number };
  session: SessionInfo;
  collector?: PollCollector;
  now?: number;
  /** Return the vendor's verbatim response on the result — diagnostics only. */
  includeRaw?: boolean;
  /** Delete this module's earlier power/SoC fills in the window before re-deriving them. */
  replaceDerived?: boolean;
}): Promise<PullEnergyDayResult> {
  const {
    client,
    systemId,
    stationId,
    date,
    timeZone,
    clip,
    session,
    collector,
  } = params;
  const now = params.now ?? Date.now();

  const day = await client.getEnergyStatistics(stationId, date);
  const rows = orderedRows(
    day.intervals.filter((r) => /^\d{8}\s+\d{2}:\d{2}$/.test(r.dataTime)),
  );

  if (rows.length === 0) {
    return {
      date,
      intervalsFetched: 0,
      readingsWritten: 0,
      reconciled: false,
      empty: true,
      derivedWritten: 0,
    };
  }

  // A day is "complete" once its local midnight-to-midnight window has fully elapsed. Measured to
  // the NEXT midnight, not start + 24 h: a DST day is 23 or 25 hours long.
  const start = dayStartUtcMs(date, timeZone);
  const end = dayStartUtcMs(nextDay(date), timeZone);
  const isComplete = end != null && end <= now;

  const readings = computeDayEnergyReadings(
    rows,
    day.totals,
    timeZone,
    isComplete,
    date,
  );

  // Under `replaceDerived`, clear our earlier fills for exactly the slots this vendor day can
  // rewrite — the day ∩ the caller's window — and only once the vendor has answered, so a failed
  // fetch never leaves a hole where a (wrong) fill used to be. Deleted BEFORE deriving: the derive
  // pass reads the store to find what is missing, and must see these slots as missing.
  let derivedReplaced: number | undefined;
  if (params.replaceDerived && start != null && end != null) {
    derivedReplaced = await deleteDerivedPowerRows(systemId, {
      fromMs: Math.max(start, clip.fromMs),
      toMs: Math.min(end, clip.toMs),
    });
  }

  // Recover the POWER + SoC intervals the live poll missed, from the energy we just differenced.
  // Sigenergy's cloud API serves no historical power, so this pass is the only thing that can close
  // those holes — see `derive-power.ts`. Best-effort by design: it reads the serving store to find
  // out what is missing, and a failed read must not cost us the energy backfill that already
  // succeeded.
  let derived: Awaited<ReturnType<typeof deriveDayPowerReadings>> = [];
  try {
    // The itemList's instantaneous half, keyed the way agg_5m is. `dataTime` is the interval START,
    // so the sample at T belongs to the interval ENDING at T+5min — the same interval our poll's
    // sample would have landed in.
    const vendorPower = new Map<number, VendorPowerSample>();
    const starts = resolveDataTimes(
      rows.map((r) => r.dataTime),
      timeZone,
    );
    rows.forEach((r, i) => {
      const startMs = starts[i];
      if (startMs == null) return;
      vendorPower.set(startMs + FIVE_MIN_MS, sigenergyIntervalPowerToW(r));
    });
    derived = await deriveDayPowerReadings({
      systemId,
      energyReadings: readings,
      vendorPower,
      nowMs: now,
    });
  } catch (err) {
    console.warn(
      `[Sigenergy] ${date}: power/SoC recovery skipped — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Clip AFTER deriving: the counter-deficit guard and the interpolation anchors need the whole day.
  const inClip = (r: { intervalEndMs: number }) =>
    r.intervalEndMs > clip.fromMs && r.intervalEndMs <= clip.toMs;
  const energyOut = readings.filter(inClip);
  const derivedOut = derived.filter(inClip);

  await PointManager.getInstance().insertPointReadingsAgg5m(
    systemId,
    session,
    [...energyOut, ...derivedOut],
    collector,
  );

  return {
    date,
    intervalsFetched: rows.length,
    readingsWritten: energyOut.length,
    reconciled: isComplete,
    empty: false,
    derivedWritten: derivedOut.length,
    ...(derivedReplaced !== undefined ? { derivedReplaced } : {}),
    ...(params.includeRaw ? { raw: day.raw } : {}),
  };
}

/** Inclusive list of YYYYMMDD strings from `startDate` to `endDate` (both YYYYMMDD). */
export function enumerateDays(startDate: string, endDate: string): string[] {
  const toMs = (d: string) =>
    Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return `${y}${mo}${da}`;
  };
  const out: string[] = [];
  for (let ms = toMs(startDate); ms <= toMs(endDate); ms += DAY_MS) {
    out.push(fmt(ms));
  }
  return out;
}

/**
 * Backfill a range of days (inclusive), one statistics call per day. Errors on a single day are
 * collected (not thrown) so one bad day doesn't abort the range.
 *
 * `startDate`/`endDate` name the app's FIXED-offset days (`tzOffsetMin`), which is what every caller
 * means and what `agg_1d` rolls up on. The vendor's days are civil (`timeZone`), so while daylight
 * saving is in force each of our days ends an hour into the vendor's next one — the 23:00–24:00
 * standard-time hour lives in the vendor day after. So the vendor day after `endDate` is fetched too
 * whenever it differs and has begun, and everything is clipped to the requested window.
 */
export async function backfillEnergyRange(params: {
  client: SigenergyClient;
  systemId: number;
  stationId: string;
  startDate: string; // YYYYMMDD, fixed-offset day
  endDate: string; // YYYYMMDD, fixed-offset day
  /** The app's fixed day offset (minutes east of UTC) — the window's day boundaries. */
  tzOffsetMin: number;
  /** The station's IANA zone — what the vendor's `dataTime` is written in. */
  timeZone: string;
  session: SessionInfo;
  collector?: PollCollector;
  now?: number;
  /** Return each day's verbatim vendor response — diagnostics only; see `PullEnergyDayResult.raw`. */
  includeRaw?: boolean;
  /** See `pullEnergyDay`. `liveone sync --replace-derived`. */
  replaceDerived?: boolean;
}): Promise<{
  days: PullEnergyDayResult[];
  errors: string[];
}> {
  const now = params.now ?? Date.now();
  const clip = {
    fromMs: fixedDayStartUtcMs(params.startDate, params.tzOffsetMin),
    toMs: fixedDayStartUtcMs(nextDay(params.endDate), params.tzOffsetMin),
  };
  const dates = enumerateDays(params.startDate, params.endDate);
  // Does the window's last fixed-offset day run past the vendor's midnight? Only then is the next
  // vendor day needed, and only once it has started can it hold anything.
  const after = nextDay(params.endDate);
  const afterStart = dayStartUtcMs(after, params.timeZone);
  if (afterStart != null && afterStart < clip.toMs && afterStart <= now)
    dates.push(after);

  const days: PullEnergyDayResult[] = [];
  const errors: string[] = [];
  for (const date of dates) {
    try {
      days.push(
        await pullEnergyDay({
          client: params.client,
          systemId: params.systemId,
          stationId: params.stationId,
          date,
          timeZone: params.timeZone,
          clip,
          session: params.session,
          collector: params.collector,
          now,
          includeRaw: params.includeRaw,
          replaceDerived: params.replaceDerived,
        }),
      );
    } catch (err) {
      errors.push(
        `${date}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { days, errors };
}
