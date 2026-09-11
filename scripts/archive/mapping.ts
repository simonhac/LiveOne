/**
 * Which archive column becomes which LiveOne point.
 *
 * 🛑 A mapping resolves against a REAL point inventory (`liveone device points <d> --format json`),
 * never against a hardcoded `pt_` id. Point ids are minted per environment, so a literal here would
 * be right on prod and silently wrong on dev — and "silently" is the operative word, because every
 * id is a well-formed `pt_` that some other point may answer to.
 *
 * 🛑 Matching is by LOGICAL PATH where one exists and by DISPLAY NAME where one does not, and a
 * match that is not exactly one point is a refusal. Mondo mints its points dynamically per
 * monitoring point, so several carry `logical_path = NULL` and are addressable only as
 * `<rid>/<metric>` — `Battery` (the `Hybridinverter`) is the one that matters here, because it sits
 * beside `Battery Storage` (the `HybridBattery`) and the two are NOT the same measurement. The
 * overlap settles which is which: against the Fronius over two months either side of the gap,
 * `battery_storage_w` tracks `5/bidi.battery/power` at r = 0.9976, slope 0.999, and `battery_w` at
 * r = 0.675–0.934. Mapping them the wrong way round produces a plausible battery trace that is not
 * the battery.
 */

/** How one archive column finds its point. */
export type Matcher =
  | { by: "logicalPath"; value: string }
  | { by: "physicalPath"; value: string }
  // For a point with no logical path. `name` is the vendor's own label, which is also where the
  // archive's column name came from, so the two move together.
  | { by: "name"; value: string; physicalPathEndsWith?: string };

export interface ColumnMapping {
  /** The CSV column, or a derived quantity's name when `compute` is set. */
  source: string;
  match: Matcher;
  /** Multiply the archive value by this to reach the point's unit. 1 when they already agree. */
  scale?: number;
}

export interface PointRow {
  id: string;
  physicalPath: string;
  logicalPath: string | null;
  metricType: string;
  unit: string;
  name: string;
}

export function resolveMatcher(points: PointRow[], m: Matcher): PointRow[] {
  switch (m.by) {
    case "logicalPath":
      return points.filter((p) => p.logicalPath === m.value);
    case "physicalPath":
      return points.filter((p) => p.physicalPath === m.value);
    case "name":
      return points.filter(
        (p) =>
          p.name === m.value &&
          (m.physicalPathEndsWith === undefined ||
            p.physicalPath.endsWith(m.physicalPathEndsWith)),
      );
  }
}

export function describeMatcher(m: Matcher): string {
  return m.by === "name" && m.physicalPathEndsWith
    ? `name="${m.value}" ending "${m.physicalPathEndsWith}"`
    : `${m.by}="${m.value}"`;
}

/**
 * Mondo's 5-minute archive → Kinkora Mondo (device 6).
 *
 * Every column is already WATTS averaged over the interval, and every target point is watts, so
 * nothing is scaled. `battery_soc_pct` is a percentage against a `soc` point; `site_load_w` is the
 * vendor's own computed demand, which `/subcircuit/` cannot produce at all (see
 * `lib/vendors/mondo/live-usage.ts`) — those two are the reason this archive is worth importing at
 * all, since device 6 already holds the other nine from its own polling.
 */
export const MONDO_5MIN: ColumnMapping[] = [
  {
    source: "battery_storage_w",
    match: { by: "logicalPath", value: "bidi.battery/power" },
  },
  {
    source: "meter_mains_power_w",
    match: { by: "logicalPath", value: "bidi.grid/power" },
  },
  {
    source: "solar_1_w",
    match: { by: "logicalPath", value: "source.solar.local/power" },
  },
  {
    source: "solar_2_w",
    match: { by: "logicalPath", value: "source.solar.remote/power" },
  },
  {
    source: "heat_pump_w",
    match: { by: "logicalPath", value: "load.hws/power" },
  },
  { source: "hvac_w", match: { by: "logicalPath", value: "load.hvac/power" } },
  { source: "pool_w", match: { by: "logicalPath", value: "load.pool/power" } },
  {
    source: "tesla_ev_charger_w",
    match: { by: "logicalPath", value: "load.ev/power" },
  },
  {
    source: "battery_soc_pct",
    match: { by: "logicalPath", value: "bidi.battery/soc" },
  },
  { source: "site_load_w", match: { by: "logicalPath", value: "load/power" } },
  // The `Hybridinverter`, which has no logical path — see the header. Addressed by its vendor label
  // plus the power suffix, so it cannot collide with its own `totalEnergyWh` twin (same name).
  {
    source: "battery_w",
    match: {
      by: "name",
      value: "Battery",
      physicalPathEndsWith: "/energyNowW",
    },
  },
];
