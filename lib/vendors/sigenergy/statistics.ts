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

import { PointManager, type SessionInfo } from "@/lib/point/point-manager";
import type { PollCollector } from "@/lib/observations/poll-collector";
import type { SigenergyClient } from "./sigenergy-client";
import {
  SIGENERGY_ENERGY_POINTS,
  type SigenergyEnergyCounterField,
} from "./point-metadata";
import type { SigenergyEnergyInterval, SigenergyEnergyTotals } from "./types";

const FIVE_MIN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A day is meant to reconstruct EXACTLY; warn if a completed day drifts by more than this (Wh).
const RECONCILE_TOLERANCE_WH = 5;

/**
 * Parse a local "YYYYMMDD HH:MM" wall-clock into a UTC epoch-ms instant, given the system's timezone
 * offset (minutes east of UTC — e.g. Melbourne AEST = +600). Returns null on an unparseable string.
 */
export function localDataTimeToUtcMs(
  dataTime: string,
  tzOffsetMin: number,
): number | null {
  const m = dataTime.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const wallMs = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  return wallMs - tzOffsetMin * 60 * 1000;
}

/** UTC-ms of local midnight starting the given YYYYMMDD, for the system's tz offset. */
function dayStartUtcMs(date: string, tzOffsetMin: number): number | null {
  return localDataTimeToUtcMs(`${date} 00:00`, tzOffsetMin);
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
}

/**
 * Difference the `itemList` cumulative counters into per-5-min energy readings (Wh) for all six
 * metrics. PURE (no I/O) so the differencing + tail-reconciliation is unit-testable. `rows` must be
 * the valid, time-ASCENDING intervals for a single local day; `isComplete` enables the residual tail.
 */
export function computeDayEnergyReadings(
  rows: SigenergyEnergyInterval[],
  totals: SigenergyEnergyTotals,
  tzOffsetMin: number,
  isComplete: boolean,
  date = "",
): Agg5mReading[] {
  const readings: Agg5mReading[] = [];
  if (rows.length === 0) return readings;

  for (const { counterField, metadata } of SIGENERGY_ENERGY_POINTS) {
    const field: SigenergyEnergyCounterField = counterField;
    let sumWh = 0;

    // Consecutive-sample differences → interval energy, labelled at the later sample's instant.
    for (let i = 0; i < rows.length - 1; i++) {
      const c0 = rows[i][field];
      const c1 = rows[i + 1][field];
      const endMs = localDataTimeToUtcMs(rows[i + 1].dataTime, tzOffsetMin);
      if (c0 == null || c1 == null || endMs == null) continue;
      // Monotonic directional counters ⇒ diff ≥ 0; clamp any glitch/reset to 0 (defensive).
      const wh = Math.max(0, Math.round((c1 - c0) * 1000));
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
      const last = rows[rows.length - 1];
      const lastEndMs = localDataTimeToUtcMs(last.dataTime, tzOffsetMin);
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
 * Fetch one day's statistics and publish its per-interval energy for all six metrics.
 *
 * `now` defaults to the wall clock; injectable for tests. Requires a `session` (5m-native publish is
 * gated on it) and should be given the poll `collector` so the observations flush on session close.
 */
export async function pullEnergyDay(params: {
  client: SigenergyClient;
  systemId: number;
  stationId: string;
  date: string; // YYYYMMDD
  tzOffsetMin: number;
  session: SessionInfo;
  collector?: PollCollector;
  now?: number;
}): Promise<PullEnergyDayResult> {
  const { client, systemId, stationId, date, tzOffsetMin, session, collector } =
    params;
  const now = params.now ?? Date.now();

  const day = await client.getEnergyStatistics(stationId, date);
  const rows = day.intervals
    .filter((r) => /^\d{8}\s+\d{2}:\d{2}$/.test(r.dataTime))
    .sort((a, b) => a.dataTime.localeCompare(b.dataTime));

  if (rows.length === 0) {
    return {
      date,
      intervalsFetched: 0,
      readingsWritten: 0,
      reconciled: false,
      empty: true,
    };
  }

  // A day is "complete" once its local midnight-to-midnight window has fully elapsed.
  const start = dayStartUtcMs(date, tzOffsetMin);
  const isComplete = start != null && start + DAY_MS <= now;

  const readings = computeDayEnergyReadings(
    rows,
    day.totals,
    tzOffsetMin,
    isComplete,
    date,
  );

  await PointManager.getInstance().insertPointReadingsAgg5m(
    systemId,
    session,
    readings,
    collector,
  );

  return {
    date,
    intervalsFetched: rows.length,
    readingsWritten: readings.length,
    reconciled: isComplete,
    empty: false,
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
 */
export async function backfillEnergyRange(params: {
  client: SigenergyClient;
  systemId: number;
  stationId: string;
  startDate: string; // YYYYMMDD
  endDate: string; // YYYYMMDD
  tzOffsetMin: number;
  session: SessionInfo;
  collector?: PollCollector;
  now?: number;
}): Promise<{
  days: PullEnergyDayResult[];
  errors: string[];
}> {
  const days: PullEnergyDayResult[] = [];
  const errors: string[] = [];
  for (const date of enumerateDays(params.startDate, params.endDate)) {
    try {
      days.push(
        await pullEnergyDay({
          client: params.client,
          systemId: params.systemId,
          stationId: params.stationId,
          date,
          tzOffsetMin: params.tzOffsetMin,
          session: params.session,
          collector: params.collector,
          now: params.now,
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
