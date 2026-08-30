import { formatFlowMagnitude } from "@/lib/energy-formatting";

/**
 * Shared spellings for provenance metrics (dollars/cents/grams/percent/kWh) — extracted byte-identical
 * from the inline formatting that used to live in `LoadProvenanceCard.tsx` so the Sankey node tooltip
 * (`NodeTooltip.tsx` via `SiteChartsCard.tsx`'s `buildNodeTooltip`) and the card render the SAME numbers
 * the SAME way. Every formatter returns the BARE value (no unit suffix) to match the card's existing
 * `<Stat value=… caption=…>` split (the caption carries the unit); callers that need the unit inline
 * (the tooltip's combined "x kg / y g/kWh" line) append it themselves.
 */

/** "$X.YZ", with a leading "−" (not a hyphen) for negative cents — mirrors LoadProvenanceCard's dollar
 *  spelling (`costC` is signed cents; divide by 100 first). */
export function formatDollars(costC: number): string {
  const dollars = costC / 100;
  return `${dollars < 0 ? "−" : ""}$${Math.abs(dollars).toFixed(2)}`;
}

/** "X.Y" (1dp, cents/kWh) or "—" when unknown. Negatives take a real minus (U+2212), like
 *  `formatDollars` and BatteryContentsCard's own cents spelling — never a hyphen. */
export function formatCentsPerKwh(c: number | null): string {
  if (c == null) return "—";
  return `${c < 0 ? "−" : ""}${Math.abs(c).toFixed(1)}`;
}

/** Rounded whole grams/kWh, or "—" when unknown. */
export function formatGramsPerKwh(g: number | null): string {
  return g != null ? `${Math.round(g)}` : "—";
}

/** Rounded whole percent (0-100), or "—" when unknown. Includes the "%" — for inline/tooltip text
 *  only. Hero values should use `formatRenewablePctBare` + `<Value unit="%">` so the "%" is sized
 *  and bound per docs/architecture/number-typography.md. */
export function formatRenewablePct(p: number | null): string {
  return p != null ? `${Math.round(p)}%` : "—";
}

/** Rounded whole percent with NO "%", to pair with `<Value unit="%">`. */
export function formatRenewablePctBare(p: number | null): string {
  return p != null ? `${Math.round(p)}` : "—";
}

/** The sign-carrying "$" prefix for `formatDollarsBare` — "$" or "−$" (a real minus, not a hyphen). */
export function dollarPrefix(costC: number): string {
  return costC / 100 < 0 ? "−$" : "$";
}

/** Absolute dollar magnitude with NO "$", to pair with `<Value prefix={dollarPrefix(c)}>`. */
export function formatDollarsBare(costC: number): string {
  return Math.abs(costC / 100).toFixed(2);
}

/** "X.Y" (1dp kWh), dropping the decimal once the value reaches 100 (see formatFlowMagnitude). */
export function formatKwh(k: number): string {
  return formatFlowMagnitude(k);
}

/** "X.Y" (1dp kg CO2 — `kgCo2` is already grams/1000, e.g. `LoadProvenanceSummary.kgCo2`). */
export function formatKgCo2(kg: number): string {
  return kg.toFixed(1);
}

/** An absolute carbon total WITH its unit, switching g → kg at 1 kg: "497 g" / "7.2 kg". Unlike the
 *  bare formatters above this one carries the unit, because the unit is what changes. */
export function formatCarbonTotal(grams: number): string {
  return grams >= 1000
    ? `${(grams / 1000).toFixed(1)} kg`
    : `${Math.round(grams)} g`;
}

/**
 * A money total is shown ONLY when essentially all of the period's energy carried a known price.
 * Below that, callers must render "—" rather than a total.
 *
 * 🛑 THIS IS A CORRECTNESS RULE, NOT A STYLE ONE, and it is shared so two tiles cannot drift on it.
 * The provenance reducers and the run-periods endpoint both sum whatever is priced and report the
 * covered kWh alongside, so a partially-priced period otherwise renders a confident-looking total
 * that is silently too low — exactly what a half-finished `flow_attr_1d` backfill produces (a
 * 30-day window with one day of `revenue_c` read "$0.08" for 54.8 kWh exported).
 *
 * `cents` is nullable because "nothing was priced" and "genuinely cost $0" are different facts and
 * the sums cannot tell them apart: pass null when `knownKwh` is 0.
 */
export const PRICE_COVERAGE_MIN = 0.995;

export function pricedTotal(
  cents: number | null,
  knownKwh: number,
  energyKwh: number,
): number | null {
  if (cents == null) return null;
  return knownKwh >= energyKwh * PRICE_COVERAGE_MIN ? cents : null;
}
