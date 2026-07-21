/**
 * `data_quality` vocabulary helpers.
 *
 * The `point_readings*.data_quality` marker is NOT uniform across vendors:
 *   - Most vendors write the literal `"good"` (see `point-manager` default).
 *   - OpenElectricity bulk history writes `"actual"` (live writes `"good"`).
 *   - Amber abbreviates its quality to a single char via `abbreviateQuality`
 *     (`lib/vendors/amber/amber-readings-batch.ts`): `b`=billable, `a`=actual,
 *     `f`=forecast, `e`=estimated, `.`=unknown. It NEVER writes `"good"`.
 *
 * A reading is "settled" (final/known, not a guess) when it is good / actual / billable.
 * Forecast / estimated / unknown are provisional. Downstream confidence accounting (the
 * "% estimated" chip) must treat a settled Amber billable interval (`b`) as NOT estimated —
 * comparing against the literal `"good"` alone wrongly flags every Amber-priced interval
 * estimated forever (Amber never stores `"good"`).
 */

const SETTLED_QUALITIES: ReadonlySet<string> = new Set([
  "good", // most vendors, OE live
  "actual", // OE bulk history / Amber long form
  "billable", // Amber long form
  "a", // Amber abbreviated actual
  "b", // Amber abbreviated billable
]);

/**
 * True when a `data_quality` marker denotes a final/known value (not a provisional guess).
 * Unknown/forecast/estimated markers (`f`, `e`, `.`, `"forecast"`, `"estimated"`, …) return false.
 */
export function isSettledQuality(dataQuality: string): boolean {
  return SETTLED_QUALITIES.has(dataQuality);
}
