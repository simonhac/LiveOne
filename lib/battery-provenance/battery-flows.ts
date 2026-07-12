/**
 * Derive per-interval battery charge/discharge energies (and the solar-vs-grid split of the charge)
 * from the same canonical `FlowSeries` the energy-flow matrix uses — NO database, NO IO.
 *
 * The split MUST come from the flow-matrix allocation rule (a source's instantaneous share of total
 * generation), because only that rule knows how much of a charge interval came from solar vs grid.
 * This mirrors `computeFlowMatrix`'s convention exactly (trapezoidal load energy, LEFT-endpoint source
 * proportion) so the fold's charge/discharge totals stay consistent with `point_readings_flow_1d`'s
 * `load.battery` / `source.battery` cells.
 *
 * Discharge is taken directly from the `source.battery` series (its integrated energy), not from the
 * allocation row-sum, so it equals the energy that physically left the battery.
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

/** Left-endpoint power (kW) at interval i, treating null as 0 for the generation-share DENOMINATOR. */
function leftPower(series: FlowSeries, i: number): number {
  const v = series.power[i];
  return v === null ? 0 : v;
}

/**
 * Left-endpoint power for the NUMERATOR (a source's allocated share), gated on BOTH endpoints being
 * non-null — matching `computeFlowMatrix`, which skips a source from allocation when either endpoint
 * is null (while still counting its left endpoint in the denominator). Without this gate a source with
 * a valid left / null right endpoint (a mid-interval data gap) would be over-credited into the battery
 * and diverge from `point_readings_flow_1d`'s cells; here that share falls through to `otherChargeKwh`.
 */
function pairedLeftPower(series: FlowSeries, i: number): number {
  const a = series.power[i];
  const b = series.power[i + 1];
  return a === null || b === null ? 0 : a;
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
      ? trapezoidKwh(batterySource.power, i, dtHours)
      : 0;

    const chargeTotal = batteryLoad
      ? trapezoidKwh(batteryLoad.power, i, dtHours)
      : 0;

    let solarChargeKwh = 0;
    let gridChargeKwh = 0;
    let otherChargeKwh = 0;

    if (chargeTotal > 0) {
      // Total instantaneous generation at the interval's left endpoint (matches computeFlowMatrix).
      let totalGen = 0;
      for (const s of sources) totalGen += leftPower(s, i);

      if (totalGen > 0) {
        // Numerator uses the both-endpoints gate (matches computeFlowMatrix); denominator keeps all
        // sources' left endpoints. A source with a null right endpoint drops out of solar/grid and its
        // share falls through to otherChargeKwh (unknown provenance), never mis-credited as clean solar.
        let solarPower = 0;
        for (const s of solarSources) solarPower += pairedLeftPower(s, i);
        const gridPower = gridSource ? pairedLeftPower(gridSource, i) : 0;
        solarChargeKwh = chargeTotal * (solarPower / totalGen);
        gridChargeKwh = chargeTotal * (gridPower / totalGen);
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
