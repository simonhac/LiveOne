/**
 * Presentation rules for run periods — pure, so both the API route and the two client tables can
 * share one definition (and so it can be tested; the components can't be).
 *
 * THE PROBLEM THIS SOLVES. `derived_intervals.{min,max,avg}_power_w` are misnamed: they hold
 * statistics of the RAW SIGNAL the detector follows, in that signal's own unit (see
 * `lib/db/planetscale/derived-intervals-pg.ts` — they come straight from `detectRunPeriods` over the
 * signal series). While Daylesford's detector watched Selectronic grid power they were Watts; since
 * the 2026-07-27 re-point to DSE Engine Speed they are rpm. Rendering them as kW (÷1000 + " kW")
 * therefore showed engine rpm as power — ~1.5 kW against a true 2–3.3 kW.
 *
 * So: show the signal as ITSELF (its own unit and label), and derive true average power separately
 * from energy ÷ duration, which is correct for any signal kind because the energy comes from a
 * dedicated energy point rather than the signal.
 */

/**
 * How to present the signal a run detector follows. Resolved server-side (the display registry
 * needs the system's `vendorType`) and carried to the client, which just applies `format`.
 */
export interface RunSignalMeta {
  /** `point_info.display_name`, e.g. "Engine Speed" — the column-label stem ("Avg Engine Speed"). */
  label: string;
  /** `point_info.metric_type`, e.g. "speed" | "power" — drives the column rule below. */
  metricType: string;
  /** `point_info.metric_unit`, e.g. "rpm" — the RAW unit the stored statistic is in. */
  metricUnit: string;
  /** Display unit for the raw value; belongs in the column HEADER, not each cell. */
  unit: string;
  /** Excel-style number format for the raw value, e.g. "0" (see lib/point/display/excel-format). */
  format: string;
}

/** Which run-period columns to render. The server owns the rule; the clients carry no logic. */
export interface RunPeriodColumns {
  /** Show the raw-signal average in its own unit. */
  signal: boolean;
  /** Show an average-power column. */
  avgPower: boolean;
  /** Show the accumulated cost column ($). */
  cost: boolean;
  /** Show the accumulated emissions column (kg CO₂). */
  emissions: boolean;
  /** Show the renewable-share column (%). */
  renewable: boolean;
  /**
   * Where the avg-power figure comes from. "energy" = energy ÷ duration (a true time-weighted
   * average, preferred). "signal" = the signal IS power and no energy point is bound, so the
   * signal mean is the only power figure available — the pre-existing behaviour, now correctly
   * gated so it can only apply when the signal really is power.
   */
  avgPowerBasis: "energy" | "signal";
}

/**
 * Signal units whose mean is meaningless (a mean of 0/1 flags, of text, of timestamps). Fenced out
 * of the signal column rather than rendered as a number.
 */
const NON_NUMERIC_SIGNAL_UNITS = new Set([
  "boolean",
  "text",
  "json",
  "epochMs",
]);

/**
 * Decide which columns a run-periods table should show.
 *
 * The invariant: never present two columns of the same quantity, and never advertise a column that
 * would be entirely empty. When the signal IS power, the derived avg-power column supersedes the
 * signal statistic (energy ÷ duration is time-weighted and metered, whereas the signal statistic is
 * an unweighted mean of on-samples), so the signal column collapses away — a power-signal site sees
 * exactly one "Avg Power" column, as it always has.
 */
export function planRunPeriodColumns(input: {
  /** `point_info.metric_type` of the signal point; null when the point has no `point_info` row. */
  signalMetricType: string | null;
  /** `point_info.metric_unit` of the signal point; null when unknown. */
  signalMetricUnit: string | null;
  /** Whether the detector binds a dedicated energy point (`source_points.energy`). */
  hasEnergyPoint: boolean;
  /**
   * Whether the rows being returned actually CARRY each provenance figure. Deliberately derived
   * from the data, not from the site's intensity config — provenance is accumulated at recompute
   * time, so config describes what future runs will be priced at, while only the rows say what was
   * stored. See the note on `resolveShape` in the run-periods route.
   */
  provenance?: { cost: boolean; emissions: boolean; renewable: boolean };
}): RunPeriodColumns {
  const numeric =
    input.signalMetricType != null &&
    input.signalMetricUnit != null &&
    !NON_NUMERIC_SIGNAL_UNITS.has(input.signalMetricUnit);
  const isPower = input.signalMetricType === "power";

  const avgPowerBasis = input.hasEnergyPoint ? "energy" : "signal";
  // Without an energy point the only possible power figure is the signal itself — so an avg-power
  // column is honest only when the signal genuinely is power.
  const avgPower = input.hasEnergyPoint || (isPower && numeric);
  // A power signal is already represented by the avg-power column; showing it twice would be noise.
  const signal = numeric && !(isPower && avgPower);

  // Each provenance factor is gated INDEPENDENTLY: the config gates price separately from
  // emissions, so a site with emissions but no configured price shows CO₂ and omits cost rather
  // than printing "$0.00". A column appears only when some row can fill it.
  const cost = input.provenance?.cost ?? false;
  const emissions = input.provenance?.emissions ?? false;
  const renewable = input.provenance?.renewable ?? false;

  return { signal, avgPower, avgPowerBasis, cost, emissions, renewable };
}

/** An en dash with no surrounding spaces reads as a range; a hyphen reads as a subtraction. */
const RANGE_DASH = "–";

/**
 * One human-readable "when" for a run — the merged replacement for the old Date / Start / End
 * columns. Operates on the strings the server already formatted in the system's display timezone
 * (`formatInTimezone`), so no timezone logic leaks to the client.
 *
 * `endDate` is set by the server ONLY when the run ends on a different local day than it started;
 * printing it then is the point of this function. Without it a midnight-crossing run reads
 * "Mon 27 Jul, 23:40–01:15", which quietly implies both times are on the Monday.
 */
export function formatRunWhen(e: {
  /** Start date, "EEE d MMM". */
  date: string;
  /** Start time, "HH:mm". */
  startTime: string;
  /** End date, "EEE d MMM" — only when it differs from `date`; else null/undefined. */
  endDate?: string | null;
  /** End time, "HH:mm"; null for an open run. */
  endTime: string | null;
  /** True while the run is still going. */
  running?: boolean;
}): string {
  if (e.running) return `${e.date}, ${e.startTime}${RANGE_DASH}now`;
  // A run with no end, or one whose end rounds to the same minute, is a point in time not a range.
  if (e.endTime == null || (e.endTime === e.startTime && !e.endDate)) {
    return `${e.date}, ${e.startTime}`;
  }
  if (e.endDate) {
    return `${e.date}, ${e.startTime} ${RANGE_DASH} ${e.endDate}, ${e.endTime}`;
  }
  return `${e.date}, ${e.startTime}${RANGE_DASH}${e.endTime}`;
}

/**
 * True average electrical power over a run, in Watts, from energy ÷ duration.
 *
 * Correct for ANY signal kind: the energy comes from a dedicated energy point, not the signal. Null
 * for an open (still running) period, an unmetered run, or a non-positive duration — so a caller
 * renders "—" rather than a bogus number or Infinity.
 */
export function avgPowerWFromEnergy(
  energyKwh: number | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  if (energyKwh == null || durationSeconds == null || durationSeconds <= 0) {
    return null;
  }
  return (energyKwh * 3_600_000) / durationSeconds;
}
