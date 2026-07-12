/**
 * Pure battery-provenance compute — NO database, NO IO. Given the loaded {@link ProvenanceInputs} and a
 * {@link ProvenanceConfig}, it runs the stateful blend fold and the flow accounting and returns the raw
 * result. Shared byte-for-byte by the prod driver and the offline harness (they differ only in how they
 * source `inputs` and what they do with the result). Deterministic and presentation-free.
 */

import {
  computeFlowAccounting,
  SourceIntensity,
} from "@/lib/aggregation/flow-matrix-core";
import { extractBatteryFlows } from "./battery-flows";
import { foldBatteryProvenance, FoldConfig, FoldInterval } from "./fold";
import type {
  ProvenanceConfig,
  ProvenanceInputs,
  ProvenanceResult,
} from "./types";

const DEFAULT_MAX_SEGMENT_INTERVALS = 6 * 288; // 6-day staleness backstop
const DEFAULT_REANCHOR_EPS_KWH = 0.3;

export function computeBatteryProvenance(
  inputs: ProvenanceInputs,
  config: ProvenanceConfig = {},
): ProvenanceResult {
  const { timeline, sources, loads } = inputs;
  const solarValuation = config.solarValuation ?? "zero";

  // Per-interval battery charge split + discharge from the flow allocation (power-integrated), then
  // PREFER exact energy registers where the Area binds them (config: attach to power OR energy).
  const bflows = extractBatteryFlows(timeline, sources, loads);
  const exactCharge = inputs.batteryChargeEnergyKwh;
  const exactDischarge = inputs.batteryDischargeEnergyKwh;
  const flows = bflows.map((bf, i) => {
    let { solarChargeKwh, gridChargeKwh, otherChargeKwh, dischargeKwh } = bf;
    const ec = exactCharge?.[i];
    if (ec != null) {
      const powerTotal = solarChargeKwh + gridChargeKwh + otherChargeKwh;
      if (powerTotal > 0) {
        const scale = ec / powerTotal; // keep the solar/grid split ratio, use the exact magnitude
        solarChargeKwh *= scale;
        gridChargeKwh *= scale;
        otherChargeKwh *= scale;
      } else if (ec > 0) {
        otherChargeKwh = ec; // charge with no measured generation split → unknown provenance
      }
    }
    const ed = exactDischarge?.[i];
    if (ed != null) dischargeKwh = ed;
    return { solarChargeKwh, gridChargeKwh, otherChargeKwh, dischargeKwh };
  });

  // Physical round-trip totals (raw, before η) for the RTE diagnostic + the "measured" η.
  let chargeKwh = 0;
  let dischargeKwh = 0;
  for (const f of flows) {
    chargeKwh += f.solarChargeKwh + f.gridChargeKwh + f.otherChargeKwh;
    dischargeKwh += f.dischargeKwh;
  }
  const measuredEta =
    chargeKwh > 0 ? Math.min(1, Math.max(0.7, dischargeKwh / chargeKwh)) : 1;
  const etaUsed =
    typeof config.efficiency === "number" ? config.efficiency : measuredEta;
  const reserveUsed = config.reserveFloorPct ?? inputs.estReservePct;

  const solarCost = (i: number) =>
    solarValuation === "opportunity"
      ? Math.max(0, inputs.gridExportPrice[i] ?? 0)
      : 0;

  const foldConfig: FoldConfig = {
    reserveFloorPct: reserveUsed,
    efficiency: etaUsed,
    maxSegmentIntervals:
      config.maxSegmentIntervals ?? DEFAULT_MAX_SEGMENT_INTERVALS,
    reanchorEpsKwh: config.reanchorEpsKwh ?? DEFAULT_REANCHOR_EPS_KWH,
  };
  const intervals: FoldInterval[] = flows.map((f, i) => ({
    solarChargeKwh: f.solarChargeKwh,
    gridChargeKwh: f.gridChargeKwh,
    otherChargeKwh: f.otherChargeKwh,
    dischargeKwh: f.dischargeKwh,
    gridEmissionsIntensity: inputs.gridEmissions[i],
    gridRenewableFraction: inputs.gridRenewable[i],
    gridPrice: inputs.gridPrice[i],
    solarCost: solarCost(i),
    socPct: inputs.soc[i],
    gridEstimated:
      inputs.gridEmissionsEstimated[i] || inputs.gridPriceEstimated[i],
  }));
  const { steps, finalState } = foldBatteryProvenance(intervals, foldConfig);

  // Independent charged-carbon total (for the conservation self-audit): Σ grid-charge · grid EI.
  let chargedG = 0;
  for (let i = 0; i < intervals.length; i++) {
    const ei = intervals[i].gridEmissionsIntensity;
    if (intervals[i].gridChargeKwh > 0 && ei !== null)
      chargedG += intervals[i].gridChargeKwh * ei;
  }

  // Per-source intensity for the attribution: solar const, grid from OE/Amber, battery from the fold.
  const sourceIntensities: (SourceIntensity | null)[] = sources.map((src) => {
    if (src.path === "source.solar" || src.path.startsWith("source.solar.")) {
      return {
        emissions: timeline.map(() => 0),
        renewable: timeline.map(() => 1),
        price: timeline.map((_, i) => solarCost(i)),
        estimated: timeline.map(() => false),
      };
    }
    if (src.path === "source.grid") {
      return {
        emissions: inputs.gridEmissions,
        renewable: inputs.gridRenewable,
        price: inputs.gridPrice,
        estimated: timeline.map(
          (_, i) =>
            inputs.gridEmissionsEstimated[i] || inputs.gridPriceEstimated[i],
        ),
      };
    }
    if (src.path === "source.battery") {
      const emissions = new Array<number | null>(timeline.length).fill(null);
      const renewable = new Array<number | null>(timeline.length).fill(null);
      const price = new Array<number | null>(timeline.length).fill(null);
      const estimated = new Array<boolean>(timeline.length).fill(false);
      for (let i = 0; i < steps.length; i++) {
        emissions[i] = steps[i].batteryEmissionsIntensity;
        renewable[i] = steps[i].batteryRenewableFraction;
        price[i] = steps[i].batteryPrice;
        estimated[i] = steps[i].estimatedFraction > 0;
      }
      return { emissions, renewable, price, estimated };
    }
    return null; // e.g. source.generator — unknown intensity
  });

  const accounting = computeFlowAccounting({
    timestamps: timeline,
    sources,
    loads,
    sourceIntensities,
  });

  return {
    steps,
    finalState,
    accounting,
    etaUsed,
    reserveUsed,
    chargeKwh,
    dischargeKwh,
    chargedG,
  };
}
