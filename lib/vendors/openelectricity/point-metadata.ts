/**
 * OpenElectricity point definitions + response→reading mapper.
 *
 * Three stored points per region, all under the `grid` subsystem:
 *   - grid.emissionsIntensity (tCO2e/MWh) — COMPUTED: emissions ÷ energy
 *   - grid.price ($/MWh)                  — direct (market `price`)
 *   - grid.renewables (%)                 — direct (market `renewable_proportion`)
 *
 * The same mapper is used by the live adapter, the backfill downloader, and the bulk
 * ingestor so the three paths produce identical readings.
 */

import type { PointMetadata } from "@/lib/point/point-manager";
import type { PointReadingAgg5mInput } from "@/lib/vendors/types";
import { getBasisMetric } from "./client";
import type { OeInterval, OeMetric, OeNetworkResponse } from "./types";

export const EMISSIONS_INTENSITY_POINT: PointMetadata = {
  physicalPathTail: "nem/emissionsIntensity",
  logicalPathStem: "grid.emissionsIntensity",
  defaultName: "Emissions intensity",
  subsystem: "grid",
  metricType: "intensity",
  metricUnit: "tCO2e/MWh",
  transform: null,
};

export const PRICE_POINT: PointMetadata = {
  physicalPathTail: "nem/price",
  logicalPathStem: "grid.price",
  defaultName: "Spot price",
  subsystem: "grid",
  metricType: "rate",
  metricUnit: "$/MWh",
  transform: null,
};

export const RENEWABLE_PROPORTION_POINT: PointMetadata = {
  physicalPathTail: "nem/renewableProportion",
  logicalPathStem: "grid.renewables",
  defaultName: "Renewable proportion",
  subsystem: "grid",
  metricType: "proportion",
  metricUnit: "%",
  transform: null,
};

/** All points this integration stores, in display order. */
export const OPENELECTRICITY_POINTS: readonly PointMetadata[] = [
  EMISSIONS_INTENSITY_POINT,
  PRICE_POINT,
  RENEWABLE_PROPORTION_POINT,
];

const INTERVAL_MS: Record<OeInterval, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Index a response's series for a given metric as `startMs → value`, skipping nulls.
 * Tolerates the metric appearing as one or many result series (region-filtered
 * responses are typically a single series).
 */
function indexSeries(
  resp: OeNetworkResponse | undefined,
  metric: OeMetric,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!resp?.data) return out;
  for (const series of resp.data) {
    if (series.metric?.toLowerCase() !== metric) continue;
    for (const result of series.results ?? []) {
      for (const [ts, value] of result.data ?? []) {
        if (value == null) continue;
        const startMs = Date.parse(ts);
        if (Number.isNaN(startMs)) continue;
        out.set(startMs, value);
      }
    }
  }
  return out;
}

/**
 * Build 5m readings from the two endpoint responses.
 *
 * @param dataResp   /v4/data response containing the energy basis + `emissions`
 * @param marketResp /v4/market response containing `price` + `renewable_proportion`
 * @param interval   bucket size (drives the START→END offset and the energy basis)
 * @param dataQuality stored quality marker ("good" live, "actual" for bulk history)
 */
export function buildReadingsFromResponses(
  dataResp: OeNetworkResponse | undefined,
  marketResp: OeNetworkResponse | undefined,
  interval: OeInterval,
  dataQuality: string = "good",
): PointReadingAgg5mInput[] {
  const intervalMs = INTERVAL_MS[interval];
  const out: PointReadingAgg5mInput[] = [];

  // --- emissions intensity = emissions ÷ energy (computed) ---
  const basis = getBasisMetric(interval); // "power" at 5m, "energy" otherwise
  const basisSeries = indexSeries(dataResp, basis);
  const emissionsSeries = indexSeries(dataResp, "emissions");
  for (const [startMs, emissions] of emissionsSeries) {
    const basisVal = basisSeries.get(startMs);
    if (basisVal == null) continue;
    // power (MW) × hours → MWh; energy is already MWh.
    const energyMWh =
      basis === "power" ? basisVal * (intervalMs / MS_PER_HOUR) : basisVal;
    if (!(energyMWh > 0)) continue; // no generation → intensity undefined
    out.push({
      pointMetadata: EMISSIONS_INTENSITY_POINT,
      rawValue: emissions / energyMWh,
      intervalEndMs: startMs + intervalMs,
      dataQuality,
    });
  }

  // --- price + renewable proportion (direct) ---
  for (const [startMs, value] of indexSeries(marketResp, "price")) {
    out.push({
      pointMetadata: PRICE_POINT,
      rawValue: value,
      intervalEndMs: startMs + intervalMs,
      dataQuality,
    });
  }
  for (const [startMs, value] of indexSeries(
    marketResp,
    "renewable_proportion",
  )) {
    out.push({
      pointMetadata: RENEWABLE_PROPORTION_POINT,
      rawValue: value,
      intervalEndMs: startMs + intervalMs,
      dataQuality,
    });
  }

  return out;
}
