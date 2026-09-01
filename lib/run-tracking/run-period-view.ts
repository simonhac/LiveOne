/**
 * Presentation rules for run periods — pure, so both the API route and the two client tables can
 * share one definition (and so it can be tested; the components can't be).
 *
 * THE PROBLEM THIS SOLVES. `derived_intervals.{min,max,avg}_power_w` were misnamed: they hold
 * statistics of the RAW SIGNAL the detector follows, in that signal's own unit (see
 * `lib/db/planetscale/derived-intervals-pg.ts` — they come straight from `detectRunPeriods` over the
 * signal series). While Daylesford's detector watched Selectronic grid power they were Watts; since
 * the 2026-07-27 re-point to DSE Engine Speed they are rpm. Rendering them as kW (÷1000 + " kW")
 * therefore showed engine rpm as power — ~1.5 kW against a true 2–3.3 kW.
 *
 * So: show the signal as ITSELF (its own unit and label), and derive true average power separately
 * from energy ÷ duration, which is correct for any signal kind because the energy comes from a
 * dedicated energy point rather than the signal.
 *
 * WHAT MIGRATION 0055 CHANGED, AND WHY THIS FILE GREW A CASE. The columns are now
 * `max/min/avg_signal` + a per-row `signal_unit`, so the unit is a fact about each row rather than
 * an inference from the detector's current config. That retired the reader's `detector_version`
 * equality gate, which used to SUPPRESS the statistic on any row an older detector wrote.
 *
 * But it does not make a single column header correct, and that is the trap this file now has to
 * handle explicitly: **prod's history is mixed-unit and permanently so.** 74 of Daylesford's 77 runs
 * are Watts and 3 are rpm, and a header that simply read the CURRENT signal point — "Avg Engine
 * Speed (rpm)" — would print every pre-re-point Watt value as rpm. That is a WORSE failure than the
 * old suppression, because it is confidently wrong instead of blank. Hence {@link RunPeriodColumns}
 * `signalUnitPerRow`: when the rows do not all share the current signal's unit, the header drops the
 * point's name entirely and each CELL carries its own unit.
 */

/**
 * How to present the signal a run detector follows. Resolved server-side (the display registry
 * needs the device's `vendorType`) and carried to the client, which just applies `format`.
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
  /**
   * Show the accumulated energy column (kWh).
   *
   * 🛑 Gated for the same reason `cost`/`emissions` are, and it was missed: a detector with no
   * energy point has NULL energy on every row, the wire coalesces that to 0 (`?? 0` in the
   * run-periods route, load-bearing for the sums where energy IS known), and an ungated column
   * therefore printed "0.0" against every session — a confident claim that the EV drew nothing,
   * on the card whose whole job is to say how much it drew. NULL means UNKNOWN here, exactly as
   * `derived_intervals.energy_kwh` documents; an unknown quantity gets no column.
   */
  energy: boolean;
  /** Show the raw-signal average in its own unit. */
  signal: boolean;
  /**
   * True when the returned rows do NOT all share the CURRENT signal point's unit — i.e. the window
   * straddles a detector re-point, or is entirely in a superseded unit.
   *
   * The client then renders each cell with its OWN unit and gives the column a neutral header,
   * because there is no single label that is true of every row. False (the ordinary case) means one
   * unit throughout, so the header carries it and the cells stay bare numbers.
   */
  signalUnitPerRow: boolean;
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
  /**
   * The RAW `signal_unit` of every row being returned (nulls included, duplicates fine) — NOT the
   * detector's config. Rows are the only thing that can say what units a window actually contains,
   * which is the whole lesson of the mixed-unit history: config describes what the NEXT run will be
   * measured in, and says nothing about the 74 already stored in something else.
   */
  rowSignalUnits?: (string | null)[];
  /** Whether the detector binds a dedicated energy point (`source_points.energy`). */
  hasEnergyPoint: boolean;
  /**
   * Whether the returned rows actually CARRY energy. Same principle as `provenance` below — the
   * rows are the only thing that can say what a window contains, so a detector that gained an
   * energy point mid-history still shows the column for the rows that have one.
   */
  rowsCarryEnergy?: boolean;
  /**
   * Whether the rows being returned actually CARRY each provenance figure. Deliberately derived
   * from the data, not from the site's intensity config — provenance is accumulated at recompute
   * time, so config describes what future runs will be priced at, while only the rows say what was
   * stored. See the note on `resolveShape` in the run-periods route.
   */
  provenance?: { cost: boolean; emissions: boolean; renewable: boolean };
}): RunPeriodColumns {
  const currentNumeric =
    input.signalMetricType != null &&
    input.signalMetricUnit != null &&
    !NON_NUMERIC_SIGNAL_UNITS.has(input.signalMetricUnit);
  const isPower = input.signalMetricType === "power";

  // The distinct units actually present in the rows, minus the ones whose mean is meaningless.
  const rowUnits = new Set(
    (input.rowSignalUnits ?? []).filter(
      (u): u is string => u != null && !NON_NUMERIC_SIGNAL_UNITS.has(u),
    ),
  );
  // Homogeneous means "one unit, and it is the one the header would name". Zero units (an empty
  // window, or rows written before 0055 stamped one) is vacuously homogeneous: there is nothing to
  // contradict the header, and per-row units would print nothing useful.
  const homogeneous =
    rowUnits.size === 0 ||
    (rowUnits.size === 1 &&
      currentNumeric &&
      rowUnits.has(input.signalMetricUnit!));
  const signalUnitPerRow = !homogeneous;

  // Rows can carry a usable unit even when the CURRENT signal point can't be resolved (a deleted or
  // re-pointed binding), and a stored, labelled number is still worth showing — that is the point of
  // storing the unit. So the column is numeric if either end can name a unit.
  const numeric = currentNumeric || rowUnits.size > 0;

  const energy = input.hasEnergyPoint || (input.rowsCarryEnergy ?? false);

  const avgPowerBasis = input.hasEnergyPoint ? "energy" : "signal";
  // Without an energy point the only possible power figure is the signal itself — so an avg-power
  // column is honest only when the signal genuinely is power AND every row is in that same unit.
  // A mixed window has rows that are not power at all, so the fallback cannot cover the column.
  const avgPower =
    input.hasEnergyPoint || (isPower && currentNumeric && !signalUnitPerRow);
  // A power signal is already represented by the avg-power column; showing it twice would be noise.
  // Mixed units break that equivalence — the avg-power column can only speak for the rows that ARE
  // power — so the signal column stays and carries the rest.
  const signal = numeric && !(isPower && avgPower && !signalUnitPerRow);

  // Each provenance factor is gated INDEPENDENTLY: the config gates price separately from
  // emissions, so a site with emissions but no configured price shows CO₂ and omits cost rather
  // than printing "$0.00". A column appears only when some row can fill it.
  const cost = input.provenance?.cost ?? false;
  const emissions = input.provenance?.emissions ?? false;
  const renewable = input.provenance?.renewable ?? false;

  return {
    energy,
    signal,
    signalUnitPerRow,
    avgPower,
    avgPowerBasis,
    cost,
    emissions,
    renewable,
  };
}

/** Number format for a signal value the display registry doesn't cover (or can't be asked about). */
const FALLBACK_SIGNAL_FORMAT = "0.0";

/**
 * Render one signal statistic — the single place that decides whether a value prints its own unit.
 *
 * Pure and shared so the rule lives beside the plan that produced it rather than in a component:
 * a cell must carry its unit exactly when {@link RunPeriodColumns.signalUnitPerRow} says the column
 * header cannot. The registry `format` belongs to the CURRENT signal point, so it is only applied to
 * rows actually in that unit; a superseded unit gets a neutral one decimal place rather than, say,
 * an rpm-shaped "0" imposed on Watts.
 */
export function formatRunSignal(
  value: number | null | undefined,
  /** The ROW's own display unit (`RunPeriodEvent.signalUnit`). */
  rowUnit: string | null | undefined,
  /** The current signal's display meta, or null when it couldn't be resolved. */
  signal: Pick<RunSignalMeta, "unit" | "format"> | null,
  /** {@link RunPeriodColumns.signalUnitPerRow}. */
  signalUnitPerRow: boolean,
  applyFormat: (v: number, format: string) => string,
): string {
  if (value == null) return "—";
  const inCurrentUnit =
    signal != null && (!signalUnitPerRow || rowUnit === signal.unit);
  const text = applyFormat(
    value,
    inCurrentUnit ? signal.format : FALLBACK_SIGNAL_FORMAT,
  );
  return signalUnitPerRow && rowUnit ? `${text} ${rowUnit}` : text;
}

/** An en dash with no surrounding spaces reads as a range; a hyphen reads as a subtraction. */
const RANGE_DASH = "–";

/** The fields a run's "when" is spelled from — see {@link formatRunWhen}. */
interface RunWhen {
  /** Start date, "EEE d MMM". */
  date: string;
  /** Start time, "h:mma" (e.g. "4:16pm"). */
  startTime: string;
  /** End date, "EEE d MMM" — only when it differs from `date`; else null/undefined. */
  endDate?: string | null;
  /** End time, "h:mma"; null for an open run. */
  endTime: string | null;
  /** True while the run is still going. */
  running?: boolean;
}

/**
 * A run's "when", split at the point a narrow panel should break it.
 *
 * A run inside ONE day is two separate facts — which day, and which part of it — so it returns them
 * as two lines: `["Sat 1 Aug", "8:55pm–9:39pm"]`. Left as a single string, a 140px tooltip breaks it
 * wherever the text happens to run out ("…, 8:55pm–" / "9:39pm"), which reads as a severed value
 * rather than a wrapped one. A MIDNIGHT-CROSSING run has no such split — each side of the dash
 * carries its own date, and separating them would strand a date from its time — so it stays one line
 * and wraps as it always did.
 *
 * `formatRunWhen` is this joined back up, for the callers (the run tables) with a whole row to play
 * with. One source of truth for the wording; the caller picks the shape.
 */
export function formatRunWhenLines(e: RunWhen): string[] {
  if (e.running) return [e.date, `${e.startTime}${RANGE_DASH}now`];
  // A run with no end, or one whose end rounds to the same minute, is a point in time not a range.
  if (e.endTime == null || (e.endTime === e.startTime && !e.endDate)) {
    return [e.date, e.startTime];
  }
  if (e.endDate) {
    return [
      `${e.date}, ${e.startTime} ${RANGE_DASH} ${e.endDate}, ${e.endTime}`,
    ];
  }
  return [e.date, `${e.startTime}${RANGE_DASH}${e.endTime}`];
}

/**
 * One human-readable "when" for a run — the merged replacement for the old Date / Start / End
 * columns. Operates on the strings the server already formatted in the device's display timezone
 * (`formatInTimezone`), so no timezone logic leaks to the client.
 *
 * `endDate` is set by the server ONLY when the run ends on a different local day than it started;
 * printing it then is the point of this function. Without it a midnight-crossing run reads
 * "Mon 27 Jul, 11:40pm–1:15am", which quietly implies both times are on the Monday.
 */
export function formatRunWhen(e: RunWhen): string {
  return formatRunWhenLines(e).join(", ");
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
