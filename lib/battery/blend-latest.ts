/**
 * Derive the Battery Blend card's live values from a `dashboardDataQuery` payload.
 *
 * The three derived blend points live on the Area's HELPER device but are bound INTO the Area
 * (`role='battery'`, see lib/battery-provenance/register.ts), so they surface in the SAME generic
 * `/api/data?systemId=<areaHandle>` `latest` map every other live card reads. No bespoke endpoint —
 * this is a pure selector over that payload (mirrors lib/grid/latest.ts).
 *
 * The three blend logical-path keys (logicalPathStem + "/" + metricType):
 *   - bidi.battery/carbon-intensity   (gCO2/kWh)
 *   - bidi.battery/renewable-fraction (%)
 *   - bidi.battery/price              (c/kWh)
 * They describe "the energy currently sitting in the battery" — what it would vend if discharged now.
 */

export const BLEND_LATEST_PATHS = {
  carbonIntensity: "bidi.battery/carbon-intensity",
  renewableFraction: "bidi.battery/renewable-fraction",
  price: "bidi.battery/price",
} as const;

export interface BlendMetric {
  value: number;
  /** ISO-8601 measurement time (interval end). */
  measurementTime: string;
}

export interface BatteryBlendValues {
  carbonIntensity: BlendMetric | null;
  renewableFraction: BlendMetric | null;
  price: BlendMetric | null;
}

/** A latest-values map entry — value plus a timestamp (ISO string, or a revived Date). */
interface LatestEntry {
  value?: number | string | boolean | null;
  measurementTime?: string | Date | null;
}

function pick(
  latest: Record<string, LatestEntry | null>,
  path: string,
): BlendMetric | null {
  const p = latest[path];
  if (!p || typeof p.value !== "number") return null;
  const mt = p.measurementTime;
  const iso =
    mt instanceof Date ? mt.toISOString() : typeof mt === "string" ? mt : null;
  if (!iso) return null;
  return { value: p.value, measurementTime: iso };
}

/**
 * Extract the three blend signals from a `dashboardDataQuery` result (its `latest` map). Returns null
 * when the payload is absent or none of the three signals are present (e.g. no helper device / warm-up).
 */
export function batteryBlendFromData(data: unknown): BatteryBlendValues | null {
  const latest = (
    data as { latest?: Record<string, LatestEntry | null> } | null | undefined
  )?.latest;
  if (!latest || typeof latest !== "object") return null;

  const carbonIntensity = pick(latest, BLEND_LATEST_PATHS.carbonIntensity);
  const renewableFraction = pick(latest, BLEND_LATEST_PATHS.renewableFraction);
  const price = pick(latest, BLEND_LATEST_PATHS.price);
  if (!carbonIntensity && !renewableFraction && !price) return null;

  return { carbonIntensity, renewableFraction, price };
}
