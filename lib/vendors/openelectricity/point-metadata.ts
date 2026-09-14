/**
 * OpenElectricity point definitions + response→reading mapper.
 *
 * Four stored points per region, all under the `grid` subsystem:
 *   - bidi.grid.emissionsIntensity (tCO2e/MWh) — COMPUTED: emissions ÷ energy
 *   - bidi.grid.spot ($/MWh)                   — direct (market `price`)
 *   - bidi.grid.renewables (%)                 — direct (market `renewable_proportion`)
 *   - grid.demand (MW)                         — direct (market `demand`)
 *
 * 🛑 The first three deliberately share Amber's `bidi.grid.*` namespace, which is the GRID-CONNECTION
 * namespace rather than a directionality claim (the directional split lives one level down, at
 * `.import`/`.export`). That is what makes them match role `grid` through the ordinary
 * `stemMatchesRole` anchor — `ROLES.grid.stem` is `bidi.grid` — instead of through a carve-out in
 * `bindingShapeMatches`, which is now deleted.
 *
 * `grid.demand` stays OUT of that namespace on purpose: state-wide operational demand is a property
 * of the region, not of this connection, and its metric is `power`/MW — the same serving key the
 * real site meters use. Keeping it outside `bidi.grid.*` makes it unbindable to role `grid` by
 * construction, so the MW-into-a-W-slot hazard cannot arise by accident.
 *
 * None of the three is a flow stem: `classifyEnergyStem` admits `bidi.grid` exactly plus the
 * `.import`/`.export`/`.controlled` pairs, so a rate/intensity/proportion can never enter the
 * Sankey or make an area flow-eligible.
 *
 * The same mapper is used by the live adapter, the backfill downloader, and the bulk
 * ingestor so the paths produce identical readings.
 */

import type { PointMetadata } from "@/lib/point/point-manager";
import type { PointReadingAgg5mInput } from "@/lib/vendors/types";
import { getBasisMetric } from "./client";
import type { OeInterval, OeMetric, OeNetworkResponse } from "./types";

/** The stored logical-path stems, exported as one object so a consumer that must address these
 *  points BY PATH — the battery-provenance loader reads two of them out of `points.logical_path` —
 *  shares a literal with the writer instead of restating it. Not read back off the `PointMetadata`
 *  objects below, because `PointMetadata.logicalPathStem` is `string | null` and that loses both the
 *  literal type and the non-nullness at every call site. */
export const OE_STEMS = {
  emissionsIntensity: "bidi.grid.emissionsIntensity",
  spot: "bidi.grid.spot",
  renewables: "bidi.grid.renewables",
  demand: "grid.demand",
} as const;

export const EMISSIONS_INTENSITY_POINT: PointMetadata = {
  physicalPathTail: "nem/emissionsIntensity",
  logicalPathStem: OE_STEMS.emissionsIntensity,
  defaultName: "Emissions intensity",
  subsystem: "grid",
  metricType: "intensity",
  metricUnit: "tCO2e/MWh",
  transform: null,
};

export const PRICE_POINT: PointMetadata = {
  physicalPathTail: "nem/price",
  logicalPathStem: OE_STEMS.spot,
  defaultName: "Spot price",
  subsystem: "grid",
  metricType: "rate",
  metricUnit: "$/MWh",
  transform: null,
};

export const RENEWABLE_PROPORTION_POINT: PointMetadata = {
  physicalPathTail: "nem/renewableProportion",
  logicalPathStem: OE_STEMS.renewables,
  defaultName: "Renewable proportion",
  subsystem: "grid",
  metricType: "proportion",
  metricUnit: "%",
  transform: null,
};

export const DEMAND_POINT: PointMetadata = {
  physicalPathTail: "nem/demand",
  logicalPathStem: OE_STEMS.demand,
  defaultName: "Operational demand",
  subsystem: "grid",
  metricType: "power",
  metricUnit: "MW",
  transform: null,
};

/** All points this integration stores, in display order. */
export const OPENELECTRICITY_POINTS: readonly PointMetadata[] = [
  EMISSIONS_INTENSITY_POINT,
  PRICE_POINT,
  RENEWABLE_PROPORTION_POINT,
  DEMAND_POINT,
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
    // A generating grid always emits (>0); the OE API can return a transient 0 for the
    // freshest/settling interval, which would compute a non-physical 0 intensity. Skip it
    // (intensity undefined) — the next poll re-pulls the window and heals the interval.
    if (!(emissions > 0)) continue;
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
  for (const [startMs, value] of indexSeries(marketResp, "demand")) {
    out.push({
      pointMetadata: DEMAND_POINT,
      rawValue: value,
      intervalEndMs: startMs + intervalMs,
      dataQuality,
    });
  }

  return out;
}
