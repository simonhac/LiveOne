/**
 * Hand-crafted mock data for the card gallery (app/labs/card-gallery).
 *
 * Each card reads a different shape — tiles render via the tile plugins
 * (components/dashboard/tiles/) from a
 * LatestPointValues map, the Amber/Tesla cards take a Record<string, LatestValue|null>, and
 * GridSignalsCard takes a typed GridLiveValues. These fixtures cover the interesting states
 * (charging/discharging, stale, high/low/zero, missing) so the cards can be eyeballed at size.
 *
 * Timestamps are stamped at module import; "fresh" states sit well inside the staleness window
 * and "stale" states are aged past it (Tile/Tesla threshold ~300s, GridSignals ~900s).
 */
import type { LatestPointValue, LatestPointValues } from "@/lib/types/api";
import type { LatestValue } from "@/lib/amber-utils";
import type { GridLiveValues } from "@/lib/grid/latest";
import {
  batteryContentsFromData,
  CONTENTS_LATEST_PATHS as CP,
  type BatteryContentsValues,
} from "@/lib/battery/contents-latest";

const FRESH = 30; // seconds old — comfortably fresh
const STALE = 1200; // seconds old — past every threshold here

/** Build a LatestPointValue (the numeric power/energy shape Tile nodes consume). */
function mk(
  value: number,
  logicalPath: string,
  metricUnit: string,
  displayName: string,
  ageSeconds: number = FRESH,
): LatestPointValue {
  return {
    value,
    logicalPath,
    measurementTime: new Date(Date.now() - ageSeconds * 1000),
    metricUnit,
    displayName,
  };
}

/** Build a LatestValue (the loose Amber/Tesla shape, value may be string). */
function lv(value: number | string, ageSeconds: number = FRESH): LatestValue {
  return { value, measurementTime: new Date(Date.now() - ageSeconds * 1000) };
}

// ---------------------------------------------------------------------------
// Tile — Solar (source.solar/power, with optional local/remote breakdown)
// ---------------------------------------------------------------------------
export const SOLAR_SCENARIOS: Record<string, LatestPointValues> = {
  "local + remote": {
    "source.solar.local/power": mk(
      3200,
      "source.solar.local/power",
      "W",
      "Local",
    ),
    "source.solar.remote/power": mk(
      1800,
      "source.solar.remote/power",
      "W",
      "Remote",
    ),
  },
  "total only": {
    "source.solar/power": mk(4500, "source.solar/power", "W", "Solar"),
  },
  zero: {
    "source.solar/power": mk(0, "source.solar/power", "W", "Solar"),
  },
  stale: {
    "source.solar/power": mk(4500, "source.solar/power", "W", "Solar", STALE),
  },
};

// ---------------------------------------------------------------------------
// Tile — Load (load/power + load.* children + synthesized rest-of-house)
// ---------------------------------------------------------------------------
export const LOAD_SCENARIOS: Record<string, LatestPointValues> = {
  "with children": {
    "load/power": mk(7200, "load/power", "W", "Load"),
    "load.hvac/power": mk(2400, "load.hvac/power", "W", "HVAC"),
    "load.pool/power": mk(900, "load.pool/power", "W", "Pool"),
  },
  "master only": {
    "load/power": mk(3500, "load/power", "W", "Load"),
  },
  stale: {
    "load/power": mk(3500, "load/power", "W", "Load", STALE),
  },
};

// ---------------------------------------------------------------------------
// Tile — Battery (bidi.battery/soc + bidi.battery/power; sign: -=charging)
// ---------------------------------------------------------------------------
export const BATTERY_SCENARIOS: Record<string, LatestPointValues> = {
  charging: {
    "bidi.battery/soc": mk(65, "bidi.battery/soc", "%", "Battery"),
    "bidi.battery/power": mk(-3200, "bidi.battery/power", "W", "Battery"),
  },
  discharging: {
    "bidi.battery/soc": mk(48, "bidi.battery/soc", "%", "Battery"),
    "bidi.battery/power": mk(2600, "bidi.battery/power", "W", "Battery"),
  },
  idle: {
    "bidi.battery/soc": mk(90, "bidi.battery/soc", "%", "Battery"),
    "bidi.battery/power": mk(0, "bidi.battery/power", "W", "Battery"),
  },
  "low SoC": {
    "bidi.battery/soc": mk(8, "bidi.battery/soc", "%", "Battery"),
    "bidi.battery/power": mk(-500, "bidi.battery/power", "W", "Battery"),
  },
  stale: {
    "bidi.battery/soc": mk(65, "bidi.battery/soc", "%", "Battery", STALE),
    "bidi.battery/power": mk(
      -3200,
      "bidi.battery/power",
      "W",
      "Battery",
      STALE,
    ),
  },
};

// ---------------------------------------------------------------------------
// Tile — Grid (bidi.grid/power; sign: +=import, -=export)
// ---------------------------------------------------------------------------
export const GRID_SCENARIOS: Record<string, LatestPointValues> = {
  importing: {
    "bidi.grid/power": mk(4200, "bidi.grid/power", "W", "Grid"),
  },
  exporting: {
    "bidi.grid/power": mk(-3800, "bidi.grid/power", "W", "Grid"),
  },
  "high import": {
    "bidi.grid/power": mk(8000, "bidi.grid/power", "W", "Grid"),
  },
  idle: {
    "bidi.grid/power": mk(50, "bidi.grid/power", "W", "Grid"),
  },
  stale: {
    "bidi.grid/power": mk(4200, "bidi.grid/power", "W", "Grid", STALE),
  },
};

// ---------------------------------------------------------------------------
// AmberSmallCard / AmberNow (bidi.grid.import/rate etc. — c/kWh, %, descriptor)
// ---------------------------------------------------------------------------
export const AMBER_SCENARIOS: Record<
  string,
  Record<string, LatestValue | null>
> = {
  low: {
    "bidi.grid.import/rate": lv(18),
    "bidi.grid.export/rate": lv(6),
    "bidi.grid.renewables/proportion": lv(72),
    "bidi.grid.import/descriptor": lv("low"),
  },
  high: {
    "bidi.grid.import/rate": lv(55),
    "bidi.grid.export/rate": lv(20),
    "bidi.grid.renewables/proportion": lv(30),
    "bidi.grid.import/descriptor": lv("high"),
  },
  spike: {
    "bidi.grid.import/rate": lv(182),
    "bidi.grid.export/rate": lv(40),
    "bidi.grid.renewables/proportion": lv(12),
    "bidi.grid.import/descriptor": lv("spike"),
  },
  "negative feed-in": {
    "bidi.grid.import/rate": lv(30),
    "bidi.grid.export/rate": lv(-5),
    "bidi.grid.renewables/proportion": lv(55),
    "bidi.grid.import/descriptor": lv("neutral"),
  },
  "no feed-in": {
    "bidi.grid.import/rate": lv(25),
    "bidi.grid.renewables/proportion": lv(60),
    "bidi.grid.import/descriptor": lv("low"),
  },
};

// ---------------------------------------------------------------------------
// TeslaSmallCard (ev.battery/soc, ev.charge/state|power|remaining, limit/soc)
// (TeslaSmallCard has no staleness UI, so no stale scenario.)
// ---------------------------------------------------------------------------
export const TESLA_SCENARIOS: Record<
  string,
  Record<string, LatestValue | null>
> = {
  "charging (high power)": {
    "ev.battery/soc": lv(55),
    "ev.charge/state": lv("Charging"),
    "ev.charge/power": lv(22),
    "ev.charge/remaining": lv(1.5),
    "ev.charge.limit/soc": lv(80),
  },
  charging: {
    "ev.battery/soc": lv(70),
    "ev.charge/state": lv("Charging"),
    "ev.charge/power": lv(7),
    "ev.charge/remaining": lv(2.25),
    "ev.charge.limit/soc": lv(90),
  },
  "not charging": {
    "ev.battery/soc": lv(90),
    "ev.charge/state": lv("Stopped"),
    "ev.charge/power": lv(0),
    "ev.charge.limit/soc": lv(90),
  },
  full: {
    "ev.battery/soc": lv(100),
    "ev.charge/state": lv("Complete"),
    "ev.charge/power": lv(0),
    "ev.charge.limit/soc": lv(100),
  },
  low: {
    "ev.battery/soc": lv(12),
    "ev.charge/state": lv("Stopped"),
    "ev.charge/power": lv(0),
    "ev.charge.limit/soc": lv(80),
  },
};

// ---------------------------------------------------------------------------
// GridSignalsCard (GridLiveValues — price $/MWh, emissions tCO2e/MWh, %, demand MW)
// Card shows: price as "$N/MWh", emissions*1000 -> g CO₂/kWh, renewables as %, demand as MW.
// ---------------------------------------------------------------------------
function gm(value: number, ageSeconds: number = FRESH) {
  return {
    value,
    measurementTime: new Date(Date.now() - ageSeconds * 1000).toISOString(),
  };
}

export const GRID_SIGNALS_SCENARIOS: Record<
  string,
  { regionLabel: string; values: GridLiveValues | null }
> = {
  "high renewables": {
    regionLabel: "NSW1",
    values: {
      price: gm(50),
      emissionsIntensity: gm(0.12),
      renewables: gm(78),
      demand: gm(6850),
    },
  },
  "low renewables": {
    regionLabel: "VIC1",
    values: {
      price: gm(90),
      emissionsIntensity: gm(0.65),
      renewables: gm(22),
      demand: gm(5420),
    },
  },
  "negative price": {
    regionLabel: "SA1",
    values: {
      price: gm(-30),
      emissionsIntensity: gm(0.1),
      renewables: gm(85),
      demand: gm(1180),
    },
  },
  "missing metric": {
    regionLabel: "QLD1",
    values: {
      price: gm(60),
      emissionsIntensity: null,
      renewables: gm(40),
      demand: gm(7240),
    },
  },
  stale: {
    regionLabel: "NSW1",
    values: {
      price: gm(50, STALE),
      emissionsIntensity: gm(0.12, STALE),
      renewables: gm(78, STALE),
      demand: gm(6850, STALE),
    },
  },
};

// ---------------------------------------------------------------------------
// BatteryContentsCard (BatteryContentsValues — usable kWh + valued inventory)
// ---------------------------------------------------------------------------
// Built by feeding a raw `latest` map through the real selector, so the derived totals
// (total carbon/cost/export value, opportunity split) are computed exactly as in prod.
function bc(
  entries: Partial<Record<string, number>>,
  ageSeconds: number = FRESH,
): BatteryContentsValues | null {
  const latest: Record<string, { value: number; measurementTime: Date }> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v != null)
      latest[k] = {
        value: v,
        measurementTime: new Date(Date.now() - ageSeconds * 1000),
      };
  }
  return batteryContentsFromData({ latest });
}

export const BATTERY_CONTENTS_SCENARIOS: Record<
  string,
  BatteryContentsValues | null
> = {
  typical: bc({
    [CP.storedEnergy]: 9.2,
    [CP.carbonIntensity]: 210,
    [CP.renewableFraction]: 62,
    [CP.priceActual]: 8.4,
    [CP.priceOpportunity]: 14.1,
    [CP.exportRate]: 5.5,
  }),
  "very green": bc({
    [CP.storedEnergy]: 11.8,
    [CP.carbonIntensity]: 18,
    [CP.renewableFraction]: 96,
    [CP.priceActual]: 1.2,
    [CP.priceOpportunity]: 9.0,
    [CP.exportRate]: 6.0,
  }),
  "negative actual price": bc({
    [CP.storedEnergy]: 6.0,
    [CP.carbonIntensity]: 320,
    [CP.renewableFraction]: 30,
    [CP.priceActual]: -3.0,
    [CP.priceOpportunity]: 4.0,
    [CP.exportRate]: 3.0,
  }),
  // No export tariff → opportunity == actual (no split) and no export-value stat.
  "no tariff": bc({
    [CP.storedEnergy]: 8.0,
    [CP.carbonIntensity]: 180,
    [CP.renewableFraction]: 70,
    [CP.priceActual]: 6.0,
    [CP.priceOpportunity]: 6.0,
  }),
  // Engine not backfilled yet: intensities present, no stored-energy → totals em-dash.
  "warm-up (intensities only)": bc({
    [CP.carbonIntensity]: 150,
    [CP.renewableFraction]: 55,
    [CP.priceActual]: 7.0,
    [CP.priceOpportunity]: 7.0,
  }),
  "empty battery": bc({ [CP.storedEnergy]: 0 }),
  stale: bc(
    {
      [CP.storedEnergy]: 9.2,
      [CP.carbonIntensity]: 210,
      [CP.renewableFraction]: 62,
      [CP.priceActual]: 8.4,
      [CP.priceOpportunity]: 14.1,
      [CP.exportRate]: 5.5,
    },
    STALE,
  ),
};
