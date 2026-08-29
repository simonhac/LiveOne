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
import {
  computeRenewablesMetrics,
  type RenewablesEdgeAgg,
  type RenewablesSummary,
} from "@/lib/renewables/summary";

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
// Tile — Generator (the usher hub's control-plane points + engine speed)
// ---------------------------------------------------------------------------

/** A TEXT point. Text values travel as strings even though the type says number — see
 *  `getTextValue` in components/dashboard/tiles/shared.tsx. */
function mkText(
  value: string,
  logicalPath: string,
  displayName: string,
  ageSeconds: number = FRESH,
): LatestPointValue {
  return {
    value: value as unknown as number,
    logicalPath,
    measurementTime: new Date(Date.now() - ageSeconds * 1000),
    metricUnit: "text",
    displayName,
  };
}

/** `stop_at` as the hub pushes it: epoch SECONDS, `minutesAhead` from now. */
const stopAt = (minutesAhead: number): LatestPointValue =>
  mk(
    Math.round((Date.now() + minutesAhead * 60_000) / 1000),
    "source.generator.control.stop_at/time",
    "epoch_s",
    "Commanded Stop At",
  );

const genState = (state: string, ageSeconds?: number) =>
  mkText(
    state,
    "source.generator.control.status/state",
    "Control State",
    ageSeconds,
  );
const genMode = (mode: string, ageSeconds?: number) =>
  mkText(mode, "source.generator.mode/state", "Control Mode", ageSeconds);

// 🛑 The LEGACY logical paths on purpose — they are the ones prod actually carries. #150 renamed
// the musher manifest's stems, but `points` rows are keyed on `physical_path` and only `control` is
// drift-healed, so the already-minted rows kept `generator.engine` / `generator.output`. A fixture
// that used the manifest-correct paths would be testing a shape no environment has.
const genRpm = (rpm: number) =>
  mk(rpm, "generator.engine/speed", "rpm", "Engine Speed");
const genHz = (hz: number) =>
  mk(hz, "generator.output/frequency", "Hz", "Generator Frequency");

/** The engine, turning: rpm + Hz together, since the tile shows them as one row. */
const engine = (rpm: number, hz: number) => ({
  "generator.engine/speed": genRpm(rpm),
  "generator.output/frequency": genHz(hz),
});

export const GENERATOR_SCENARIOS: Record<string, LatestPointValues> = {
  "auto (armed)": {
    "source.generator.control.status/state": genState("idle"),
    "source.generator.mode/state": genMode("Auto"),
    ...engine(0, 0),
  },
  "running (ours)": {
    "source.generator.control.status/state": genState("running:hub"),
    "source.generator.control.stop_at/time": stopAt(23),
    "source.generator.mode/state": genMode("Auto"),
    ...engine(1502, 50.1),
  },
  "running (inverter)": {
    "source.generator.control.status/state": genState("running:sp-pro"),
    "source.generator.mode/state": genMode("Auto"),
    ...engine(1497, 49.9),
  },
  "cooling down": {
    "source.generator.control.status/state": genState("stopping"),
    "source.generator.mode/state": genMode("Auto"),
    ...engine(980, 32.4),
  },
  "locked out": {
    "source.generator.control.status/state": genState("idle"),
    "source.generator.mode/state": genMode("Stop"),
    ...engine(0, 0),
  },
  "running, panel locked": {
    "source.generator.control.status/state": genState("running:sp-pro"),
    "source.generator.mode/state": genMode("Stop"),
    ...engine(1499, 50.0),
  },
  "stop failing": {
    "source.generator.control.status/state": genState("stop-failing"),
    "source.generator.control.stop_at/time": stopAt(-2),
    "source.generator.control.error/state": mkText(
      "stop write failed: timeout — retrying every 15s until confirmed",
      "source.generator.control.error/state",
      "Control Last Error",
    ),
    "source.generator.mode/state": genMode("Auto"),
    ...engine(1502, 50.0),
  },
  "still running after release": {
    "source.generator.control.status/state": genState(
      "latch-released-still-running",
    ),
    "source.generator.mode/state": genMode("Auto"),
    ...engine(1488, 49.8),
  },
  // The panel has not been read at all — must NOT claim the generator is armed.
  "mode unknown": {
    "source.generator.control.status/state": genState("idle"),
  },
  stale: {
    "source.generator.control.status/state": genState("idle", STALE),
    "source.generator.mode/state": genMode("Auto", STALE),
    ...engine(0, 0),
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
// ⚠️ `bidi.grid.export/rate` is Amber's raw feedIn `perKwh`: NEGATIVE means you are being PAID.
// (AmberNow flips it for display; BatteryContentsCard values the store with the same flip.) These
// fixtures previously used the opposite sign, so "low"/"high"/"spike" all rendered as pay-to-export.

export const AMBER_SCENARIOS: Record<
  string,
  Record<string, LatestValue | null>
> = {
  low: {
    "bidi.grid.import/rate": lv(18),
    "bidi.grid.export/rate": lv(-6),
    "bidi.grid.renewables/proportion": lv(72),
    "bidi.grid.import/descriptor": lv("low"),
  },
  high: {
    "bidi.grid.import/rate": lv(55),
    "bidi.grid.export/rate": lv(-20),
    "bidi.grid.renewables/proportion": lv(30),
    "bidi.grid.import/descriptor": lv("high"),
  },
  spike: {
    "bidi.grid.import/rate": lv(182),
    "bidi.grid.export/rate": lv(-40),
    "bidi.grid.renewables/proportion": lv(12),
    "bidi.grid.import/descriptor": lv("spike"),
  },
  "negative feed-in": {
    "bidi.grid.import/rate": lv(30),
    "bidi.grid.export/rate": lv(5),
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
// TeslaSmallCard (ev.battery/soc, ev.charge/state|power|remaining|engaged,
// limit/soc, ev/shift)
// (TeslaSmallCard has no staleness UI, so no stale scenario.)
//
// `ev.charge/engaged` is a boolean point but reaches the client as 1/0 —
// convertValueByMetadata only special-cases metricUnit "text" — so it is
// faithfully mocked here as a number.
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
    "ev.charge/engaged": lv(1),
    "ev/shift": lv("P"),
  },
  charging: {
    "ev.battery/soc": lv(70),
    "ev.charge/state": lv("Charging"),
    "ev.charge/power": lv(7),
    "ev.charge/remaining": lv(2.25),
    "ev.charge.limit/soc": lv(90),
    "ev.charge/engaged": lv(1),
    "ev/shift": lv("P"),
  },
  connected: {
    "ev.battery/soc": lv(90),
    "ev.charge/state": lv("Stopped"),
    "ev.charge/power": lv(0),
    "ev.charge.limit/soc": lv(90),
    "ev.charge/engaged": lv(1),
    "ev/shift": lv("P"),
  },
  "not connected": {
    "ev.battery/soc": lv(64),
    "ev.charge/state": lv("Disconnected"),
    "ev.charge/power": lv(0),
    "ev.charge.limit/soc": lv(80),
    "ev.charge/engaged": lv(0),
    "ev/shift": lv("P"),
  },
  driving: {
    "ev.battery/soc": lv(42),
    "ev.charge/state": lv("Disconnected"),
    "ev.charge/power": lv(0),
    "ev.charge.limit/soc": lv(80),
    "ev.charge/engaged": lv(0),
    "ev/shift": lv("D"),
  },
  full: {
    "ev.battery/soc": lv(100),
    "ev.charge/state": lv("Complete"),
    "ev.charge/power": lv(0),
    "ev.charge.limit/soc": lv(100),
    "ev.charge/engaged": lv(1),
    "ev/shift": lv("P"),
  },
  low: {
    "ev.battery/soc": lv(12),
    "ev.charge/state": lv("Disconnected"),
    "ev.charge/power": lv(0),
    "ev.charge.limit/soc": lv(80),
    "ev.charge/engaged": lv(0),
    "ev/shift": lv("P"),
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
    [CP.exportRate]: -5.5,
  }),
  "very green": bc({
    [CP.storedEnergy]: 11.8,
    [CP.carbonIntensity]: 18,
    [CP.renewableFraction]: 96,
    [CP.priceActual]: 1.2,
    [CP.priceOpportunity]: 9.0,
    [CP.exportRate]: -6.0,
  }),
  "negative actual price": bc({
    [CP.storedEnergy]: 6.0,
    [CP.carbonIntensity]: 320,
    [CP.renewableFraction]: 30,
    [CP.priceActual]: -3.0,
    [CP.priceOpportunity]: 4.0,
    [CP.exportRate]: -3.0,
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
      [CP.exportRate]: -5.5,
    },
    STALE,
  ),
};

// ---------------------------------------------------------------------------
// HomeEnergyCard (RenewablesSummary — the period's consumption, valued)
// ---------------------------------------------------------------------------
// Built by feeding plausible source→load edges through the real reducer, so every derived
// number (the filtered ¢/kWh and g/kWh averages, the ratios, the totals) is computed exactly
// as in prod. Cost is signed CENTS and emissions are GRAMS, per edge, over the whole period.
function he(edges: Partial<RenewablesEdgeAgg>[]): RenewablesSummary {
  return computeRenewablesMetrics(
    edges.map((p) => ({
      sourcePath: "source.solar",
      loadPath: "load",
      energyKwh: 0,
      renewableKwh: 0,
      selfRenewableKwh: 0,
      selfRenewableNullRows: 0,
      estimatedKwh: 0,
      emissionsG: 0,
      emissionsKnownKwh: 0,
      costC: 0,
      costKnownKwh: 0,
      ...p,
    })),
  );
}

/** A priced+carbon-costed edge: `e` kWh at `c` cents/kWh and `g` grams/kWh, `r` renewable kWh. */
function edge(
  sourcePath: string,
  loadPath: string,
  e: number,
  c: number,
  g: number,
  r: number,
  selfRenew: number,
): Partial<RenewablesEdgeAgg> {
  return {
    sourcePath,
    loadPath,
    energyKwh: e,
    renewableKwh: r,
    selfRenewableKwh: selfRenew,
    emissionsG: e * g,
    emissionsKnownKwh: e,
    costC: e * c,
    costKnownKwh: e,
  };
}

export const HOME_ENERGY_SCENARIOS: Record<string, RenewablesSummary | null> = {
  // A grid-connected solar+battery day: solar direct, battery evening, some grid import, an export.
  typical: he([
    edge("source.solar", "load", 8.4, 0, 0, 8.4, 8.4),
    edge("source.battery", "load", 5.1, 6.2, 90, 3.6, 2.6),
    edge("source.grid", "load", 4.2, 31.5, 620, 1.5, 0),
    edge("source.solar", "load.grid", 6.3, -5.5, 0, 6.3, 6.3), // export — excluded
    edge("source.solar", "load.battery", 5.6, 0, 0, 5.6, 5.6), // charge — excluded
  ]),
  // Sunny + fully self-supplied: free, zero-carbon, 100% renewable.
  "all solar": he([
    edge("source.solar", "load", 12.0, 0, 0, 12.0, 12.0),
    edge("source.solar", "load.grid", 9.0, -5.5, 0, 9.0, 9.0),
  ]),
  // Grid-only site: no own generation → Autarky 0, Self-use "—".
  "grid only": he([edge("source.grid", "load", 18.6, 34.0, 680, 6.1, 0)]),
  // A negative wholesale window: the period's consumption cost lands below zero.
  "negative rate": he([
    edge("source.grid", "load", 9.0, -4.0, 540, 3.0, 0),
    edge("source.solar", "load", 3.0, 0, 0, 3.0, 3.0),
  ]),
  // Partial self_renewable data → BOTH ratios unavailable, but the stats still compute.
  "partial self-renewable": he([
    edge("source.solar", "load", 7.0, 0, 0, 7.0, 7.0),
    {
      sourcePath: "source.battery",
      loadPath: "load",
      energyKwh: 4.0,
      renewableKwh: 2.4,
      selfRenewableNullRows: 1,
      emissionsG: 4.0 * 120,
      emissionsKnownKwh: 4.0,
      costC: 4.0 * 9,
      costKnownKwh: 4.0,
    },
  ]),
  // No known intensity anywhere → the rate/emissions stats em-dash while `consumed` still reads.
  "no intensities": he([
    { sourcePath: "source.grid", loadPath: "load", energyKwh: 11.3 },
  ]),
  // Nothing materialised for the window yet.
  "no data": null,
};

// ---------------------------------------------------------------------------
// Hot Water (HwsSmallCard) — plain props, not a `latest` map. The only card carrying a
// TIGHT-but-unmuted unit ("°C"), so it is the visual regression surface for that binding.
// ---------------------------------------------------------------------------
export interface HwsScenario {
  faucetC: number | null;
  /** Positional — one slot per interval, null where there is no reading. See lib/charts/sparkline.ts. */
  sparkValues: (number | null)[];
  measurementTime?: Date;
  heating: boolean;
}

/** A plausible 24h faucet-temperature curve, scaled to end at `endC`. */
function hwsSpark(endC: number): number[] {
  const shape = [
    0.62, 0.58, 0.55, 0.52, 0.5, 0.49, 0.52, 0.6, 0.72, 0.85, 0.95, 1.0, 0.98,
    0.94, 0.9, 0.88, 0.86, 0.84, 0.82, 0.8, 0.78, 0.75, 0.72, 0.7,
  ];
  return shape.map((f) => Math.round(endC * f * 10) / 10);
}

/** The same curve with its newest `n` intervals not yet produced — the line must stop short. */
function hwsSparkLaggingTail(endC: number, n: number): (number | null)[] {
  const full = hwsSpark(endC);
  return full.map((v, i) => (i >= full.length - n ? null : v));
}

export const HWS_SCENARIOS: Record<string, HwsScenario> = {
  hot: {
    faucetC: 62.4,
    sparkValues: hwsSpark(62.4),
    measurementTime: new Date(Date.now() - FRESH * 1000),
    heating: false,
  },
  heating: {
    faucetC: 48.0,
    sparkValues: hwsSpark(48),
    measurementTime: new Date(Date.now() - FRESH * 1000),
    heating: true,
  },
  cold: {
    faucetC: 9.5,
    sparkValues: hwsSpark(9.5),
    measurementTime: new Date(Date.now() - FRESH * 1000),
    heating: false,
  },
  stale: {
    faucetC: 40.0,
    sparkValues: hwsSpark(40),
    measurementTime: new Date(Date.now() - STALE * 1000),
    heating: false,
  },
  // The live value is current but the history series has not caught up. The line MUST stop short of
  // the right-hand edge — if it reaches it, the sparkline is claiming data it does not have.
  "lagging tail": {
    faucetC: 35.6,
    sparkValues: hwsSparkLaggingTail(40, 5),
    measurementTime: new Date(Date.now() - FRESH * 1000),
    heating: false,
  },
  // A mid-window outage: the line breaks rather than bridging readings nobody took.
  "gap mid-window": {
    faucetC: 52.0,
    sparkValues: hwsSpark(52).map((v, i) => (i >= 9 && i <= 12 ? null : v)),
    measurementTime: new Date(Date.now() - FRESH * 1000),
    heating: false,
  },
};
