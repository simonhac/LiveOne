/**
 * Canonical information-slot catalog. Binding validation and runtime resolution consume the same
 * predicates, preventing the editor from accepting a point the resolver can never select.
 */
import type { AreaConfig } from "./types";
import type { RoleId } from "@/lib/roles/registry";
import { stemMatchesRole } from "@/lib/roles/registry";
import { CAPABILITIES, type CapabilityId } from "@/lib/capabilities/registry";

export interface SlotPoint {
  logicalPathStem: string | null;
  metricType: string;
}

export interface ResolutionSlotDef {
  slot: string;
  role: RoleId;
  /** Public semantic metric name. */
  metricType: string;
  matches: (point: SlotPoint) => boolean;
  config?: {
    key: string;
    available: (config: AreaConfig | null) => boolean;
  };
}

const exact =
  (stem: string, metric: string) =>
  (point: SlotPoint): boolean =>
    point.logicalPathStem === stem && point.metricType === metric;
const roleMetric =
  (role: RoleId, metric: string) =>
  (point: SlotPoint): boolean =>
    point.logicalPathStem != null &&
    point.metricType === metric &&
    stemMatchesRole(point.logicalPathStem, role);
const capability =
  (id: CapabilityId) =>
  (point: SlotPoint): boolean => {
    const match = CAPABILITIES[id].match;
    return (
      match != null &&
      point.logicalPathStem != null &&
      match(point.logicalPathStem, point.metricType)
    );
  };
const nonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const fraction = (value: unknown): value is number =>
  nonNegativeFinite(value) && value <= 1;
export const RESOLUTION_SLOTS: readonly ResolutionSlotDef[] = [
  {
    slot: "solar/power",
    role: "solar",
    metricType: "power",
    matches: capability("solar/power"),
  },
  {
    slot: "solar/energy",
    role: "solar",
    metricType: "energy",
    matches: roleMetric("solar", "energy"),
  },
  {
    slot: "load/power",
    role: "load",
    metricType: "power",
    matches: capability("load/power"),
  },
  {
    slot: "load/energy",
    role: "load",
    metricType: "energy",
    matches: roleMetric("load", "energy"),
  },
  {
    slot: "load.hws/temperature",
    role: "load",
    metricType: "temperature",
    matches: capability("load.hws/temperature"),
  },
  {
    slot: "battery/power",
    role: "battery",
    metricType: "power",
    matches: capability("battery/power"),
  },
  {
    slot: "battery/soc",
    role: "battery",
    metricType: "soc",
    matches: capability("battery/soc"),
  },
  {
    slot: "battery/charge-energy",
    role: "battery",
    metricType: "charge-energy",
    matches: exact("bidi.battery.charge", "energy"),
  },
  {
    slot: "battery/discharge-energy",
    role: "battery",
    metricType: "discharge-energy",
    matches: exact("bidi.battery.discharge", "energy"),
  },
  {
    slot: "battery/provenance",
    role: "battery",
    metricType: "stored-energy",
    matches: capability("battery/provenance"),
  },
  {
    slot: "grid/power",
    role: "grid",
    metricType: "power",
    matches: capability("grid/power"),
  },
  {
    slot: "grid/rate",
    role: "grid",
    metricType: "rate",
    matches: capability("grid/rate"),
    config: {
      key: "batteryProvenance.generatorSource.pricePerKwh",
      available: (config) =>
        nonNegativeFinite(
          config?.batteryProvenance?.generatorSource?.pricePerKwh,
        ),
    },
  },
  {
    slot: "grid/import-energy",
    role: "grid",
    metricType: "import-energy",
    matches: exact("bidi.grid.import", "energy"),
  },
  {
    slot: "grid/export-energy",
    role: "grid",
    metricType: "export-energy",
    matches: exact("bidi.grid.export", "energy"),
  },
  {
    slot: "grid/import-value",
    role: "grid",
    metricType: "import-value",
    matches: exact("bidi.grid.import", "value"),
  },
  {
    slot: "grid/export-value",
    role: "grid",
    metricType: "export-value",
    matches: exact("bidi.grid.export", "value"),
  },
  {
    slot: "grid/export-price",
    role: "grid",
    metricType: "export-price",
    // NO `config` alternative, unlike the slots below it: a feed-in tariff has exactly one source,
    // the bound point. `batteryProvenance.exportTariff` used to stand here as a rival — config that
    // restated what a binding already said, and could disagree with it.
    matches: exact("bidi.grid.export", "rate"),
  },
  {
    slot: "grid/emissions-intensity",
    role: "grid",
    metricType: "emissions-intensity",
    matches: exact("bidi.grid.emissionsIntensity", "intensity"),
    config: {
      key: "batteryProvenance.generatorSource.emissionsIntensity",
      available: (config) =>
        nonNegativeFinite(
          config?.batteryProvenance?.generatorSource?.emissionsIntensity,
        ),
    },
  },
  {
    slot: "grid/renewable-fraction",
    role: "grid",
    metricType: "renewable-fraction",
    matches: exact("bidi.grid.renewables", "proportion"),
    config: {
      key: "batteryProvenance.generatorSource.renewableFraction",
      available: (config) =>
        fraction(config?.batteryProvenance?.generatorSource?.renewableFraction),
    },
  },
  {
    slot: "ev/soc",
    role: "ev",
    metricType: "soc",
    matches: capability("ev/soc"),
  },
  {
    slot: "generator/power",
    role: "generator",
    metricType: "power",
    matches: roleMetric("generator", "power"),
  },
] as const;

/** Does this underlying point have any valid semantic shape for the requested binding role/metric? */
export function bindingShapeMatches(
  role: RoleId,
  rawMetricType: string,
  point: SlotPoint,
): boolean {
  if (point.logicalPathStem == null || point.metricType !== rawMetricType)
    return false;

  // 🛑 No carve-out. There used to be one here for the OpenElectricity regional market points,
  // which sat on a `grid.*` stem that `stemMatchesRole` (anchor `bidi.grid`) could never match.
  // They were renamed into `bidi.grid.*` instead — `bidi.grid` is the grid-CONNECTION namespace,
  // which Amber already uses for exactly these signals — so they now match by the ordinary rule and
  // the exception is gone. `grid.demand` (MW) was deliberately left behind, and is therefore no
  // longer bindable to role `grid` — the slot where the site's own W meters live — without a new
  // decision. See
  // lib/vendors/openelectricity/point-metadata.ts.
  return stemMatchesRole(point.logicalPathStem, role);
}
