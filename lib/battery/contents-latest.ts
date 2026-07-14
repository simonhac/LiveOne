/**
 * Derive the Battery Contents card's live values from a `dashboardDataQuery` payload — the INVENTORY
 * VALUATION of the energy currently sitting in the battery (what it holds and what that's worth).
 *
 * Five derived points live on the Area's HELPER device, bound INTO the Area (`role='battery'`, see
 * lib/battery-provenance/register.ts), so they surface in the SAME generic `/api/data?systemId=<areaHandle>`
 * `latest` map every other live card reads (no bespoke endpoint; a pure selector, mirrors lib/grid/latest.ts):
 *   - bidi.battery/stored-energy      (kWh)      usable energy E
 *   - bidi.battery/carbon-intensity   (gCO2/kWh)
 *   - bidi.battery/renewable-fraction (%)
 *   - bidi.battery/price              (c/kWh)    ACTUAL (out-of-pocket) cost basis
 *   - bidi.battery/price-opportunity  (c/kWh)    ADDITIONAL opportunity component (forgone feed-in, ≥ 0)
 * plus the grid feed-in rate, when an export tariff exists:
 *   - bidi.grid.export/rate           (c/kWh)
 *
 * The absolute totals are DERIVED here, not stored: each intensity is `total ÷ E`, so `intensity × E`
 * reconstructs the total EXACTLY. total carbon = carbonIntensity × E; actual cost = price × E; opportunity
 * component = price-opportunity × E; renewable kWh = renewable% × E; export value = feed-in × E.
 */

export const CONTENTS_LATEST_PATHS = {
  storedEnergy: "bidi.battery/stored-energy",
  carbonIntensity: "bidi.battery/carbon-intensity",
  renewableFraction: "bidi.battery/renewable-fraction",
  priceActual: "bidi.battery/price",
  priceOpportunity: "bidi.battery/price-opportunity",
  exportRate: "bidi.grid.export/rate",
} as const;

export interface BatteryContentsValues {
  // ── raw latest (natural units; null when the point is absent) ──
  /** Usable stored energy E (kWh). */
  storedEnergyKwh: number | null;
  /** Carbon intensity of the stored energy (gCO2/kWh). */
  carbonIntensity: number | null;
  /** Renewable proportion of the stored energy (%). */
  renewableFraction: number | null;
  /** Actual (out-of-pocket) cost basis of the stored energy (c/kWh). */
  priceActual: number | null;
  /** ADDITIONAL opportunity component (forgone feed-in on top of priceActual) (c/kWh); ≥ 0. */
  priceOpportunity: number | null;
  /** Current feed-in rate (c/kWh); null ⇒ no export tariff on this area. */
  exportRate: number | null;

  // ── derived totals (null unless storedEnergyKwh is present) ──
  /** Total carbon in the store (gCO2) = carbonIntensity × E. */
  totalCarbonG: number | null;
  /** Total ACTUAL (out-of-pocket) cost of the store (cents, signed) = priceActual × E. */
  totalCostActualC: number | null;
  /** OPPORTUNITY component (forgone export, cents ≥ 0) = priceOpportunity × E. */
  totalCostOpportunityC: number | null;
  /** Renewable energy content (kWh) = renewableFraction% × E. */
  renewableKwh: number | null;
  /** Value of the contents at the current feed-in rate (cents) = exportRate × E; null without a tariff. */
  exportValueC: number | null;

  /** Newest measurement time across the battery points (ISO-8601), for staleness. */
  measurementTime: string | null;
}

/** A latest-values map entry — value plus a timestamp (ISO string, or a revived Date). */
interface LatestEntry {
  value?: number | string | boolean | null;
  measurementTime?: string | Date | null;
}

interface PickedMetric {
  value: number;
  measurementTime: string | null;
}

function pick(
  latest: Record<string, LatestEntry | null>,
  path: string,
): PickedMetric | null {
  const p = latest[path];
  if (!p || typeof p.value !== "number") return null;
  const mt = p.measurementTime;
  const iso =
    mt instanceof Date ? mt.toISOString() : typeof mt === "string" ? mt : null;
  return { value: p.value, measurementTime: iso };
}

/**
 * Extract the battery-contents signals from a `dashboardDataQuery` result (its `latest` map) and compute
 * the derived totals. Returns null when the payload is absent or NO battery point is present (no helper
 * device / warm-up). When the intensities are present but `stored-energy` is not (engine not yet backfilled),
 * the raw intensities render and the absolute totals stay null — the card degrades to "—" for those.
 */
export function batteryContentsFromData(
  data: unknown,
): BatteryContentsValues | null {
  const latest = (
    data as { latest?: Record<string, LatestEntry | null> } | null | undefined
  )?.latest;
  if (!latest || typeof latest !== "object") return null;

  const stored = pick(latest, CONTENTS_LATEST_PATHS.storedEnergy);
  const carbon = pick(latest, CONTENTS_LATEST_PATHS.carbonIntensity);
  const renewable = pick(latest, CONTENTS_LATEST_PATHS.renewableFraction);
  const priceA = pick(latest, CONTENTS_LATEST_PATHS.priceActual);
  const priceO = pick(latest, CONTENTS_LATEST_PATHS.priceOpportunity);
  const exportR = pick(latest, CONTENTS_LATEST_PATHS.exportRate);

  // No battery signal at all (export rate alone doesn't make this a battery card) → nothing to show.
  if (!stored && !carbon && !renewable && !priceA && !priceO) return null;

  const E = stored?.value ?? null;
  const carbonIntensity = carbon?.value ?? null;
  const renewableFraction = renewable?.value ?? null;
  const priceActual = priceA?.value ?? null;
  const priceOpportunity = priceO?.value ?? null;
  const exportRate = exportR?.value ?? null;

  const scale = (per: number | null): number | null =>
    E != null && per != null ? per * E : null;

  const newestMs = [stored, carbon, renewable, priceA, priceO]
    .map((m) => (m?.measurementTime ? Date.parse(m.measurementTime) : NaN))
    .filter((n) => !Number.isNaN(n));

  return {
    storedEnergyKwh: E,
    carbonIntensity,
    renewableFraction,
    priceActual,
    priceOpportunity,
    exportRate,
    totalCarbonG: scale(carbonIntensity),
    totalCostActualC: scale(priceActual),
    totalCostOpportunityC: scale(priceOpportunity),
    renewableKwh:
      E != null && renewableFraction != null
        ? (renewableFraction / 100) * E
        : null,
    exportValueC: scale(exportRate),
    measurementTime: newestMs.length
      ? new Date(Math.max(...newestMs)).toISOString()
      : null,
  };
}
