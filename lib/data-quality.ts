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

/**
 * Precedence for `data_quality`, used to pick a winner when the SAME (point, interval) is written
 * twice and only one row can survive. Higher wins; unknown markers rank 0 (never beat a known one).
 *
 * 🛑 This exists because two markers for one interval is NOT a corruption — it is the normal shape
 * of a settling series. Amber reports an interval as `f`orecast, then `e`stimated, then `a`ctual,
 * then `b`illable, and a backfill that spans a settlement boundary legitimately sees two of those
 * for the same half-hour. The rank is what turns "two rows" into "the later word on the same
 * reading" instead of a collision.
 *
 * The tiers, most-final first:
 *   5  billable  — Amber's final, invoiced number
 *   4  measured  — good / actual: a vendor's settled reading
 *   3  calculated — derived exactly, by identity, from another MEASURED series
 *   2  interpolated / estimated — a genuine guess, ours
 *   1  forecast  — a vendor's guess
 *   0  unknown   — `.`, or any marker not listed
 *
 * `good` and `actual` deliberately SHARE a tier: they are the same claim in two vendors' words, and
 * ordering them against each other would be inventing a distinction no vendor makes. Ties are
 * broken by arrival order (last wins), which matches what consecutive statements would have done.
 */
const QUALITY_PRECEDENCE: ReadonlyMap<string, number> = new Map([
  ["billable", 5],
  ["b", 5],
  ["good", 4],
  ["actual", 4],
  ["a", 4],
  ["calculated", 3],
  ["interpolated", 2],
  ["estimated", 2],
  ["e", 2], // Amber abbreviated estimated
  ["forecast", 1],
  ["f", 1],
  ["unknown", 0],
  [".", 0],
]);

/**
 * Rank a `data_quality` marker for last-writer-wins arbitration. See `QUALITY_PRECEDENCE`.
 *
 * Null/undefined/unrecognised all rank 0 — an unknown marker must never displace a known one, for
 * the same reason `isSettledQuality` is an allow-list.
 */
export function qualityRank(dataQuality: string | null | undefined): number {
  if (dataQuality == null) return 0;
  return QUALITY_PRECEDENCE.get(dataQuality) ?? 0;
}

/**
 * Every `data_quality` marker this codebase recognises, as an ALLOW-LIST.
 *
 * Derived from `QUALITY_PRECEDENCE`, which is the one place the vocabulary is defined — a second
 * hand-maintained list would drift, and the drift would be silent (an unrecognised marker is not an
 * error anywhere; it just ranks 0 and loses every arbitration it enters).
 *
 * This is the RECOGNITION set — "would a reader of this column know what this means". It is NOT the
 * set a human may choose from; for that see `IMPORTABLE_QUALITIES`.
 */
export const KNOWN_QUALITIES: readonly string[] = Object.freeze([
  ...QUALITY_PRECEDENCE.keys(),
]);

/**
 * The markers an OPERATOR may stamp on rows they supply — the allow-list `liveone import` offers.
 *
 * A deliberately narrower set than `KNOWN_QUALITIES`, because "every marker we can read" and "every
 * marker a person should be able to write" are different questions and `KNOWN_QUALITIES` answers
 * only the first. Three kinds of marker are recognised but must not be offered:
 *
 *   - `unknown` and `.` rank 0 and read as "provenance was never recorded". An import exists to
 *     RECORD provenance, so offering these as a choice hands the operator the exact outcome the
 *     verb was built to prevent — and unlike a typo it would pass validation.
 *   - `a` / `b` / `e` / `f` are Amber's storage abbreviations. `lib/data-quality.ts`'s own header
 *     calls that abbreviation "a display concern that leaked into storage"; stamping `b`
 *     (billable — Amber's final invoiced number) on a Sigenergy point is not a claim anyone can
 *     act on.
 *   - `forecast` and `billable` are vendor-lifecycle words. A vendor says them about its own
 *     settling series; an operator importing a reconstruction is not making that claim.
 *
 * What is left is the five an operator can mean, and `derive-power.ts` already uses four of them for
 * exactly this purpose: a measurement (`good` / `actual`), an identity (`calculated`), a bounded
 * inference (`interpolated`), or a model (`estimated`).
 */
export const IMPORTABLE_QUALITIES: readonly string[] = Object.freeze([
  "good",
  "actual",
  "calculated",
  "interpolated",
  "estimated",
]);
