/**
 * `data_quality` vocabulary helpers.
 *
 * The `point_readings*.data_quality` marker is NOT uniform across vendors:
 *   - Most vendors write the literal `"good"` (see `point-manager` default).
 *   - OpenElectricity bulk history writes `"actual"` (live writes `"good"`).
 *   - Amber abbreviates its quality to a single char via `abbreviateQuality`
 *     (`lib/vendors/amber/amber-readings-batch.ts`): `b`=billable, `a`=actual,
 *     `f`=forecast, `e`=estimated, `.`=unknown. It NEVER writes `"good"`.
 *   - Derived writers that SOLELY own a point write `"estimated"` (the battery-provenance
 *     blend, the HWS model) — see `writeDataQuality` in `lib/readings/dao.ts`.
 *   - Gap RECOVERY writes `"calculated"` / `"interpolated"` — see below.
 *
 * A reading is "settled" (final/known, not a guess) when it is good / actual / billable.
 * Forecast / estimated / unknown are provisional. Downstream confidence accounting (the
 * "% estimated" chip) must treat a settled Amber billable interval (`b`) as NOT estimated —
 * comparing against the literal `"good"` alone wrongly flags every Amber-priced interval
 * estimated forever (Amber never stores `"good"`).
 *
 * ## Recovered intervals: `calculated` and `interpolated`
 *
 * Some vendors expose history for one metric but not another, so a missed live poll leaves a
 * permanent hole in the un-refetchable series. Sigenergy is the case in point: its statistics
 * endpoint serves 5-minute interval ENERGY but the only source of POWER and SoC is the live
 * instantaneous snapshot, one sample per 5-minute bucket with no redundancy. Those holes are
 * reconstructed rather than re-fetched (`lib/vendors/sigenergy/derive-power.ts`):
 *
 *   - `"calculated"`   — derived exactly, by identity, from another measured series in the same
 *                        interval (power = interval energy x 12). Not measured, but not a guess.
 *   - `"interpolated"` — inferred between bracketing measured samples, bounded to small holes.
 *                        A genuine estimate.
 *
 * Long form, deliberately, even though Amber's markers are single chars. Amber's abbreviation is
 * a display concern that leaked into storage — `abbreviateQuality` is a generic `charAt(0)` that
 * exists to build a debug overview grid and is applied on entry — not a storage decision. The
 * closest analogue to these two is `"estimated"`, which is long form; the marker surfaces in the
 * per-point `.quality` CSV column where it is read by humans; and `charAt(0)` would make `c`/`i`
 * collide
 * with any future marker sharing an initial. The size difference is ~9 bytes on a few thousand
 * rows a year, against a multi-GB table — not a consideration.
 *
 * Neither is settled, and neither needs to be listed for that to hold: `isSettledQuality` is an
 * allow-list, so any unrecognised marker is provisional by default. That is deliberate — a new
 * marker can never silently be counted as measured.
 */

const SETTLED_QUALITIES: ReadonlySet<string> = new Set([
  "good", // most vendors, OE live
  "actual", // OE bulk history / Amber long form
  "billable", // Amber long form
  "a", // Amber abbreviated actual
  "b", // Amber abbreviated billable
]);

/**
 * Markers written by a LiveOne derivation rather than read from a vendor.
 *
 * Disjoint from `SETTLED_QUALITIES`, so every one of these is also provisional. The distinction
 * this set adds is *why*: `isSettledQuality` alone conflates "we computed this" with "the vendor
 * says this is a forecast", which is the wrong thing to tell a reader of a chart or an export.
 */
const DERIVED_QUALITIES: ReadonlySet<string> = new Set([
  "calculated", // exact, by identity, from another measured series
  "interpolated", // inferred between bracketing measured samples
  "estimated", // model/blend output (battery-provenance, HWS)
]);

/**
 * True when a `data_quality` marker denotes a final/known value (not a provisional guess).
 * Unknown/forecast/estimated markers (`f`, `e`, `.`, `"forecast"`, `"estimated"`, …) return false.
 */
export function isSettledQuality(dataQuality: string): boolean {
  return SETTLED_QUALITIES.has(dataQuality);
}

/**
 * True when a `data_quality` marker denotes a value LiveOne derived rather than measured.
 *
 * Always implies `!isSettledQuality`. Use this (not the negation of `isSettledQuality`) when the
 * question is "did we make this number up", e.g. labelling a recovered interval in the UI — a
 * vendor forecast is also un-settled but is not ours.
 */
export function isDerivedQuality(dataQuality: string): boolean {
  return DERIVED_QUALITIES.has(dataQuality);
}
