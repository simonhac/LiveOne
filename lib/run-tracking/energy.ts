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
 */

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

function round3(kwh: number): number {
  return Math.round(kwh * KWH_DP) / KWH_DP;
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
  const valid = readings
    .filter((r): r is { tMs: number; value: number } => r.value !== null)
    .sort((a, b) => a.tMs - b.tMs);

  return windows.map((w) => {
    const endMs = w.endMs ?? nowMs;
    const inWindow = valid.filter((r) => r.tMs >= w.startMs && r.tMs <= endMs);
    if (inWindow.length < 2) return null;
    let wh = 0;
    for (let i = 1; i < inWindow.length; i++) {
      const delta = inWindow[i].value - inWindow[i - 1].value;
      if (delta > 0) wh += delta; // reset-safe: drop negative steps (counter wrap/reboot)
    }
    return round3(wh / 1000);
  });
}
