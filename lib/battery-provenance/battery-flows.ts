/**
 * Derive per-interval battery charge/discharge energies (and the solar-vs-grid split of the charge)
 * from the same canonical `FlowSeries` the energy-flow matrix uses — NO database, NO IO.
 *
 * The split MUST come from the flow-matrix allocation rule (a source's share of total generation),
 * because only that rule knows how much of a charge interval came from solar vs grid. This mirrors
 * `computeFlowAccounting`'s convention exactly — per-interval magnitudes are the exact accumulator
 * energies (`FlowSeries.energyKwh`) where present, else trapezoidal power integration; attribution
 * weights are exact energies where present, else left-endpoint power; and `source.battery` is
 * EXCLUDED from `load.battery`'s pool (the linked-source rule — a battery can't charge itself,
 * which with directional accumulator pairs is a live case, not just an endpoint quirk). Keeping
 * this in lock-step with the core is what keeps the fold's charge/discharge totals consistent with
 * `point_readings_flow_attr_1d`'s `load.battery` / `source.battery` cells.
 *
 * Discharge is taken directly from the `source.battery` series (its exact or integrated energy),
 * not from the allocation row-sum, so it equals the energy that physically left the battery.
 *
 * Output is indexed per interval i = [timestamps[i], timestamps[i+1]] (length = timestamps.length − 1).
 */

import type { FlowSeries } from "@/lib/aggregation/flow-matrix-core";

const SOLAR_PARENT = "source.solar";

export interface BatteryIntervalFlows {
  /** Solar → battery charge (kWh). */
  solarChargeKwh: number;
  /** Grid → battery charge (kWh). */
  gridChargeKwh: number;
  /** Charge from any other source, e.g. a generator or allocation residual (kWh). */
  otherChargeKwh: number;
  /** Battery discharge (kWh). */
  dischargeKwh: number;
}

/** Trapezoidal energy (kWh) for interval i from a kW power series; 0 if either endpoint is null. */
function trapezoidKwh(
  power: (number | null)[],
  i: number,
  dtHours: number,
): number {
  const a = power[i];
  const b = power[i + 1];
  if (a === null || b === null) return 0;
  return ((a + b) / 2) * dtHours;
}

/** The series' exact interval energy at i, or null when it has no overlay/datum there. */
function exactAt(series: FlowSeries, i: number): number | null {
  const e = series.energyKwh?.[i];
  return e === null || e === undefined ? null : e;
}

/** Interval magnitude: exact accumulator energy where present, else the trapezoid. */
function intervalKwh(series: FlowSeries, i: number, dtHours: number): number {
  return exactAt(series, i) ?? trapezoidKwh(series.power, i, dtHours);
}

/**
 * Extract per-interval battery flows from assembled source/load `FlowSeries`. Sources are expected to
 * carry the canonical directional paths produced by `buildFlowSeries` (`source.solar*`, `source.grid`,
 * `source.battery`, plus any others such as `source.generator`); loads carry `load.battery`.
 */
export function extractBatteryFlows(
  timestamps: number[],
  sources: FlowSeries[],
  loads: FlowSeries[],
): BatteryIntervalFlows[] {
  const n = timestamps.length;
  const out: BatteryIntervalFlows[] = [];
  if (n < 2) return out;

  const solarSources = sources.filter(
    (s) => s.path === SOLAR_PARENT || s.path.startsWith(SOLAR_PARENT + "."),
  );
  const gridSource = sources.find((s) => s.path === "source.grid") ?? null;
  const batterySource =
    sources.find((s) => s.path === "source.battery") ?? null;
  const batteryLoad = loads.find((l) => l.path === "load.battery") ?? null;

  for (let i = 0; i < n - 1; i++) {
    const dtHours = (timestamps[i + 1] - timestamps[i]) / (1000 * 60 * 60);

    const dischargeKwh = batterySource
      ? intervalKwh(batterySource, i, dtHours)
      : 0;

    const chargeTotal = batteryLoad ? intervalKwh(batteryLoad, i, dtHours) : 0;

    let solarChargeKwh = 0;
    let gridChargeKwh = 0;
    let otherChargeKwh = 0;

    if (chargeTotal > 0) {
      // Same per-interval mode switch as computeFlowAccounting: when ANY series carries exact
      // energy at i, weights are kWh (exact, else left-endpoint × dt); otherwise plain kW left
      // endpoints — bit-for-bit the legacy arithmetic for power-only inputs.
      let anyExact = false;
      for (const s of sources)
        if (exactAt(s, i) !== null) {
          anyExact = true;
          break;
        }
      if (!anyExact)
        for (const l of loads)
          if (exactAt(l, i) !== null) {
            anyExact = true;
            break;
          }

      // Weight helpers mirroring the core: the DENOMINATOR takes a source's best-known magnitude
      // (exact, else left endpoint — even when the right endpoint is null); the NUMERATOR
      // additionally requires both power endpoints when falling back (a mid-interval gap keeps a
      // source in the pool but out of the allocation → its share falls to `otherChargeKwh`,
      // unknown provenance, never mis-credited as clean solar).
      const denomW = (s: FlowSeries): number => {
        const e = anyExact ? exactAt(s, i) : null;
        if (e !== null) return e;
        const p1 = s.power[i];
        if (p1 === null) return 0;
        return anyExact ? p1 * dtHours : p1;
      };
      const numerW = (s: FlowSeries): number => {
        const e = anyExact ? exactAt(s, i) : null;
        if (e !== null) return e;
        const p1 = s.power[i];
        const p2 = s.power[i + 1];
        if (p1 === null || p2 === null) return 0;
        return anyExact ? p1 * dtHours : p1;
      };

      // load.battery's pool EXCLUDES its linked source.battery (the core's linked-source rule).
      let totalGen = 0;
      for (const s of sources) {
        if (s === batterySource) continue;
        totalGen += denomW(s);
      }

      if (totalGen > 0) {
        let solarW = 0;
        for (const s of solarSources) solarW += numerW(s);
        const gridW = gridSource ? numerW(gridSource) : 0;
        solarChargeKwh = chargeTotal * (solarW / totalGen);
        gridChargeKwh = chargeTotal * (gridW / totalGen);
        otherChargeKwh = Math.max(
          0,
          chargeTotal - solarChargeKwh - gridChargeKwh,
        );
      } else {
        // Charging with no measured generation — provenance unknown.
        otherChargeKwh = chargeTotal;
      }
    }

    out.push({ solarChargeKwh, gridChargeKwh, otherChargeKwh, dischargeKwh });
  }

  return out;
}
