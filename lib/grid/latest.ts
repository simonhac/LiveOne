/**
 * Derive the Local Grid (NEM) card's live values from a `dashboardDataQuery` payload.
 *
 * The card reads the SAME generic `/api/data?systemId=` `latest` map every other live card on the
 * dashboard reads — just for the public OpenElectricity region system (resolved via gridContext).
 * No bespoke endpoint: this is a pure selector over that payload.
 *
 * The three OE grid-signal logical-path keys (logicalPathStem + "/" + metricType):
 *   - grid.price/rate                   ($/MWh)
 *   - grid.emissionsIntensity/intensity (tCO2e/MWh)
 *   - grid.renewables/proportion        (%)
 * Display-unit conversion happens in the card.
 */

export const GRID_LATEST_PATHS = {
  price: "grid.price/rate",
  emissionsIntensity: "grid.emissionsIntensity/intensity",
  renewables: "grid.renewables/proportion",
} as const;

export interface GridMetric {
  value: number;
  /** ISO-8601 measurement time (interval end). */
  measurementTime: string;
}

export interface GridLiveValues {
  price: GridMetric | null;
  emissionsIntensity: GridMetric | null;
  renewables: GridMetric | null;
}

/** A latest-values map entry — value plus a timestamp (ISO string, or a revived Date). */
interface LatestEntry {
  value?: number | string | boolean | null;
  measurementTime?: string | Date | null;
}

function pick(
  latest: Record<string, LatestEntry | null>,
  path: string,
): GridMetric | null {
  const p = latest[path];
  if (!p || typeof p.value !== "number") return null;
  const mt = p.measurementTime;
  const iso =
    mt instanceof Date ? mt.toISOString() : typeof mt === "string" ? mt : null;
  if (!iso) return null;
  return { value: p.value, measurementTime: iso };
}

/**
 * Extract the three grid signals from a `dashboardDataQuery` result (its `latest` map). Returns
 * null when the payload is absent or none of the three signals are present.
 */
export function gridLatestFromData(data: unknown): GridLiveValues | null {
  const latest = (
    data as { latest?: Record<string, LatestEntry | null> } | null | undefined
  )?.latest;
  if (!latest || typeof latest !== "object") return null;

  const price = pick(latest, GRID_LATEST_PATHS.price);
  const emissionsIntensity = pick(latest, GRID_LATEST_PATHS.emissionsIntensity);
  const renewables = pick(latest, GRID_LATEST_PATHS.renewables);
  if (!price && !emissionsIntensity && !renewables) return null;

  return { price, emissionsIntensity, renewables };
}
