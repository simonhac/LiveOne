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
 * ── SoC-anchor overlay (hybrid; engages per-interval ONLY when SoC + a learned capacity are present) ──
 * The reset-relative model has no valid anchor for a battery that never physically empties (it sits
 * high, a generator holds the floor). Such a battery hits neither the `empty` nor `soc-floor` reset, so
 * the crude `backstop` time-cap is the only reset — and it DUMPS the whole live inventory to
 * unattributed loss mid-SoC. To fix this WITHOUT abandoning the power model, an optional overlay pins
 * `E` to the physical usable energy `targetE = (SoC − reserveFloor)/100 · C` each interval (`C` a
 * LEARNED capacity, stamped per-interval like η). A small per-interval nudge (`socSyncGamma`) bleeds the
 * integration drift into the auditable `sync*` buckets instead of the 6-day backstop bonfire; a
 * down-correction scales all accumulators by one factor (provenance-NEUTRAL — vended ratios unchanged);
 * an up-correction injects at the site fallback provenance (`iv.other*`). When SoC or C is absent
 * (`socKnown` false — e.g. a SoC-dark window) the overlay is inert and the fold is byte-identical to the
 * pure power model, and the backstop keeps its only real job (SoC-blind staleness cap).
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
 * ── Three-term loss model (η_c + idle; engages per-interval when the losses learner has values) ──
 * The single round-trip η conflates three physically distinct terms (measured on real registers vs
 * SoC, see `losses.ts`): a CHARGE-side efficiency η_c (~0.94: SoC rises by η_c·charge), a ~1:1
 * discharge, and a small constant IDLE/standby drain (~20 W: BMS + balancing + self-discharge,
 * proportional to TIME not throughput). When `iv.chargeEfficiency` is present it replaces η at the
 * charge seam (same "loss priced into delivered" booking, just the right coefficient), and
 * `iv.idleLossKwh` drains the store pro-rata into the `idleLoss*` buckets each interval — so parked
 * energy pays the standby tax over time instead of charging sources paying it up front. Absent
 * (SoC-blind history, learner not yet run) both are inert and the fold is byte-identical to the
 * single-η model. Conservation extends to
 * `Σcharged + Σsync == Σvended + Σunattributed + ΣidleLoss + Σstored`.
 *
 * ── BMS recalibration snaps ────────────────────────────────────────────────────────────────────
 * A coulomb-counting BMS periodically re-syncs SoC at full charge — SoC steps several pp in one
 * interval with no matching metered energy. The fold tracks the metered deliverable net since the
 * last SoC observation; when the SoC-implied energy diverges from it by more than `recalSnapKwh`,
 * the interval is flagged `recal` and the SoC sync SNAPS `E` to target in ONE step (bypassing the
 * `socSyncGamma` smoothing) — a re-anchor event, not energy. The same detection (in `losses.ts`)
 * excludes that local day from the η/C/losses learners so the phantom energy can't bias the fits.
 *
 * ── Resets & the drift backstop ────────────────────────────────────────────────────────────────
 *  - `empty`     — `E` drains to ≤ `reanchorEpsKwh` (the reserve bottom-out, SoC-free). Primary.
 *  - `soc-floor` — SoC ≤ `reserveFloorPct` (drift correction when SoC is present; lazy: applied at
 *                  the next charge so reserve discharge still vends the real blend).
 *  - `backstop`  — a segment ran `maxSegmentIntervals` without a reset (bounds staleness when the
 *                  battery neither empties nor reports SoC for a long time). Gated to the SoC-BLIND
 *                  path only — with the SoC overlay active, continuous sync already pins `E`.
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
   * forgone by charging from solar instead of exporting. The EXCESS over `solarCost` feeds the
   * `forgoneC` delta accumulator. Undefined → falls back to `solarCost` (no forgone contribution).
   */
  solarCostOpp?: number;
  /** Battery SoC (%) — used to detect the reserve floor AND (with `capacityKwh`) to anchor `E`. null = unknown. */
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
  /**
   * Learned usable capacity `C` (kWh across the full 0→100 % SoC span) in effect this interval, stamped
   * per-interval for reproducibility (like `efficiency`; see `capacity.ts`). null/undefined → NO SoC
   * anchoring (the pure reset-relative power model). Combined with `socPct` it arms the SoC overlay.
   */
  capacityKwh?: number | null;
  /**
   * Fallback provenance for `otherChargeKwh` AND for a SoC-sync up-injection — the site's grid/generator
   * signal for this interval. null ⇒ unknown → books 0 (today's behavior: dilutes without adding carbon).
   */
  otherEmissionsIntensity?: number | null; // gCO2/kWh
  otherRenewableFraction?: number | null; // 0..1
  otherPrice?: number | null; // c/kWh (actual)
  /**
   * CHARGE-side efficiency η_c (0 < η_c ≤ 1) in effect this interval — the three-term loss model's
   * replacement for the round-trip `efficiency` at the charge seam (see module header + `losses.ts`).
   * Stamped per-interval like `efficiency` for reproducibility. null/undefined → the single-η model.
   */
  chargeEfficiency?: number | null;
  /**
   * Idle/standby energy to drain from the store THIS interval (kWh ≥ 0). Precomputed by the caller as
   * `idleKwhPerDay · Δt/24h` (the fold is clock-free and doesn't know interval durations). Booked to the
   * `idleLoss*` buckets pro-rata at the store's own blend. undefined/0 → no idle term (today's model).
   */
  idleLossKwh?: number;
  /**
   * Reserve-floor SoC % in effect this interval — the persisted per-day learned floor (see
   * reserve-floor.ts), stamped per interval like `capacityKwh`. undefined → fall back to the window
   * scalar `FoldConfig.reserveFloorPct`.
   */
  reserveFloorPct?: number;
}

export interface FoldConfig {
  /** Reserve-floor SoC % — reset trigger when SoC is present. */
  reserveFloorPct: number;
  /** Round-trip efficiency η (0 < η ≤ 1). Default 1 (losses ignored). */
  efficiency?: number;
  /**
   * Drift backstop: force a reset once a segment has run this many intervals without one. Default
   * Infinity (off). At 5-min intervals, 3 days ≈ 864, 6 days ≈ 1728. Gated to the SoC-blind path.
   */
  maxSegmentIntervals?: number;
  /**
   * E-minimum re-anchor threshold (kWh). When `E` drains to ≤ this after discharge, treat the battery
   * as bottomed out and reset (SoC-free). Default 0 (reset only at exactly-empty). A small value
   * (e.g. 0.2) cleans tiny residual "zombie" inventory left by η mis-estimates.
   */
  reanchorEpsKwh?: number;
  /** SoC-sync: per-interval fraction of the E↔SoC gap corrected (after the first-of-segment snap). Default 0.2. */
  socSyncGamma?: number;
  /** SoC-sync: ignore gaps below this (SoC quantisation noise), kWh. Default 0.2. */
  socSyncDeadbandKwh?: number;
  /**
   * BMS-recalibration detector: when the SoC-implied energy change since the last SoC observation
   * diverges from the metered deliverable net by more than this (kWh), the interval is a `recal` —
   * the sync snaps E to target in ONE step instead of the γ nudge. Default 2.
   */
  recalSnapKwh?: number;
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
  /**
   * Qsr — SELF-renewable content of the store (kWh): energy that is BOTH behind-the-meter (our own
   * generation) AND renewable. Structurally the twin of `Qr` — a bounded proportion (`Qsr/E ∈ [0,1]`,
   * loss-invariant, scales with `E` by η) — but ONLY solar charge feeds it (grid renewables are
   * renewable but not behind-the-meter, so they grow `Qr` and never `Qsr`). Invariant: `Qsr ≤ Qr` and
   * `Qsr ≤ E` always. Powers the renewables tile's autarky / own-renewable-self-consumption metrics.
   */
  selfRenewableKwh: number;
  /** Qm — ACTUAL (out-of-pocket) cost basis of the store (cents, signed). */
  costC: number;
  /**
   * Qf — forgone export revenue in the store (cents): the ADDITIONAL amount over the actual basis that
   * charging from solar gave up vs exporting. An independent delta accumulator (not a second full
   * basis); only solar charge contributes (`solarCostOpp − solarCost`), everything else scales it in
   * lockstep with `costC`. The full opportunity basis, if ever wanted, is `costC + forgoneC`. It is
   * ≥ 0 given the producer invariant `solarCostOpp ≥ solarCost` (compute.ts floors the feed-in at 0
   * with solarCost≡0); the fold itself neither types nor clamps that, so a caller that priced solar's
   * actual cost above its forgone rate could drive it negative.
   */
  forgoneC: number;
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
  /** Intervals since `E` was last validated against SoC; drives the (SoC-blind) backstop cap. */
  intervalsSinceSync: number;
  /** Has this segment done its first full SoC snap yet (the one-time baseline anchor). */
  socAnchored: boolean;

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
  roundtripLossForgoneC: number;
  roundtripLossRenewKwh: number;
  /** Self-renewable twin of `roundtripLossRenewKwh` (loss decomposition of the delivered Qsr). */
  roundtripLossSelfRenewKwh: number;
  /** UNATTRIBUTED loss — residual Q discarded at a forced (non-empty) reset (drift / η error). */
  unattribLossKwh: number;
  unattribLossG: number;
  unattribLossC: number;
  unattribLossForgoneC: number;
  unattribLossRenewKwh: number;
  /** Self-renewable twin of `unattribLossRenewKwh` (Qsr discarded at a forced reset). */
  unattribLossSelfRenewKwh: number;
  /**
   * IDLE/standby loss — the constant self-discharge drain (three-term model), removed from the store
   * pro-rata at its own blend each interval. A REAL physical loss (unlike `sync*`, a correction):
   * conservation reads `Σcharged + Σsync == Σvended + Σunattributed + ΣidleLoss + Σstored`.
   */
  idleLossKwh: number;
  idleLossG: number;
  idleLossC: number;
  idleLossForgoneC: number;
  idleLossRenewKwh: number;
  /** Self-renewable twin of `idleLossRenewKwh` (Qsr drained by the standby loss). */
  idleLossSelfRenewKwh: number;
  /**
   * SoC-SYNC correction — signed energy/carbon/etc. the SoC overlay injected(+)/removed(−) to pin `E`
   * to physical. A DISTINCT, auditable category from `unattribLoss*`: a down-sync is provenance-neutral
   * (vended ratios unchanged) and replaces the backstop dump; the conservation identity becomes
   * `Σcharged + Σsync == Σvended + Σunattributed + Σstored`.
   */
  syncKwh: number;
  syncG: number;
  syncRenewKwh: number;
  /** Self-renewable twin of `syncRenewKwh` (Qsr moved by a SoC-anchor correction). */
  syncSelfRenewKwh: number;
  syncC: number;
  syncForgoneC: number;
  /** Count of intervals a sync correction was applied (diagnostic). */
  syncEvents: number;
  /** Count of BMS-recalibration snap events (one-step re-anchors; see `recalSnapKwh`). */
  recalEvents: number;
  /** Count of resets by trigger (diagnostics). */
  resetsEmpty: number;
  resetsSocFloor: number;
  resetsBackstop: number;
  /**
   * Recal-detector carry: the last OBSERVED SoC (%) and the metered deliverable net (kWh, signed)
   * accumulated since that observation. PHYSICAL state — survives segment resets (unlike the
   * segment-relative fields above). null / 0 until the first SoC observation.
   */
  prevSocPct: number | null;
  netSinceSocKwh: number;
}

/** Per-interval output. Intensities are null when the store is empty (E == 0 → nothing to vend). */
export interface FoldStep {
  /** Vended blend at this interval: Qc/E (gCO2/kWh). */
  batteryEmissionsIntensity: number | null;
  /** Vended blend: Qr/E (0..1). */
  batteryRenewableFraction: number | null;
  /** Vended blend: Qsr/E (0..1) — the SELF-renewable (behind-the-meter AND renewable) fraction. */
  batterySelfRenewableFraction: number | null;
  /** Vended blend: Qm/E (c/kWh) — ACTUAL (out-of-pocket) cost basis. */
  batteryPrice: number | null;
  /** Vended forgone-revenue component: Qf/E (c/kWh) — what the written `price-opportunity` point carries. */
  batteryPriceForgone: number | null;
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
  /** Signed energy the SoC sync moved THIS interval (+injected / −removed; for the replay panel). */
  syncKwh: number;
  /** A BMS-recalibration snap fired at this interval (one-step SoC re-anchor). */
  recalHere: boolean;
}

export const INITIAL_FOLD_STATE: FoldState = Object.freeze({
  storedKwh: 0,
  carbonG: 0,
  renewableKwh: 0,
  selfRenewableKwh: 0,
  costC: 0,
  forgoneC: 0,
  estimatedKwh: 0,
  pendingReset: false,
  pendingTrigger: null,
  segmentIntervals: 0,
  segmentPeakKwh: 0,
  intervalsSinceSync: 0,
  socAnchored: false,
  totalChargeKwh: 0,
  totalDischargeKwh: 0,
  maxObservedCapacityKwh: 0,
  roundtripLossKwh: 0,
  roundtripLossG: 0,
  roundtripLossC: 0,
  roundtripLossForgoneC: 0,
  roundtripLossRenewKwh: 0,
  roundtripLossSelfRenewKwh: 0,
  unattribLossKwh: 0,
  unattribLossG: 0,
  unattribLossC: 0,
  unattribLossForgoneC: 0,
  unattribLossRenewKwh: 0,
  unattribLossSelfRenewKwh: 0,
  idleLossKwh: 0,
  idleLossG: 0,
  idleLossC: 0,
  idleLossForgoneC: 0,
  idleLossRenewKwh: 0,
  idleLossSelfRenewKwh: 0,
  syncKwh: 0,
  syncG: 0,
  syncRenewKwh: 0,
  syncSelfRenewKwh: 0,
  syncC: 0,
  syncForgoneC: 0,
  syncEvents: 0,
  recalEvents: 0,
  resetsEmpty: 0,
  resetsSocFloor: 0,
  resetsBackstop: 0,
  prevSocPct: null,
  netSinceSocKwh: 0,
});

/** Advance the fold by one interval. See the module header for the ordering rationale. */
export function foldStep(
  state: FoldState,
  iv: FoldInterval,
  config: FoldConfig,
): { next: FoldState; step: FoldStep } {
  // Charge-seam efficiency: the learned CHARGE-side η_c (three-term model) when present, else the
  // single round-trip η — same booking scheme either way, just the right coefficient.
  const eta = iv.chargeEfficiency ?? iv.efficiency ?? config.efficiency ?? 1;
  const maxSeg = config.maxSegmentIntervals ?? Infinity;
  const eps = config.reanchorEpsKwh ?? 0;
  const gamma = config.socSyncGamma ?? 0.2;
  const deadband = config.socSyncDeadbandKwh ?? 0.2;
  const recalSnap = config.recalSnapKwh ?? 2;
  const C = iv.capacityKwh ?? null;
  const reserveFloorPct = iv.reserveFloorPct ?? config.reserveFloorPct;
  const socKnown = iv.socPct !== null && C !== null && C > 0;
  const s = { ...state };

  // 1. Latch a reset: SoC floor (drift correction), or the drift backstop (staleness cap; SoC-blind only —
  //    with the SoC overlay active, continuous sync already pins E, so the periodic dump is redundant).
  if (iv.socPct !== null && iv.socPct <= reserveFloorPct) {
    s.pendingReset = true;
    s.pendingTrigger = "soc-floor";
  }
  if (!socKnown && s.intervalsSinceSync >= maxSeg && !s.pendingReset) {
    s.pendingReset = true;
    s.pendingTrigger = "backstop";
  }

  // 2. Discharge at the current blend (proportional draw-down; intensities unchanged).
  const iC = s.storedKwh > 0 ? s.carbonG / s.storedKwh : null;
  const iR = s.storedKwh > 0 ? s.renewableKwh / s.storedKwh : null;
  const iSr = s.storedKwh > 0 ? s.selfRenewableKwh / s.storedKwh : null;
  const iM = s.storedKwh > 0 ? s.costC / s.storedKwh : null;
  const iF = s.storedKwh > 0 ? s.forgoneC / s.storedKwh : null;
  const estFrac = s.storedKwh > 0 ? s.estimatedKwh / s.storedKwh : 0;
  const dEff = Math.max(0, Math.min(iv.dischargeKwh, s.storedKwh));
  if (s.storedKwh > 0 && dEff > 0) {
    const frac = dEff / s.storedKwh;
    s.storedKwh -= dEff;
    s.carbonG -= s.carbonG * frac;
    s.renewableKwh -= s.renewableKwh * frac;
    s.selfRenewableKwh -= s.selfRenewableKwh * frac;
    s.costC -= s.costC * frac;
    s.forgoneC -= s.forgoneC * frac;
    s.estimatedKwh -= s.estimatedKwh * frac;
  }
  s.totalDischargeKwh += dEff;

  const step: FoldStep = {
    batteryEmissionsIntensity: iC,
    batteryRenewableFraction: iR,
    batterySelfRenewableFraction: iSr,
    batteryPrice: iM,
    batteryPriceForgone: iF,
    storedKwh: s.storedKwh,
    dischargedKwh: dEff,
    resetHere: false,
    resetTrigger: null,
    estimatedFraction: estFrac,
    segmentIntervals: s.segmentIntervals,
    syncKwh: 0,
    recalHere: false,
  };

  // helper: discard the current store to the unattributed-loss buckets and zero the segment.
  const resetSegment = (trigger: ResetTrigger) => {
    s.unattribLossKwh += s.storedKwh;
    s.unattribLossG += s.carbonG;
    s.unattribLossC += s.costC;
    s.unattribLossForgoneC += s.forgoneC;
    s.unattribLossRenewKwh += s.renewableKwh;
    s.unattribLossSelfRenewKwh += s.selfRenewableKwh;
    s.storedKwh = 0;
    s.carbonG = 0;
    s.renewableKwh = 0;
    s.selfRenewableKwh = 0;
    s.costC = 0;
    s.forgoneC = 0;
    s.estimatedKwh = 0;
    s.segmentIntervals = 0;
    s.segmentPeakKwh = 0;
    s.intervalsSinceSync = 0;
    s.socAnchored = false;
    s.pendingReset = false;
    s.pendingTrigger = null;
    step.resetHere = true;
    step.resetTrigger = trigger;
    if (trigger === "empty") s.resetsEmpty++;
    else if (trigger === "soc-floor") s.resetsSocFloor++;
    else s.resetsBackstop++;
  };

  // helper: pin E toward the SoC-derived physical target. Both directions are PROVENANCE-NEUTRAL when the
  // store holds energy — they scale every accumulator by one factor, so every vended ratio (carbon/renewable
  // /price intensity) is invariant and only the MAGNITUDE is corrected. The signed correction books to the
  // `sync*` buckets, NOT `unattribLoss` (a labelled drift correction, not destroyed provenance). Untracked
  // energy therefore inherits the store's OWN mix — the best estimate of what charged this battery (a
  // solar-charged store stays clean; the fold does not fabricate generator carbon). ONLY when the store is
  // empty (no blend to inherit — the one-time segment-start baseline) does an up-correction seed from the
  // site fallback provenance (`iv.other*`); that baseline washes out over the warmup as the battery cycles.
  const applySync = (delta: number) => {
    if (delta === 0) return;
    if (delta < 0 || s.storedKwh > 1e-9) {
      // Scale the store (up or down) at its current blend — provenance-neutral.
      const scale = Math.max(
        0,
        (s.storedKwh + delta) / Math.max(s.storedKwh, 1e-9),
      );
      s.syncG += s.carbonG * (scale - 1);
      s.syncRenewKwh += s.renewableKwh * (scale - 1);
      s.syncSelfRenewKwh += s.selfRenewableKwh * (scale - 1);
      s.syncC += s.costC * (scale - 1);
      s.syncForgoneC += s.forgoneC * (scale - 1);
      s.carbonG *= scale;
      s.renewableKwh *= scale;
      s.selfRenewableKwh *= scale;
      s.costC *= scale;
      s.forgoneC *= scale;
      if (delta < 0) s.estimatedKwh *= scale;
      else s.estimatedKwh += delta; // injected (up) energy is estimated provenance
      s.storedKwh += delta;
    } else {
      // Empty store, up-correction: seed the baseline from the site fallback provenance (the only signal).
      const fbEI = iv.otherEmissionsIntensity ?? null;
      const fbR = iv.otherRenewableFraction ?? null;
      const fbM = iv.otherPrice ?? null;
      s.storedKwh += delta;
      if (fbEI !== null) {
        s.carbonG += delta * fbEI;
        s.syncG += delta * fbEI;
      }
      if (fbR !== null) {
        s.renewableKwh += delta * fbR;
        s.syncRenewKwh += delta * fbR;
      }
      // No self-renewable contribution: the site fallback (grid / generator) is never behind-the-meter
      // renewable, so Qsr stays 0 on an up-injection — which is also what keeps `Qsr ≤ Qr` (Qr may take
      // a non-zero grid-renewable fallback here).
      if (fbM !== null) {
        s.costC += delta * fbM;
        s.syncC += delta * fbM;
      }
      // No forgone contribution: seeded energy wasn't stored solar, so nothing was given up.
      s.estimatedKwh += delta;
    }
    s.syncKwh += delta;
    step.syncKwh += delta;
    s.syncEvents++;
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
  //    the FULL footprint; the (1−η) overhead is tallied as a diagnostic decomposition. `otherCharge`
  //    (unattributed) is booked at the site fallback provenance (`iv.other*`) so its carbon and renewable
  //    RECONCILE — a null fallback keeps today's "clean-but-non-renewable" behavior (documented, off-gate).
  if (charge > 0) {
    s.totalChargeKwh += charge;
    s.storedKwh += eta * charge;

    const oEI = iv.otherEmissionsIntensity ?? null;
    const oR = iv.otherRenewableFraction ?? null;
    const oP = iv.otherPrice ?? null;
    const otherC = otherCharge > 0 && oEI !== null ? otherCharge * oEI : 0;
    const otherRn = otherCharge > 0 && oR !== null ? otherCharge * oR : 0;
    const otherM = otherCharge > 0 && oP !== null ? otherCharge * oP : 0;

    const addC =
      (iv.gridChargeKwh > 0 && iv.gridEmissionsIntensity !== null
        ? iv.gridChargeKwh * iv.gridEmissionsIntensity
        : 0) + otherC;
    const addR =
      iv.solarChargeKwh * 1 +
      (iv.gridChargeKwh > 0 && iv.gridRenewableFraction !== null
        ? iv.gridChargeKwh * iv.gridRenewableFraction
        : 0) +
      otherRn;
    // Self-renewable (behind-the-meter AND renewable): ONLY solar charge qualifies. Grid renewables are
    // renewable but not behind-the-meter; `otherCharge` (generator / residual) is neither. So `addSr`
    // takes just the solar term — structurally `addR` minus its grid/other renewable contributions.
    const addSr = iv.solarChargeKwh * 1;
    // Only solar contributes to the forgone delta (grid/other cost the same on either basis).
    const gridM =
      iv.gridChargeKwh > 0 && iv.gridPrice !== null
        ? iv.gridChargeKwh * iv.gridPrice
        : 0;
    const solarCostOpp = iv.solarCostOpp ?? iv.solarCost;
    const addM = iv.solarChargeKwh * iv.solarCost + gridM + otherM;
    const addF = iv.solarChargeKwh * (solarCostOpp - iv.solarCost);

    // Emissions & cost are INTENSITIES (per kWh): the "loss priced into delivered" scheme adds the
    // FULL footprint so delivered kWh carry the round-trip loss (Qc/E, Qm/E inflate by 1/η). Renewable
    // is a bounded PROPORTION, loss-invariant (losses scale renewable & non-renewable alike) — so its
    // deliverable content scales with E by η, keeping Qr/E in [0,1]. (100 % renewable in → 100 % out.)
    s.carbonG += addC;
    s.renewableKwh += eta * addR;
    // Self-renewable is a bounded proportion like renewable — its deliverable content scales with E by η
    // (never the 1/η intensity inflation), keeping Qsr/E in [0,1].
    s.selfRenewableKwh += eta * addSr;
    s.costC += addM;
    s.forgoneC += addF;

    s.roundtripLossKwh += (1 - eta) * charge;
    s.roundtripLossG += (1 - eta) * addC;
    s.roundtripLossC += (1 - eta) * addM;
    s.roundtripLossForgoneC += (1 - eta) * addF;
    s.roundtripLossRenewKwh += (1 - eta) * addR;
    s.roundtripLossSelfRenewKwh += (1 - eta) * addSr;

    const gridUnknown =
      iv.gridEmissionsIntensity === null ||
      iv.gridRenewableFraction === null ||
      iv.gridPrice === null;
    if (iv.gridChargeKwh > 0 && (iv.gridEstimated || gridUnknown)) {
      s.estimatedKwh += eta * iv.gridChargeKwh;
    }
    if (otherCharge > 0) s.estimatedKwh += eta * otherCharge;
  }

  // 5.4. Idle/standby drain (three-term model): a small constant self-discharge removed from the store
  //      pro-rata at its OWN blend — a real physical loss booked to the `idleLoss*` buckets (parked
  //      energy pays the standby tax over time). Inert when the losses learner hasn't run (undefined/0).
  const idle = Math.min(Math.max(iv.idleLossKwh ?? 0, 0), s.storedKwh);
  if (idle > 0) {
    const frac = idle / s.storedKwh;
    s.idleLossKwh += idle;
    s.idleLossG += s.carbonG * frac;
    s.idleLossRenewKwh += s.renewableKwh * frac;
    s.idleLossSelfRenewKwh += s.selfRenewableKwh * frac;
    s.idleLossC += s.costC * frac;
    s.idleLossForgoneC += s.forgoneC * frac;
    s.storedKwh -= idle;
    s.carbonG *= 1 - frac;
    s.renewableKwh *= 1 - frac;
    s.selfRenewableKwh *= 1 - frac;
    s.costC *= 1 - frac;
    s.forgoneC *= 1 - frac;
    s.estimatedKwh *= 1 - frac;
  }

  // Recal-detector carry: metered deliverable net since the last SoC OBSERVATION (full metered
  // discharge, not dEff — physical SoC falls even when the model store is empty).
  s.netSinceSocKwh += eta * charge - iv.dischargeKwh - idle;

  // 5.5. SoC anchor/sync (overlay; only when socPct + a learned capacity are present). Pin E to the
  //      physical usable energy above the reserve; the first interval of a segment SNAPS (one-time
  //      baseline anchor), later intervals nudge by `gamma` outside a deadband. Corrections book to the
  //      auditable `sync*` buckets — this is what replaces the backstop dump for a never-emptying battery.
  //      A BMS RECALIBRATION (SoC-implied energy since the last observation diverging from the metered
  //      net by > recalSnapKwh — e.g. the snap-to-100 at full charge) also does a ONE-STEP snap: it is a
  //      re-anchor event, not energy, and smearing it over 1/γ intervals would misprice the blend.
  if (socKnown) {
    const recal =
      s.prevSocPct !== null &&
      Math.abs(((iv.socPct! - s.prevSocPct) / 100) * C! - s.netSinceSocKwh) >
        recalSnap;
    if (recal) {
      s.recalEvents++;
      step.recalHere = true;
    }
    const floorE = (reserveFloorPct / 100) * C!;
    const targetE = Math.max(0, (iv.socPct! / 100) * C! - floorE);
    const gap = targetE - s.storedKwh;
    const g = s.socAnchored && !recal ? gamma : 1; // segment start OR a recal: full snap
    if (!s.socAnchored || recal || Math.abs(gap) > deadband) {
      let delta = g * gap;
      if (s.storedKwh + delta < 0) delta = -s.storedKwh;
      applySync(delta);
    }
    s.socAnchored = true;
    s.intervalsSinceSync = 0;
    s.prevSocPct = iv.socPct!;
    s.netSinceSocKwh = 0;
  }

  // 6. Advance segment age + capacity probe.
  s.segmentIntervals += 1;
  s.intervalsSinceSync += 1;
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
