/**
 * Amber forecast-history capture (change-only).
 *
 * The 5-min Amber poll fetches a ~48h horizon of Forecast/Current price
 * intervals whose values the main sync upserts into point_readings_agg_5m,
 * overwriting the previous forecast. This module side-writes that horizon into
 * `amber_forecast_history` so forecast revisions survive: one row per
 * (device, channel, target interval) is appended ONLY when a tracked value
 * moves materially from the last stored row for that key (first sighting
 * counts) — "materially" being PRICE_EPSILON / RENEWABLES_EPSILON below.
 *
 * Row kinds (see the schema doc-comment): per-channel rows carry perKwh +
 * advancedPrice + descriptor/spikeStatus/estimate; a synthetic 'site' row
 * carries spotPerKwh + renewables once (from the 'general' record, which
 * Amber emits for every interval).
 */

import { and, between, desc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  amberForecastHistory,
  type NewAmberForecastHistoryRow,
} from "@/lib/db/planetscale/schema";
import type { AmberPriceRecord } from "./types";

/** The tracked fields of one candidate/baseline row, keyed by (channel, intervalEnd). */
export interface ForecastCandidate {
  channel: string; // 'general' | 'feedIn' | 'controlledLoad' | 'site'
  intervalEndMs: number; // nemTime epoch — same key as agg_5m.interval_end
  intervalType: "f" | "c";
  durationMin: number;
  perKwh: number | null;
  advLow: number | null;
  advPredicted: number | null;
  advHigh: number | null;
  descriptor: string | null;
  spikeStatus: string | null;
  estimate: boolean | null;
  spotPerKwh: number | null;
  renewables: number | null;
}

/**
 * Change thresholds — a revision earns a row only if it is big enough to matter.
 *
 * Measured over the first prod polls (2026-08-14, Kinkora): Amber re-publishes
 * the advancedPrice band on EVERY interval on EVERY 5-min poll — the |Δ| is
 * literally never zero, median ~0.05 c/kWh — so an exact comparison stored ~102
 * rows/poll, i.e. the whole horizon, which is what change-only was meant to
 * avoid. perKwh itself is flat 76% of the time and costs almost nothing.
 * 0.1 c/kWh sits just above that noise floor (~p75 of the band's step) and drops
 * ~36% of the steady-state rows; the saving curve is flat below ~0.02.
 *
 * Because a candidate is compared against the last STORED row, not the last
 * OBSERVED one, sub-threshold creep still trips once it accumulates past the
 * threshold. So the stored series stays within one threshold of the published
 * forecast at all times — the error is bounded, never compounding.
 */
const PRICE_EPSILON = 0.1; // c/kWh — perKwh, the adv* band, spotPerKwh
const RENEWABLES_EPSILON = 0.1; // percentage points — renewables

function candidateKey(channel: string, intervalEndMs: number): string {
  return `${channel}|${intervalEndMs}`;
}

/**
 * Project raw Amber price records into candidate rows. ActualIntervals are
 * skipped (actuals live in agg_5m); each Forecast/Current record yields a
 * channel row, and each 'general' record additionally yields the 'site' row.
 */
export function projectPriceRecords(
  priceRecords: AmberPriceRecord[],
): ForecastCandidate[] {
  const candidates: ForecastCandidate[] = [];

  for (const record of priceRecords) {
    if (record.type === "ActualInterval") continue;
    const intervalType = record.type === "CurrentInterval" ? "c" : "f";
    // Same derivation as loadRemotePrices: nemTime, not endTime.
    const intervalEndMs = new Date(record.nemTime).getTime();
    if (!Number.isFinite(intervalEndMs)) continue;

    candidates.push({
      channel: record.channelType,
      intervalEndMs,
      intervalType,
      durationMin: record.duration,
      perKwh: record.perKwh ?? null,
      advLow: record.advancedPrice?.low ?? null,
      advPredicted: record.advancedPrice?.predicted ?? null,
      advHigh: record.advancedPrice?.high ?? null,
      descriptor: record.descriptor ?? null,
      spikeStatus: record.spikeStatus ?? null,
      estimate: record.estimate ?? null,
      spotPerKwh: null,
      renewables: null,
    });

    if (record.channelType === "general") {
      candidates.push({
        channel: "site",
        intervalEndMs,
        intervalType,
        durationMin: record.duration,
        perKwh: null,
        advLow: null,
        advPredicted: null,
        advHigh: null,
        descriptor: null,
        spikeStatus: null,
        estimate: null,
        spotPerKwh: record.spotPerKwh ?? null,
        renewables: record.renewables ?? null,
      });
    }
  }

  return candidates;
}

/** A null↔value transition always counts; otherwise the move must clear `epsilon`. */
function numberChanged(
  a: number | null,
  b: number | null,
  epsilon: number,
): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) > epsilon;
}

const priceChanged = (a: number | null, b: number | null) =>
  numberChanged(a, b, PRICE_EPSILON);

/** True when any tracked field differs between candidate and baseline. */
export function candidateChanged(
  candidate: ForecastCandidate,
  baseline: ForecastCandidate | undefined,
): boolean {
  if (!baseline) return true; // first sighting
  return (
    priceChanged(candidate.perKwh, baseline.perKwh) ||
    priceChanged(candidate.advLow, baseline.advLow) ||
    priceChanged(candidate.advPredicted, baseline.advPredicted) ||
    priceChanged(candidate.advHigh, baseline.advHigh) ||
    priceChanged(candidate.spotPerKwh, baseline.spotPerKwh) ||
    numberChanged(
      candidate.renewables,
      baseline.renewables,
      RENEWABLES_EPSILON,
    ) ||
    candidate.descriptor !== baseline.descriptor ||
    candidate.spikeStatus !== baseline.spikeStatus ||
    candidate.estimate !== baseline.estimate ||
    candidate.intervalType !== baseline.intervalType ||
    candidate.durationMin !== baseline.durationMin
  );
}

/** Pure diff step: the candidates that differ from their baseline. */
export function diffAgainstBaseline(
  candidates: ForecastCandidate[],
  baseline: Map<string, ForecastCandidate>,
): ForecastCandidate[] {
  return candidates.filter((c) =>
    candidateChanged(c, baseline.get(candidateKey(c.channel, c.intervalEndMs))),
  );
}

/**
 * Load the latest stored row per (channel, intervalEnd) for the horizon —
 * the change-detection baseline. One DISTINCT ON query on the PK index.
 */
async function loadBaseline(
  deviceRid: number,
  minIntervalMs: number,
  maxIntervalMs: number,
): Promise<Map<string, ForecastCandidate>> {
  const db = requirePlanetscaleDb();
  const rows = await db
    .selectDistinctOn(
      [amberForecastHistory.channel, amberForecastHistory.intervalEnd],
      {
        channel: amberForecastHistory.channel,
        intervalEnd: amberForecastHistory.intervalEnd,
        intervalType: amberForecastHistory.intervalType,
        durationMin: amberForecastHistory.durationMin,
        perKwh: amberForecastHistory.perKwh,
        advLow: amberForecastHistory.advLow,
        advPredicted: amberForecastHistory.advPredicted,
        advHigh: amberForecastHistory.advHigh,
        descriptor: amberForecastHistory.descriptor,
        spikeStatus: amberForecastHistory.spikeStatus,
        estimate: amberForecastHistory.estimate,
        spotPerKwh: amberForecastHistory.spotPerKwh,
        renewables: amberForecastHistory.renewables,
      },
    )
    .from(amberForecastHistory)
    .where(
      and(
        eq(amberForecastHistory.deviceRid, deviceRid),
        between(
          amberForecastHistory.intervalEnd,
          new Date(minIntervalMs),
          new Date(maxIntervalMs),
        ),
      ),
    )
    .orderBy(
      amberForecastHistory.channel,
      amberForecastHistory.intervalEnd,
      desc(amberForecastHistory.observedAt),
    );

  const baseline = new Map<string, ForecastCandidate>();
  for (const r of rows) {
    baseline.set(candidateKey(r.channel, r.intervalEnd.getTime()), {
      channel: r.channel,
      intervalEndMs: r.intervalEnd.getTime(),
      intervalType: r.intervalType as "f" | "c",
      durationMin: r.durationMin,
      perKwh: r.perKwh,
      advLow: r.advLow,
      advPredicted: r.advPredicted,
      advHigh: r.advHigh,
      descriptor: r.descriptor,
      spikeStatus: r.spikeStatus,
      estimate: r.estimate,
      spotPerKwh: r.spotPerKwh,
      renewables: r.renewables,
    });
  }
  return baseline;
}

/**
 * Capture one poll's forecast horizon: project → baseline → diff → insert.
 * Throws on DB failure; the caller (updateForecasts) isolates the error so a
 * capture failure can never fail the main sync.
 */
export async function captureForecastHistory(
  deviceRid: number,
  priceRecords: AmberPriceRecord[],
  observedAt: Date,
): Promise<{ rowsInserted: number }> {
  const candidates = projectPriceRecords(priceRecords);
  if (candidates.length === 0) return { rowsInserted: 0 };

  const intervalTimes = candidates.map((c) => c.intervalEndMs);
  const baseline = await loadBaseline(
    deviceRid,
    Math.min(...intervalTimes),
    Math.max(...intervalTimes),
  );

  const changed = diffAgainstBaseline(candidates, baseline);
  if (changed.length === 0) return { rowsInserted: 0 };

  const rows: NewAmberForecastHistoryRow[] = changed.map((c) => ({
    deviceRid,
    channel: c.channel,
    intervalEnd: new Date(c.intervalEndMs),
    observedAt,
    intervalType: c.intervalType,
    durationMin: c.durationMin,
    perKwh: c.perKwh,
    advLow: c.advLow,
    advPredicted: c.advPredicted,
    advHigh: c.advHigh,
    descriptor: c.descriptor,
    spikeStatus: c.spikeStatus,
    estimate: c.estimate,
    spotPerKwh: c.spotPerKwh,
    renewables: c.renewables,
  }));

  const db = requirePlanetscaleDb();
  // PK (device, channel, interval_end, observed_at) makes a retried poll idempotent.
  await db.insert(amberForecastHistory).values(rows).onConflictDoNothing();

  return { rowsInserted: rows.length };
}
