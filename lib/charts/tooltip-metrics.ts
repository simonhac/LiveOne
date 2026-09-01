/**
 * The four-metric tooltip panel — energy, emissions, cost, renewable — as one builder.
 *
 * Extracted from `SiteChartsCard`'s `buildNodeTooltip`, which had been the only place that knew how
 * a provenance figure is spelled in a tooltip. It now has a second caller: a hovered RUN PERIOD on
 * the stacked chart (an EV charge session) answers exactly the same four questions about exactly the
 * same kWh, and answering them in a second hand-written block is how "$4.80" and "480c" end up on
 * the same screen.
 *
 * The two callers reach these numbers by different routes and that is deliberate, not an oversight
 * being papered over: the Sankey integrates the 5-minute flow matrix, while a run period carries
 * figures accumulated at recompute time against its own metered counter slices (see
 * lib/run-tracking/energy.ts, which documents why the two bases differ slightly for the same span).
 * What must not differ is the PRESENTATION, and that is all this shares.
 */
import {
  formatCentsPerKwh,
  formatDollars,
  formatGramsPerKwh,
  formatKgCo2,
  formatKwh,
  formatRenewablePct,
} from "@/lib/provenance-format";
import { formatValue } from "@/lib/energy-formatting";
import type {
  SankeyMetric,
  SankeyMetricValue,
} from "@/components/EnergyFlowSankey";

/**
 * The reduced figures a panel is built from — the common shape of a flow reduction and a run row.
 *
 * 🛑 The RATES are inputs, not derived from the absolutes above them. They look derivable and are
 * not: `reduceLoadProvenance` divides by a FILTERED denominator — the energy of only those intervals
 * whose intensity was actually known — so on a window that straddles the moment provenance was
 * switched on, `avgCentsPerKwh` is deliberately not `costC / energyKwh`. Deriving it here would
 * quietly restate a partially-covered window's tariff as a much lower one. A run period has no such
 * split (a run's figures cover the whole run or are null), so its caller does the division itself
 * and passes the result.
 */
export interface ProvenancePanelInput {
  /**
   * kWh. **Null = unknown**, shown as "—" exactly like the three figures below it.
   *
   * 🛑 Energy was the one panel here that did not admit null, and it was wrong for the same reason
   * the others are right: a run detector with no energy point stores NULL, and the run-periods route
   * used to coalesce that to 0 — so a 6-hour EV charge that the chart legend showed as 6.8 kWh got a
   * band tooltip reading "0.0 kWh". A number nobody measured must not be printed as a measurement.
   */
  energyKwh: number | null;
  /** Cents, signed. Null = unknown, which shows "—" rather than $0.00. */
  costC: number | null;
  /** Grams CO₂. Null = unknown. */
  emissionsG: number | null;
  /** Renewable share, 0–100. Null = unknown. */
  pctRenewable: number | null;
  /** Cents per kWh over the caller's own honest denominator. Null = unknown. */
  avgCentsPerKwh: number | null;
  /** Grams CO₂ per kWh over the caller's own honest denominator. Null = unknown. */
  avgGramsPerKwh: number | null;
}

export interface ProvenancePanels {
  energy: SankeyMetric;
  emissions: SankeyMetric;
  cost: SankeyMetric;
  renewable: SankeyMetric;
}

/** An average-power secondary value, from watts. */
export function powerMetric(avgW: number): SankeyMetricValue {
  const { value, unit } = formatValue(avgW, "W");
  return { value, unit };
}

/** An average-power secondary value from energy over a span of hours. */
export function avgPowerMetric(
  energyKwh: number,
  hours: number,
): SankeyMetricValue {
  const avgW = hours > 0 ? (energyKwh * 1000) / hours : 0;
  return powerMetric(avgW);
}

/** Build the four panels. */
export function provenancePanels(
  input: ProvenancePanelInput,
  secondaryEnergy?: SankeyMetricValue,
): ProvenancePanels {
  const { energyKwh, costC, emissionsG, pctRenewable } = input;
  const kgCo2 = emissionsG == null ? null : emissionsG / 1000;
  return {
    energy: {
      primary: {
        value: energyKwh == null ? "—" : formatKwh(energyKwh),
        unit: "kWh",
      },
      ...(secondaryEnergy ? { secondary: secondaryEnergy } : {}),
    },
    emissions: {
      primary: { value: kgCo2 == null ? "—" : formatKgCo2(kgCo2), unit: "kg" },
      secondary: {
        value: formatGramsPerKwh(input.avgGramsPerKwh),
        unit: "g/kWh",
      },
    },
    cost: {
      // "$" is baked into the value — no unit beneath.
      primary: { value: costC == null ? "—" : formatDollars(costC) },
      secondary: {
        value: formatCentsPerKwh(input.avgCentsPerKwh),
        unit: "c/kWh",
      },
    },
    // "%" is baked into the value — no unit beneath.
    renewable: { primary: { value: formatRenewablePct(pctRenewable) } },
  };
}

/**
 * The panels for one persisted run period (an EV charge session, a generator run).
 *
 * Every figure comes straight off the row — `derived_intervals` accumulated them against the run's
 * own metered energy at recompute time, so nothing is re-integrated here. A run's provenance is
 * all-or-nothing (the intensity series either resolved for that run or it did not), which is why the
 * rates can be divided by the run's whole energy without the filtered-denominator caveat above.
 */
export function runProvenancePanels(
  run: {
    energyKwh: number | null;
    avgPowerW?: number | null;
    costC?: number | null;
    emissionsG?: number | null;
    renewableKwh?: number | null;
    durationSeconds?: number | null;
  },
  pctRenewable: number | null,
): ProvenancePanels {
  const costC = run.costC ?? null;
  const emissionsG = run.emissionsG ?? null;
  const per = (n: number | null) =>
    n == null || !run.energyKwh ? null : n / run.energyKwh;
  return provenancePanels(
    {
      energyKwh: run.energyKwh,
      costC,
      emissionsG,
      pctRenewable,
      avgCentsPerKwh: per(costC),
      avgGramsPerKwh: per(emissionsG),
    },
    // Average power over the run itself, not over the chart window — "how hard was it charging" is
    // a fact about the session. Taken from `avgPowerW` rather than re-derived from energy ÷ duration:
    // the server already picked the honest basis for it (metered energy where there is an energy
    // point, the mean of the power SIGNAL where there is not — `columns.avgPowerBasis`), so reading
    // it here is both simpler and the only version that survives a null energy. Deriving it locally
    // is what made the EV band tooltip say "0.0 kW" beside its "0.0 kWh".
    run.avgPowerW != null ? powerMetric(run.avgPowerW) : undefined,
  );
}
