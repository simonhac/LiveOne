/**
 * Pure per-run energy attribution — batched, counter-reset safe.
 *
 * Replaces the old generator-events N+1 (one query per event). The DB layer fetches the energy
 * point's readings for the whole recompute window ONCE; this assigns each run its energy by a
 * linear merge over the sorted readings. No DB here.
 *
 * The energy point is a monotonic cumulative counter (point_info.transform='d', e.g. the grid
 * `Import` point), valued in Wh. A run's energy = (last − first) reading within the run window,
 * converted to kWh. A counter reset (a decrease between readings) is handled by summing the
 * forward positive deltas. Fewer than two readings inside a run ⇒ null (unknown ≠ zero).
 *
 * `assignProvenanceToPeriods` integrates cost/emissions/renewable over those SAME counter slices —
 * see its doc for why the run's own metered energy is the right integration basis.
 */
import { roundToThree } from "@/lib/history/format-opennem";
import type { IntensitySeries } from "./intensity";

export interface EnergyReading {
  /** epoch-ms (UTC). */
  tMs: number;
  /** cumulative Wh, or null for an error/missing reading. */
  value: number | null;
}

export interface EnergyWindow {
  startMs: number;
  /** null = open run; its window extends to nowMs. */
  endMs: number | null;
}

const KWH_DP = 1000; // round to 3 decimal places (kWh stored to 3dp)

/** 3dp — the stored precision for kWh, and enough for sub-cent / sub-gram provenance. */
function round3(v: number): number {
  return Math.round(v * KWH_DP) / KWH_DP;
}

/**
 * Energy (kWh, 3dp) for each window, aligned by index. `readings` need not be sorted.
 * For an open window (endMs null) the window upper bound is `nowMs`.
 */
export function assignEnergyToPeriods(
  windows: EnergyWindow[],
  readings: EnergyReading[],
  nowMs: number,
): (number | null)[] {
  const valid = sortValid(readings);

  return windows.map((w) => {
    const inWindow = clipToWindow(valid, w, nowMs);
    if (inWindow.length < 2) return null;
    let wh = 0;
    for (let i = 1; i < inWindow.length; i++) {
      const delta = inWindow[i].value - inWindow[i - 1].value;
      if (delta > 0) wh += delta; // reset-safe: drop negative steps (counter wrap/reboot)
    }
    return round3(wh / 1000);
  });
}

/** Cost (cents), emissions (grams CO₂) and renewable energy (kWh) attributed to one run. */
export interface PeriodProvenance {
  costC: number | null;
  emissionsG: number | null;
  renewableKwh: number | null;
}

/** "Nothing is known about this run's provenance" — the value for an unpriced device. */
export const NO_PROVENANCE: PeriodProvenance = {
  costC: null,
  emissionsG: null,
  renewableKwh: null,
};

/**
 * Per-run cost / emissions / renewable energy — the ENERGY-WEIGHTED INTEGRAL `Σ sliceKwh × factor`
 * over the run, NOT `energy × constant`.
 *
 * Integrates against the SAME cumulative-counter readings `assignEnergyToPeriods` uses, so the
 * slices are the counter's own (~1-minute) steps: finer than the 5-minute flow timeline, aligned
 * with the run's metered energy by construction, and with no partial-interval truncation at the
 * run's edges. A slice is priced at the factor in force at the LATER of its two readings — the
 * instant the counter reports that energy as delivered.
 *
 * Each accumulator is INDEPENDENTLY null when its factor is unknown across the whole run, so a site
 * that configures emissions but no price reports emissions and OMITS cost rather than claiming
 * $0.00. Fewer than two readings ⇒ all null, matching the energy path (unknown ≠ zero).
 *
 * With a constant series (the off-grid generator) this reduces exactly to `energy × factor` — the
 * degenerate case of the same integral, not a separate code path.
 */
export function assignProvenanceToPeriods(
  windows: EnergyWindow[],
  readings: EnergyReading[],
  series: IntensitySeries,
  nowMs: number,
): PeriodProvenance[] {
  const valid = sortValid(readings);

  return windows.map((w) => {
    const inWindow = clipToWindow(valid, w, nowMs);
    if (inWindow.length < 2) return NO_PROVENANCE;

    // Null until a factor is known to apply, then a running sum — so "unknown" and "genuinely
    // zero" stay distinct without a parallel set of `any*` flags to keep in step.
    let costC: number | null = null;
    let emissionsG: number | null = null;
    let renewableKwh: number | null = null;

    for (let i = 1; i < inWindow.length; i++) {
      const delta = inWindow[i].value - inWindow[i - 1].value;
      // The factor is read BEFORE the reset guard on purpose. A run whose counter never advances
      // (an abort a few seconds after start) has a real, known energy of 0.000 kWh — so its cost is
      // a known $0.00, not an unknown. Skipping the read would report energy and provenance
      // differently for the same run, which is the one thing this pair must never do.
      const f = series.at(inWindow[i].tMs);
      // Reset-safe, exactly as the energy path: a negative step is a counter wrap/reboot, not energy.
      const kwh = delta > 0 ? delta / 1000 : 0;
      if (f.priceC != null) costC = (costC ?? 0) + kwh * f.priceC;
      if (f.gPerKwh != null) emissionsG = (emissionsG ?? 0) + kwh * f.gPerKwh;
      if (f.renewable != null)
        renewableKwh = (renewableKwh ?? 0) + kwh * f.renewable;
    }

    // Rounded to the stored 3dp so accumulated float noise (…299999999997 cents) never reaches the
    // column; well below any displayed precision.
    return {
      costC: roundToThree(costC),
      emissionsG: roundToThree(emissionsG),
      renewableKwh: roundToThree(renewableKwh),
    };
  });
}

function sortValid(
  readings: EnergyReading[],
): { tMs: number; value: number }[] {
  return readings
    .filter((r): r is { tMs: number; value: number } => r.value !== null)
    .sort((a, b) => a.tMs - b.tMs);
}

/** The readings inside a run's window; an open window (null end) extends to `nowMs`. */
function clipToWindow(
  sorted: { tMs: number; value: number }[],
  w: EnergyWindow,
  nowMs: number,
): { tMs: number; value: number }[] {
  const endMs = w.endMs ?? nowMs;
  return sorted.filter((r) => r.tMs >= w.startMs && r.tMs <= endMs);
}
