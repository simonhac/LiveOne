/**
 * Pure battery-provenance fold — NO database, NO clock, NO IO.
 *
 * Models the battery as a WEIGHTED-AVERAGE INVENTORY ("stock-and-flow"). As the battery charges,
 * it accumulates the blended emissions / renewable / cost of whatever fed it (solar = 0 gCO2,
 * 100 % renewable, and a configurable cost; grid import = the grid intensities at that interval).
 * As it discharges, it vends the CURRENT blend. Accumulators RESET when the battery bottoms out —
 * which bounds how far a late-data repair ever has to re-fold, since each cycle is independent.
 *
 * `E` is a RESET-RELATIVE inventory: (Σ deliverable charge − Σ discharge) since the last reset,
 * floored at 0. It is NOT absolute stored energy and needs no battery nameplate capacity — SoC is
 * used ONLY to detect the reserve floor, never to size `E`. This is why a mid-life capacity change
 * needs no reconfiguration.
 *
 * ── Round-trip efficiency (η) ──────────────────────────────────────────────────────────────────
 * A battery returns LESS than you put in. With η < 1, charge adds `η·charge` to `E` (the deliverable
 * part) but the FULL charge footprint to `Q` — so the delivered energy carries the whole footprint
 * (round-trip loss priced into the loads it serves), and `E` reaches 0 exactly at the physical
 * bottom-out (`discharge ≈ η·charge`). The overhead `(1−η)·footprint` is ALSO tallied in the
 * `roundtripLoss*` buckets as a DECOMPOSITION of the delivered cost (a diagnostic — NOT subtracted,
 * so it isn't double-counted). Feed η from the measured Σout/Σin (see the replay); it can be learned
 * and updated over time.
 *
 * ── Resets & the drift backstop ────────────────────────────────────────────────────────────────
 *  - `empty`     — `E` drains to ≤ `reanchorEpsKwh` (the reserve bottom-out, SoC-free). Primary.
 *  - `soc-floor` — SoC ≤ `reserveFloorPct` (drift correction when SoC is present; lazy: applied at
 *                  the next charge so reserve discharge still vends the real blend).
 *  - `backstop`  — a segment ran `maxSegmentIntervals` without a reset (bounds staleness when the
 *                  battery neither empties nor reports SoC for a long time).
 * Any residual `Q` discarded at a non-empty (forced) reset is captured in the `unattribLoss*` buckets
 * so the conservation identity `Σcharged = Σvended + Σunattributed` holds and stays auditable.
 *
 * Deterministic and side-effect free (like `lib/run-tracking/detect.ts`) so it can be property-tested
 * in isolation and the engine + offline replay compute identical values by construction.
 */

/** Per-5-minute interval inputs to the fold. Energies are kWh (already integrated over the interval). */
export interface FoldInterval {
  /** Solar → battery charge energy this interval (kWh, ≥ 0). */
  solarChargeKwh: number;
  /** Grid → battery charge energy this interval (kWh, ≥ 0). */
  gridChargeKwh: number;
  /** Charge from any OTHER source (generator / allocation residual), kWh ≥ 0. Unknown provenance. */
  otherChargeKwh?: number;
  /** Battery discharge energy this interval (kWh, ≥ 0). */
  dischargeKwh: number;
  /** Grid-import emissions intensity (gCO2/kWh); null = unknown. */
  gridEmissionsIntensity: number | null;
  /** Grid-import renewable fraction (0..1); null = unknown. */
  gridRenewableFraction: number | null;
  /** Grid-import price (c/kWh); null = unknown. May be < 0 (Amber can pay you to import). */
  gridPrice: number | null;
  /** ACTUAL cost assigned to SOLAR charge (c/kWh): 0 = out-of-pocket. Feeds the `costC` accumulator. */
  solarCost: number;
  /**
   * OPPORTUNITY cost assigned to SOLAR charge (c/kWh): typically max(0, feed-in) — the export revenue
   * forgone by charging from solar instead of exporting. Feeds a PARALLEL `costOppC` accumulator so the
   * store carries BOTH bases at once. Undefined → falls back to `solarCost` (opportunity == actual).
   */
  solarCostOpp?: number;
  /** Battery SoC (%) — used only to detect the reserve floor. null = unknown (SoC-blind interval). */
  socPct: number | null;
  /** True if any priced grid input feeding this interval was provisional/estimated (Amber `estimated`). */
  gridEstimated: boolean;
  /**
   * Round-trip efficiency η in effect at THIS interval (0 < η ≤ 1). When set it overrides
   * `FoldConfig.efficiency` — this is the seam for a learned, time-varying η(t) (see `eta.ts`): the shell
   * stamps each interval with the η it learned so a bounded re-fold reproduces the same result. Undefined
   * → the fold falls back to `FoldConfig.efficiency` (a single scalar), then to 1.
   */
  efficiency?: number;
}

export interface FoldConfig {
  /** Reserve-floor SoC % — reset trigger when SoC is present. */
  reserveFloorPct: number;
  /** Round-trip efficiency η (0 < η ≤ 1). Default 1 (losses ignored). */
  efficiency?: number;
  /**
   * Drift backstop: force a reset once a segment has run this many intervals without one. Default
   * Infinity (off). At 5-min intervals, 3 days ≈ 864, 6 days ≈ 1728.
   */
  maxSegmentIntervals?: number;
  /**
   * E-minimum re-anchor threshold (kWh). When `E` drains to ≤ this after discharge, treat the battery
   * as bottomed out and reset (SoC-free). Default 0 (reset only at exactly-empty). A small value
   * (e.g. 0.2) cleans tiny residual "zombie" inventory left by η mis-estimates.
   */
  reanchorEpsKwh?: number;
}

/** Why a reset fired at an interval. */
export type ResetTrigger = "empty" | "soc-floor" | "backstop";

/** The blended state carried across intervals (reset-relative inventory) + cumulative diagnostics. */
export interface FoldState {
  // ── active segment (reset-relative) ──
  /** E — deliverable stored energy since the last reset (kWh, ≥ 0). */
  storedKwh: number;
  /** Qc — total carbon in the store (gCO2). */
  carbonG: number;
  /** Qr — renewable-energy content of the store (kWh). */
  renewableKwh: number;
  /** Qm — ACTUAL (out-of-pocket) cost basis of the store (cents, signed). */
  costC: number;
  /** Qm(opp) — OPPORTUNITY cost basis of the store (cents, signed); solar priced at forgone feed-in. */
  costOppC: number;
  /** E_est — portion of the stored energy whose provenance was estimated/provisional (kWh). */
  estimatedKwh: number;
  /** Floor/backstop was hit; the accumulators reset at the next charge. */
  pendingReset: boolean;
  /** Trigger that latched `pendingReset` (applied on the next charge). */
  pendingTrigger: ResetTrigger | null;
  /** Intervals since the last reset (segment age). */
  segmentIntervals: number;
  /** Max `E` reached in the current segment (kWh) — a usable-capacity probe. */
  segmentPeakKwh: number;

  // ── cumulative diagnostics (whole fold; for RTE, loss accounting, self-audit) ──
  /** Σ charge into the battery (kWh) — before η. */
  totalChargeKwh: number;
  /** Σ discharge out of the battery (kWh). */
  totalDischargeKwh: number;
  /** Largest usable capacity seen (max segment peak, kWh). */
  maxObservedCapacityKwh: number;
  /** Round-trip-loss OVERHEAD (a decomposition of delivered cost; (1−η)·charge footprint). */
  roundtripLossKwh: number;
  roundtripLossG: number;
  roundtripLossC: number;
  roundtripLossOppC: number;
  roundtripLossRenewKwh: number;
  /** UNATTRIBUTED loss — residual Q discarded at a forced (non-empty) reset (drift / η error). */
  unattribLossKwh: number;
  unattribLossG: number;
  unattribLossC: number;
  unattribLossOppC: number;
  unattribLossRenewKwh: number;
  /** Count of resets by trigger (diagnostics). */
  resetsEmpty: number;
  resetsSocFloor: number;
  resetsBackstop: number;
}

/** Per-interval output. Intensities are null when the store is empty (E == 0 → nothing to vend). */
export interface FoldStep {
  /** Vended blend at this interval: Qc/E (gCO2/kWh). */
  batteryEmissionsIntensity: number | null;
  /** Vended blend: Qr/E (0..1). */
  batteryRenewableFraction: number | null;
  /** Vended blend: Qm/E (c/kWh) — ACTUAL (out-of-pocket) cost basis. */
  batteryPrice: number | null;
  /** Vended blend: Qm(opp)/E (c/kWh) — OPPORTUNITY cost basis (solar @ forgone feed-in). */
  batteryPriceOpportunity: number | null;
  /** E after this interval (kWh). */
  storedKwh: number;
  /** Energy actually vended this interval (min(discharge, E), kWh). */
  dischargedKwh: number;
  /** A reset was applied at this interval. */
  resetHere: boolean;
  /** Which trigger fired (null when no reset). */
  resetTrigger: ResetTrigger | null;
  /** Fraction of the vended blend that is tainted by an estimated input (E_est/E, 0..1). */
  estimatedFraction: number;
  /** Intervals since the last reset, as of this interval. */
  segmentIntervals: number;
}

export const INITIAL_FOLD_STATE: FoldState = Object.freeze({
  storedKwh: 0,
  carbonG: 0,
  renewableKwh: 0,
  costC: 0,
  costOppC: 0,
  estimatedKwh: 0,
  pendingReset: false,
  pendingTrigger: null,
  segmentIntervals: 0,
  segmentPeakKwh: 0,
  totalChargeKwh: 0,
  totalDischargeKwh: 0,
  maxObservedCapacityKwh: 0,
  roundtripLossKwh: 0,
  roundtripLossG: 0,
  roundtripLossC: 0,
  roundtripLossOppC: 0,
  roundtripLossRenewKwh: 0,
  unattribLossKwh: 0,
  unattribLossG: 0,
  unattribLossC: 0,
  unattribLossOppC: 0,
  unattribLossRenewKwh: 0,
  resetsEmpty: 0,
  resetsSocFloor: 0,
  resetsBackstop: 0,
});

/** Advance the fold by one interval. See the module header for the ordering rationale. */
export function foldStep(
  state: FoldState,
  iv: FoldInterval,
  config: FoldConfig,
): { next: FoldState; step: FoldStep } {
  const eta = iv.efficiency ?? config.efficiency ?? 1;
  const maxSeg = config.maxSegmentIntervals ?? Infinity;
  const eps = config.reanchorEpsKwh ?? 0;
  const s = { ...state };

  // 1. Latch a reset: SoC floor (drift correction), or the drift backstop (staleness cap).
  if (iv.socPct !== null && iv.socPct <= config.reserveFloorPct) {
    s.pendingReset = true;
    s.pendingTrigger = "soc-floor";
  }
  if (s.segmentIntervals >= maxSeg && !s.pendingReset) {
    s.pendingReset = true;
    s.pendingTrigger = "backstop";
  }

  // 2. Discharge at the current blend (proportional draw-down; intensities unchanged).
  const iC = s.storedKwh > 0 ? s.carbonG / s.storedKwh : null;
  const iR = s.storedKwh > 0 ? s.renewableKwh / s.storedKwh : null;
  const iM = s.storedKwh > 0 ? s.costC / s.storedKwh : null;
  const iMOpp = s.storedKwh > 0 ? s.costOppC / s.storedKwh : null;
  const estFrac = s.storedKwh > 0 ? s.estimatedKwh / s.storedKwh : 0;
  const dEff = Math.max(0, Math.min(iv.dischargeKwh, s.storedKwh));
  if (s.storedKwh > 0 && dEff > 0) {
    const frac = dEff / s.storedKwh;
    s.storedKwh -= dEff;
    s.carbonG -= s.carbonG * frac;
    s.renewableKwh -= s.renewableKwh * frac;
    s.costC -= s.costC * frac;
    s.costOppC -= s.costOppC * frac;
    s.estimatedKwh -= s.estimatedKwh * frac;
  }
  s.totalDischargeKwh += dEff;

  const step: FoldStep = {
    batteryEmissionsIntensity: iC,
    batteryRenewableFraction: iR,
    batteryPrice: iM,
    batteryPriceOpportunity: iMOpp,
    storedKwh: s.storedKwh,
    dischargedKwh: dEff,
    resetHere: false,
    resetTrigger: null,
    estimatedFraction: estFrac,
    segmentIntervals: s.segmentIntervals,
  };

  // helper: discard the current store to the unattributed-loss buckets and zero the segment.
  const resetSegment = (trigger: ResetTrigger) => {
    s.unattribLossKwh += s.storedKwh;
    s.unattribLossG += s.carbonG;
    s.unattribLossC += s.costC;
    s.unattribLossOppC += s.costOppC;
    s.unattribLossRenewKwh += s.renewableKwh;
    s.storedKwh = 0;
    s.carbonG = 0;
    s.renewableKwh = 0;
    s.costC = 0;
    s.costOppC = 0;
    s.estimatedKwh = 0;
    s.segmentIntervals = 0;
    s.segmentPeakKwh = 0;
    s.pendingReset = false;
    s.pendingTrigger = null;
    step.resetHere = true;
    step.resetTrigger = trigger;
    if (trigger === "empty") s.resetsEmpty++;
    else if (trigger === "soc-floor") s.resetsSocFloor++;
    else s.resetsBackstop++;
  };

  // 3. Empty re-anchor (SoC-free bottom-out): E drained to ≤ eps → reset now. Residual ≈ 0 when η
  //    is right, but captured to unattributed loss for audit if not.
  if (
    s.storedKwh <= eps &&
    s.storedKwh >= 0 &&
    s.segmentIntervals > 0 &&
    !step.resetHere
  ) {
    // Only treat as a bottom-out if the segment actually held energy at some point.
    if (s.segmentPeakKwh > eps) resetSegment("empty");
  }

  // 4. Apply a latched forced reset at the first charge after the floor/backstop.
  const otherCharge = iv.otherChargeKwh ?? 0;
  const charge = iv.solarChargeKwh + iv.gridChargeKwh + otherCharge;
  if (s.pendingReset && charge > 0 && !step.resetHere) {
    resetSegment(s.pendingTrigger ?? "soc-floor");
  }

  // 5. Charge mixing (scheme "loss priced into delivered"): E grows by the deliverable η·charge, Q by
  //    the FULL footprint; the (1−η) overhead is tallied as a diagnostic decomposition.
  if (charge > 0) {
    s.totalChargeKwh += charge;
    s.storedKwh += eta * charge;

    const addC =
      iv.gridChargeKwh > 0 && iv.gridEmissionsIntensity !== null
        ? iv.gridChargeKwh * iv.gridEmissionsIntensity
        : 0;
    const addR =
      iv.solarChargeKwh * 1 +
      (iv.gridChargeKwh > 0 && iv.gridRenewableFraction !== null
        ? iv.gridChargeKwh * iv.gridRenewableFraction
        : 0);
    // Grid cost is shared by both bases; solar differs (actual @ solarCost, opportunity @ solarCostOpp).
    const gridM =
      iv.gridChargeKwh > 0 && iv.gridPrice !== null
        ? iv.gridChargeKwh * iv.gridPrice
        : 0;
    const solarCostOpp = iv.solarCostOpp ?? iv.solarCost;
    const addM = iv.solarChargeKwh * iv.solarCost + gridM;
    const addMOpp = iv.solarChargeKwh * solarCostOpp + gridM;

    // Emissions & cost are INTENSITIES (per kWh): the "loss priced into delivered" scheme adds the
    // FULL footprint so delivered kWh carry the round-trip loss (Qc/E, Qm/E inflate by 1/η). Renewable
    // is a bounded PROPORTION, loss-invariant (losses scale renewable & non-renewable alike) — so its
    // deliverable content scales with E by η, keeping Qr/E in [0,1]. (100 % renewable in → 100 % out.)
    s.carbonG += addC;
    s.renewableKwh += eta * addR;
    s.costC += addM;
    s.costOppC += addMOpp;

    s.roundtripLossKwh += (1 - eta) * charge;
    s.roundtripLossG += (1 - eta) * addC;
    s.roundtripLossC += (1 - eta) * addM;
    s.roundtripLossOppC += (1 - eta) * addMOpp;
    s.roundtripLossRenewKwh += (1 - eta) * addR;

    const gridUnknown =
      iv.gridEmissionsIntensity === null ||
      iv.gridRenewableFraction === null ||
      iv.gridPrice === null;
    if (iv.gridChargeKwh > 0 && (iv.gridEstimated || gridUnknown)) {
      s.estimatedKwh += eta * iv.gridChargeKwh;
    }
    if (otherCharge > 0) s.estimatedKwh += eta * otherCharge;
  }

  // 6. Advance segment age + capacity probe.
  s.segmentIntervals += 1;
  if (s.storedKwh > s.segmentPeakKwh) s.segmentPeakKwh = s.storedKwh;
  if (s.segmentPeakKwh > s.maxObservedCapacityKwh)
    s.maxObservedCapacityKwh = s.segmentPeakKwh;

  step.storedKwh = s.storedKwh;
  step.segmentIntervals = s.segmentIntervals;
  return { next: s, step };
}

/**
 * Fold a sequence of intervals from an initial state (default: empty). Returns one {@link FoldStep}
 * per interval plus the final state (cumulative diagnostics + the anchor for a bounded re-fold).
 */
export function foldBatteryProvenance(
  intervals: FoldInterval[],
  config: FoldConfig,
  initial: FoldState = INITIAL_FOLD_STATE,
): { steps: FoldStep[]; finalState: FoldState } {
  let state = initial;
  const steps: FoldStep[] = new Array(intervals.length);
  for (let i = 0; i < intervals.length; i++) {
    const { next, step } = foldStep(state, intervals[i], config);
    steps[i] = step;
    state = next;
  }
  return { steps, finalState: state };
}
