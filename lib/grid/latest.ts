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
 * ⚠️ TWO of them — `bidi.grid.spot/rate` and `bidi.grid.renewables/proportion` — are serving keys
 * **Amber also publishes**, deliberately, so a wire can one day carry either source into the same
 * port. (`bidi.grid.emissionsIntensity` is OE's alone; Amber has no emissions point.) The units
 * differ where they overlap: OE's spot is `$/MWh`, Amber's is `cents_kWh`. Nothing converts between
 * them yet, which is why `oeGridSelection` below refuses a payload that is not an OE region
 * device.
 */

import {
  isNemRegion,
  type NemRegion,
} from "@/lib/vendors/openelectricity/types";

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
 * Extract the four grid signals from a `dashboardDataQuery` result (its `latest` map). Returns null
 * when the payload is absent or none of the signals are present.
 *
 * Module-local on purpose: the values alone are no longer sufficient evidence that this payload is
 * OpenElectricity's (see `oeGridSelection`), so every caller should go through the gate rather than
 * be able to reach round it.
 */
function gridLatestFromData(data: unknown): GridLiveValues | null {
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

/**
 * The `oe-grid` tile's source gate: the live values AND the NEM region they belong to, or null.
 *
 * 🛑 **The region is a REQUIREMENT here, not a label.** `gridLatestFromData` above used to be
 * sufficient evidence on its own: the keys it reads were OpenElectricity's alone, so "this payload
 * carries the values" and "this is an OE region device" were the same statement. Renaming those
 * points into `bidi.grid.*` (2026-09-14), so they match role `grid` by the ordinary anchor rule,
 * moved two of them onto keys **Amber already publishes** — `bidi.grid.spot/rate` in `cents_kWh` and
 * `bidi.grid.renewables/proportion`. The card renders price as `$N/MWh`, so without this check an
 * Amber device would display 10 c/kWh as "$10/MWh", and the card picker would offer the tile on
 * every Amber dashboard. Conversion at the sink is planned; it does not exist yet, so the gate is
 * "is this actually the source whose units we hardcode".
 *
 * Safe as a gate because an OE device's `vendorSiteId` IS its region — `scripts/openelectricity/
 * seed-devices.ts` writes it and `resolveGridContextForDevice` looks the device up by it, so there
 * is no OE device for which it is absent. An AREA payload has no vendor site at all, which is
 * correct: the region is a property of the device.
 */
export function oeGridSelection(
  data: unknown,
): { region: NemRegion; values: GridLiveValues } | null {
  const values = gridLatestFromData(data);
  if (!values) return null;
  const siteId = (data as { device?: { vendorSiteId?: string | null } } | null)
    ?.device?.vendorSiteId;
  if (!siteId || !isNemRegion(siteId)) return null;
  return { region: siteId, values };
}
