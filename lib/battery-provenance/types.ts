/**
 * Shared types for the battery-provenance engine. The pipeline is:
 *   loadProvenanceInputs(handle, window)  →  ProvenanceInputs   (I/O: bindings + agg_5m + resample)
 *   computeBatteryProvenance(inputs, config)  →  ProvenanceResult   (pure: fold + flow accounting)
 * Both the prod driver and the offline harness call the SAME two functions — they differ only at the
 * edges (which window / write-vs-print). See docs plan (Phase 2).
 */

import type {
  FlowSeries,
  FlowAccountingResult,
  SourceIntensity,
} from "@/lib/aggregation/flow-matrix-core";
import type { FoldStep, FoldState } from "./fold";
import type { EtaDayDiag } from "./eta";
import type { LossesDayDiag } from "./losses";
import type { ExportTariffConfig } from "@/lib/capabilities/config";

export interface ProvenanceWindow {
  startMs: number;
  endMs: number;
}

/**
 * The loaded, resampled substrate for one Area over one window — everything I/O-derived, aligned to a
 * single 5-minute `timeline`. Pure `computeBatteryProvenance` consumes this and touches no DB.
 */
export interface ProvenanceInputs {
  handle: number;
  areaId: string;
  region: string | null; // NEM region (OE) or null when off-NEM
  /** The system that owns the battery (bound battery power point). */
  batterySystemId: number | null;
  /** The Area's fixed standard offset (minutes) — for local-day boundaries in the per-day rollup. */
  timezoneOffsetMin: number;
  timeline: number[]; // ascending epoch-ms, one per 5-min interval end

  // Flow-series inputs for the allocation (POWER, kW, curated via bindings + buildFlowSeries).
  sources: FlowSeries[];
  loads: FlowSeries[];

  // Grid-side per-interval intensities (aligned to timeline).
  gridEmissions: (number | null)[]; // gCO2/kWh
  gridEmissionsEstimated: boolean[];
  gridRenewable: (number | null)[]; // fraction 0..1
  gridPrice: (number | null)[]; // c/kWh (Amber import), may be < 0
  gridPriceEstimated: boolean[];
  gridExportPrice: (number | null)[]; // c/kWh MEASURED Amber feed-in (source for the "amber" tariff mode)

  /**
   * Export (feed-in) tariff selecting the SOLAR OPPORTUNITY-COST source: `none` (default), `amber` (the
   * measured `gridExportPrice` above), or a `schedule` synthesised per interval. `compute` resolves this to
   * a single exportPrice[] series (see `lib/battery-provenance/tariff.ts`); the fold consumes only that.
   * Undefined ⇒ no opportunity cost (the written `price-opportunity` point reads 0). The loader reads it
   * from the battery device's `config.batteryProvenance.exportTariff`.
   */
  exportTariff?: ExportTariffConfig;

  // Battery SoC (optional; may be all-null = SoC-blind) + the derived reserve floor.
  soc: (number | null)[];
  estReservePct: number;

  /**
   * Persisted usable-capacity C(t) per interval (kWh, full 0→100 % SoC span), aligned to `timeline`, read
   * by the loader from the derived `bidi.battery/usable-capacity` helper point (forward-filled daily step,
   * mirrors `etaSeries`). The REPRODUCIBLE capacity seam: C is learned once in the daily shell and read back
   * here so a bounded re-fold gets the same C as a full-history run. Undefined (no persisted point yet) →
   * compute learns an in-window C (non-canonical bootstrap). Combined with a non-null `soc` it arms the
   * SoC-anchor overlay in the fold; absent SoC ⇒ overlay inert (pure power model).
   */
  capacitySeries?: (number | null)[];

  /**
   * ENERGY-REGISTER seam (config: attach an input to a power OR an energy register). When the Area binds
   * battery charge/discharge ENERGY points these carry the exact interval energy (kWh) and are preferred
   * over trapezoidal power integration; undefined → the fold uses the power-integrated split.
   */
  batteryChargeEnergyKwh?: (number | null)[];
  batteryDischargeEnergyKwh?: (number | null)[];

  /**
   * Persisted round-trip efficiency η(t) per interval (0<η≤1), aligned to `timeline`, read by the loader
   * from the derived `bidi.battery/round-trip-efficiency` helper point. The REPRODUCIBLE η seam: η is
   * learned once in the daily shell over a stable window and read back here, so a bounded re-fold gets the
   * same η as a full-history run (repair-convergence holds). Undefined (no persisted point yet) → compute
   * falls back to a config scalar or an in-window learned η (non-canonical bootstrap).
   */
  etaSeries?: (number | null)[];

  /**
   * Persisted three-term loss model (see `losses.ts`): CHARGE-side efficiency η_c(t) (0<η_c≤1) and the
   * constant idle drain (kWh/day), per interval, aligned to `timeline` — read by the loader from the
   * derived `bidi.battery/charge-efficiency` + `bidi.battery/idle-loss` helper points (daily steps,
   * forward-filled). Same reproducibility contract as η/C (learn-in-shell / read-in-fold). Undefined →
   * compute learns them in-window (bootstrap); null entries (warm-up / SoC-blind) → the fold falls back
   * to the single-η model for those intervals, byte-identical.
   */
  chargeEfficiencySeries?: (number | null)[];
  idleLossKwhPerDaySeries?: (number | null)[];

  coverage: { soc: number; emissions: number; price: number };
}

export interface ProvenanceConfig {
  /** Reserve-floor SoC % override; default = `inputs.estReservePct`. */
  reserveFloorPct?: number;
  /** η: a number, or "measured" (default) to learn Σout/Σin from the window's raw energies. */
  efficiency?: number | "measured";
  /** Drift backstop (intervals); default 6 days = 6*288. */
  maxSegmentIntervals?: number;
  /** E-minimum re-anchor threshold (kWh); default 0.3. */
  reanchorEpsKwh?: number;
  /** SoC-sync: per-interval fraction of the E↔SoC gap corrected (after the first-of-segment snap). Default 0.2. */
  socSyncGamma?: number;
  /** SoC-sync: ignore gaps below this (SoC quantisation noise), kWh. Default 0.2. */
  socSyncDeadbandKwh?: number;
  /** BMS-recalibration snap threshold (kWh); default 2. See `FoldConfig.recalSnapKwh`. */
  recalSnapKwh?: number;
}

export interface ProvenanceResult {
  steps: FoldStep[];
  finalState: FoldState;
  /** The full flow accounting: energy (Sankey leg) + attributed emissions/renewable/cost per edge. */
  accounting: FlowAccountingResult;
  /** The per-source intensity series (index-aligned to inputs.sources) — for re-running per-day accounting. */
  sourceIntensities: (SourceIntensity | null)[];
  /** The η actually used: a throughput-weighted summary of the learned η(t), or the configured scalar. */
  etaUsed: number;
  /** Per-local-day learned-η trend (the degradation/hardware-step diagnostic); absent for a scalar η. */
  etaByDay?: EtaDayDiag[];
  /** The reserve floor % actually used. */
  reserveUsed: number;
  /** Physical totals over the window (raw, before η) for the RTE diagnostic. */
  chargeKwh: number;
  dischargeKwh: number;
  /** Total carbon charged INTO the battery (gCO2) — the independent side of the conservation audit. */
  chargedG: number;
  /** Three-term loss model actually in effect (latest applied pair), or null when unarmed (SoC-blind /
   *  warm-up) — the fold used the single-η model for those intervals. */
  etaCUsed: number | null;
  idleKwhPerDayUsed: number | null;
  /** Per-local-day losses-fit trend (diagnostic; produced only on the in-window bootstrap path). */
  lossesByDay?: LossesDayDiag[];
}
