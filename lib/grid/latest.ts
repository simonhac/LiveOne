/**
 * Derive the Local Grid (NEM) card's live values from a `dashboardDataQuery` payload.
 *
 * The card reads the SAME generic `/api/data?systemId=` `latest` map every other live card on the
 * dashboard reads — just for the public OpenElectricity region device (resolved via gridContext).
 * No bespoke endpoint: this is a pure selector over that payload.
 *
 * The four OE grid-signal logical-path keys (logicalPathStem + "/" + metricType):
 *   - bidi.grid.spot/rate                    ($/MWh)
 *   - bidi.grid.emissionsIntensity/intensity (tCO2e/MWh)
 *   - bidi.grid.renewables/proportion        (%)
 *   - grid.demand/power                      (MW)
 * Display-unit conversion happens in the card.
 *
 * ⚠️ The first three are the SAME serving keys Amber publishes (`bidi.grid.spot/rate`,
 * `bidi.grid.renewables/proportion`) — deliberately, so a wire can carry either source into the same
 * port. They do not collide here because this selector reads one device's `latest` map at a time,
 * and that device is the public OpenElectricity region device.
 */

const GRID_LATEST_PATHS = {
  price: "bidi.grid.spot/rate",
  emissionsIntensity: "bidi.grid.emissionsIntensity/intensity",
  renewables: "bidi.grid.renewables/proportion",
  demand: "grid.demand/power",
} as const;

interface GridMetric {
  value: number;
  /** ISO-8601 measurement time (interval end). */
  measurementTime: string;
}

export interface GridLiveValues {
  price: GridMetric | null;
  emissionsIntensity: GridMetric | null;
  renewables: GridMetric | null;
  demand: GridMetric | null;
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
  const demand = pick(latest, GRID_LATEST_PATHS.demand);
  if (!price && !emissionsIntensity && !renewables && !demand) return null;

  return { price, emissionsIntensity, renewables, demand };
}
