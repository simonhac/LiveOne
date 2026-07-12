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
} from "@/lib/aggregation/flow-matrix-core";
import type { FoldStep, FoldState } from "./fold";

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
  gridExportPrice: (number | null)[]; // c/kWh feed-in (for opportunity solar cost)

  // Battery SoC (optional; may be all-null = SoC-blind) + the derived reserve floor.
  soc: (number | null)[];
  estReservePct: number;

  /**
   * ENERGY-REGISTER seam (config: attach an input to a power OR an energy register). When the Area binds
   * battery charge/discharge ENERGY points these carry the exact interval energy (kWh) and are preferred
   * over trapezoidal power integration; undefined → the fold uses the power-integrated split.
   */
  batteryChargeEnergyKwh?: (number | null)[];
  batteryDischargeEnergyKwh?: (number | null)[];

  coverage: { soc: number; emissions: number; price: number };
}

export interface ProvenanceConfig {
  /** Reserve-floor SoC % override; default = `inputs.estReservePct`. */
  reserveFloorPct?: number;
  /** η: a number, or "measured" (default) to learn Σout/Σin from the window's raw energies. */
  efficiency?: number | "measured";
  /** Solar cost basis; default "zero" (out-of-pocket). */
  solarValuation?: "zero" | "opportunity";
  /** Drift backstop (intervals); default 6 days = 6*288. */
  maxSegmentIntervals?: number;
  /** E-minimum re-anchor threshold (kWh); default 0.3. */
  reanchorEpsKwh?: number;
}

export interface ProvenanceResult {
  steps: FoldStep[];
  finalState: FoldState;
  /** The full flow accounting: energy (Sankey leg) + attributed emissions/renewable/cost per edge. */
  accounting: FlowAccountingResult;
  /** The η actually used (learned or configured). */
  etaUsed: number;
  /** The reserve floor % actually used. */
  reserveUsed: number;
  /** Physical totals over the window (raw, before η) for the RTE diagnostic. */
  chargeKwh: number;
  dischargeKwh: number;
  /** Total carbon charged INTO the battery (gCO2) — the independent side of the conservation audit. */
  chargedG: number;
}
