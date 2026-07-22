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

/** "X.Y" (1dp, cents/kWh) or "—" when unknown. */
export function formatCentsPerKwh(c: number | null): string {
  return c != null ? c.toFixed(1) : "—";
}

/** Rounded whole grams/kWh, or "—" when unknown. */
export function formatGramsPerKwh(g: number | null): string {
  return g != null ? `${Math.round(g)}` : "—";
}

/** Rounded whole percent (0-100), or "—" when unknown. */
export function formatRenewablePct(p: number | null): string {
  return p != null ? `${Math.round(p)}%` : "—";
}

/** "X.Y" (1dp kWh), dropping the decimal once the value reaches 100 (see formatFlowMagnitude). */
export function formatKwh(k: number): string {
  return formatFlowMagnitude(k);
}

/** "X.Y" (1dp kg CO2 — `kgCo2` is already grams/1000, e.g. `LoadProvenanceSummary.kgCo2`). */
export function formatKgCo2(kg: number): string {
  return kg.toFixed(1);
}
