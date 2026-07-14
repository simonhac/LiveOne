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
import { learnEwmaEta, type EtaDayDiag } from "./eta";
import { learnEwmaCapacity, measureWindowCapacity } from "./capacity";
import { foldBatteryProvenance, FoldConfig, FoldInterval } from "./fold";
import { resolveExportPriceSeries } from "./tariff";
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

  // η resolution, in priority order:
  //   1. a numeric config.efficiency pins one scalar for the window (tests / manual override);
  //   2. inputs.etaSeries — the PERSISTED η(t) the loader read from the round-trip-efficiency helper
  //      point. Canonical & REPRODUCIBLE: η is learned ONCE in the daily shell over a stable window, so a
  //      bounded re-fold reads the same η as a full-history run (repair-convergence holds);
  //   3. fallback — learn a per-day EWMA η(t) in-window from the raw charge/discharge energies. This is
  //      NON-canonical (window-dependent) and only for bootstrap (before the shell has run) + the offline
  //      harness. `etaByDay` (the degradation-trend diagnostic) is produced only on this path.
  let etaSeries: (number | null)[] | null = null;
  let etaByDay: EtaDayDiag[] | undefined;
  let etaUsed: number;
  if (typeof config.efficiency === "number") {
    etaUsed = config.efficiency;
  } else if (inputs.etaSeries) {
    etaSeries = inputs.etaSeries;
    // Throughput-weighted summary of the persisted η(t), for the RTE diagnostic.
    let wsum = 0;
    let w = 0;
    for (let i = 0; i < flows.length; i++) {
      const e = etaSeries[i];
      if (e == null) continue;
      const c =
        flows[i].solarChargeKwh +
        flows[i].gridChargeKwh +
        flows[i].otherChargeKwh;
      wsum += e * c;
      w += c;
    }
    etaUsed = w > 0 ? wsum / w : measuredEta;
  } else {
    const learned = learnEwmaEta(
      flows.map((f) => f.solarChargeKwh + f.gridChargeKwh + f.otherChargeKwh),
      flows.map((f) => f.dischargeKwh),
      timeline,
      inputs.timezoneOffsetMin,
      { prior: chargeKwh > 0 ? measuredEta : 0.9 },
    );
    etaSeries = learned.etaSeries;
    etaByDay = learned.byDay;
    etaUsed = learned.summary;
  }
  const reserveUsed = config.reserveFloorPct ?? inputs.estReservePct;

  // Usable capacity C(t) resolution — mirrors η (same reproducibility contract):
  //   1. inputs.capacitySeries — the PERSISTED C(t) the loader read from the usable-capacity helper point.
  //      Canonical & REPRODUCIBLE (learned once in the daily shell over a fixed window);
  //   2. fallback — learn a per-day EWMA C(t) in-window from raw charge/discharge + η + SoC. NON-canonical
  //      (window-dependent) bootstrap, and the offline harness. Fold-independent (raw energies, no circularity).
  // C stamps `FoldInterval.capacityKwh`; combined with a non-null SoC it arms the SoC-anchor overlay. When
  // SoC is absent the overlay is inert regardless, so this cost is only paid where it matters.
  let capacitySeries: (number | null)[] | null = inputs.capacitySeries ?? null;
  if (!capacitySeries) {
    const dischargePerIv = flows.map((f) => f.dischargeKwh);
    const seed = measureWindowCapacity(dischargePerIv, inputs.soc);
    capacitySeries = learnEwmaCapacity(
      dischargePerIv,
      inputs.soc,
      timeline,
      inputs.timezoneOffsetMin,
      { prior: seed ?? undefined },
    ).capacitySeries;
  }

  // Dual solar cost basis (both computed every run — opportunity is first-class, not a toggle):
  //   • ACTUAL   — solar is out-of-pocket free (0). Feeds `costC` → `batteryPrice`.
  //   • OPPORTUNITY — solar priced at forgone feed-in from the resolved export tariff. Feeds `costOppC`
  //                   → `batteryPriceOpportunity`. The tariff SOURCE (none/amber/schedule) is resolved
  //                   here into a single exportPrice[] series; the fold never sees modes/schedules.
  const SOLAR_ACTUAL_COST = 0;
  const exportPrice = resolveExportPriceSeries(
    inputs.exportTariff,
    timeline,
    inputs.timezoneOffsetMin,
    inputs.gridExportPrice,
  );
  const solarCostOpp = (i: number) => Math.max(0, exportPrice[i] ?? 0);

  const foldConfig: FoldConfig = {
    reserveFloorPct: reserveUsed,
    efficiency: etaUsed,
    maxSegmentIntervals:
      config.maxSegmentIntervals ?? DEFAULT_MAX_SEGMENT_INTERVALS,
    reanchorEpsKwh: config.reanchorEpsKwh ?? DEFAULT_REANCHOR_EPS_KWH,
    socSyncGamma: config.socSyncGamma,
    socSyncDeadbandKwh: config.socSyncDeadbandKwh,
  };
  const intervals: FoldInterval[] = flows.map((f, i) => ({
    solarChargeKwh: f.solarChargeKwh,
    gridChargeKwh: f.gridChargeKwh,
    otherChargeKwh: f.otherChargeKwh,
    dischargeKwh: f.dischargeKwh,
    gridEmissionsIntensity: inputs.gridEmissions[i],
    gridRenewableFraction: inputs.gridRenewable[i],
    gridPrice: inputs.gridPrice[i],
    solarCost: SOLAR_ACTUAL_COST,
    solarCostOpp: solarCostOpp(i),
    socPct: inputs.soc[i],
    gridEstimated:
      inputs.gridEmissionsEstimated[i] || inputs.gridPriceEstimated[i],
    efficiency: etaSeries?.[i] ?? undefined,
    capacityKwh: capacitySeries?.[i] ?? undefined,
    // Fallback provenance for unattributed `otherCharge` AND SoC up-injection: the site grid/generator
    // signal for this interval (for Daylesford this is the generatorSource constant → carbon reconciles).
    otherEmissionsIntensity: inputs.gridEmissions[i],
    otherRenewableFraction: inputs.gridRenewable[i],
    otherPrice: inputs.gridPrice[i],
    otherPriceOpp: inputs.gridPrice[i] ?? undefined,
  }));
  const { steps, finalState } = foldBatteryProvenance(intervals, foldConfig);

  // Independent charged-carbon total (for the conservation self-audit): Σ (grid + otherFallback) charge · EI.
  // The self-audit closes as chargedG + syncG == vendedG + unattribLossG + carbonG (see fold.ts sync buckets).
  let chargedG = 0;
  for (let i = 0; i < intervals.length; i++) {
    const ei = intervals[i].gridEmissionsIntensity;
    if (intervals[i].gridChargeKwh > 0 && ei !== null)
      chargedG += intervals[i].gridChargeKwh * ei;
    const oei = intervals[i].otherEmissionsIntensity ?? null;
    const oc = intervals[i].otherChargeKwh ?? 0;
    if (oc > 0 && oei !== null) chargedG += oc * oei;
  }

  // Per-source intensity for the attribution: solar const, grid from OE/Amber, battery from the fold.
  const sourceIntensities: (SourceIntensity | null)[] = sources.map((src) => {
    if (src.path === "source.solar" || src.path.startsWith("source.solar.")) {
      return {
        emissions: timeline.map(() => 0),
        renewable: timeline.map(() => 1),
        // The per-day attribution rollup stays ACTUAL (out-of-pocket) cost; opportunity cost lives only
        // in the battery fold's parallel accumulator (→ the `price-opportunity` derived point).
        price: timeline.map(() => SOLAR_ACTUAL_COST),
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
    sourceIntensities,
    etaUsed,
    etaByDay,
    reserveUsed,
    chargeKwh,
    dischargeKwh,
    chargedG,
  };
}
