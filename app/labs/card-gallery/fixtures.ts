/**
 * Hand-crafted mock data for the card gallery (app/labs/card-gallery).
 *
 * Each card reads a different shape — tiles render via the tile plugins
 * (components/dashboard/tiles/) from a
 * LatestPointValues map, the Amber/Tesla cards take a Record<string, LatestValue|null>, and
 * GridSignalsCard takes a typed GridLiveValues. These fixtures cover the interesting states
 * (charging/discharging, high/low/zero, missing) so the cards can be eyeballed at size.
 *
 * Every fixture here is FRESH. Staleness is orthogonal to what a card is showing, so it is not a
 * scenario — the gallery has a stale checkbox that runs any scenario through `makeStale` below.
 *
 * Timestamps are stamped at module import, which makes them relative to page load and is why the
 * gallery renders client-side only (see CardGallery's mounted gate): an SSR pass would bake a
 * different "now" into the HTML than the browser computes, and every relative time would mismatch.
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

/**
 * Age every measurement in a fixture, whatever shape the fixture is.
 *
 * Staleness is ORTHOGONAL to what a card is showing — a generator can be stale while running, while
 * locked out, or while cooling down — but it used to be modelled as one more mutually-exclusive
 * scenario ("stale") in every section's picker. That could only ever express ONE stale state per
 * card, and it was always the least interesting one (a stale idle generator), because the scenario
 * had to be hand-written and nobody writes eight of them. The gallery now carries a stale CHECKBOX
 * instead, and this is what it applies.
 *
 * Structural rather than per-shape on purpose: the fixtures below are five different shapes
 * (`LatestPointValues`, the loose Amber/Tesla `LatestValue`, `GridLiveValues` under a `values` key,
 * `BatteryContentsValues`, and the HWS card's flat object), and they nest their timestamps at
 * different depths. The one thing they all agree on is the KEY — every measurement instant in this
 * file is called `measurementTime` — so walk the tree and shift those, and a shape added later is
 * handled without touching this function.
 *
 * Both spellings are shifted because both are in use here: `Date` for the card fixtures and an ISO
 * `string` for `gm()`'s grid metrics. Non-mutating — these fixtures are module-level and shared, so
 * ageing one in place would leak into every other section that renders it.
 */
export function makeStale<T>(fixture: T): T {
  const shiftMs = (STALE - FRESH) * 1000;
  const walk = (node: unknown): unknown => {
    if (node instanceof Date) return node;
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => {
        if (k === "measurementTime") {
          if (v instanceof Date) return [k, new Date(v.getTime() - shiftMs)];
          if (typeof v === "string") {
            const t = Date.parse(v);
            return [
              k,
              Number.isFinite(t) ? new Date(t - shiftMs).toISOString() : v,
            ];
          }
          return [k, v];
        }
        return [k, walk(v)];
      }),
    );
  };
  return walk(fixture) as T;
}

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
  // The first ~10 s of our own run: the hub has latched, so it reports `running:hub`, but the
  // starter is still turning the engine. Below CRANK_RPM the hero must read "Starting" — this used
  // to say "Running" over an "Engine 0 rpm 0.0 Hz" row, which read as a fault.
  "starting (ours)": {
    "source.generator.control.status/state": genState("running:hub"),
    "source.generator.control.stop_at/time": stopAt(30),
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
  // The panel has not been read at all — must NOT claim the generator is armed. Named for BOTH
  // facts, because the hero shows both: the ENGINE is known stopped (the hub's `idle`), and only
  // the PANEL is unreadable, so the tile can say "Stopped" while withholding armed-vs-locked-out.
  "stopped, mode unknown": {
    "source.generator.control.status/state": genState("idle"),
  },
};

/**
 * The WRITABLE run-request point, carrying a `pointReference`.
 *
 * `GeneratorControlDialog` resolves its command target through `generatorRunRequestTarget` →
 * `pointIdOf`, which reads `pointReference` off this entry and validates it with `Point.parse`. A
 * fixture without it renders the dialog's "Waiting for the generator to report in." branch — a real
 * state, but not the one you usually want to look at. The id is a well-formed `pt_` so the parse
 * succeeds; nothing dereferences it, because the gallery's fetch stub answers every control route.
 */
const RUN_REQUEST: LatestPointValue = {
  value: 0,
  logicalPath: "source.generator.control.request",
  measurementTime: new Date(Date.now() - FRESH * 1000),
  metricUnit: "min",
  displayName: "Run Request",
  pointReference: "pt_01kybrhzkmfyxvz63d15rscj19",
  sourceSystemId: 14,
};

/**
 * Every generator scenario again, with the control point added — the shape a viewer who OWNS the
 * generator sees. Derived rather than hand-written so the two can never describe different engines.
 */
export const GENERATOR_CONTROL_SCENARIOS: Record<string, LatestPointValues> =
  Object.fromEntries(
    Object.entries(GENERATOR_SCENARIOS).map(([name, latest]) => [
      name,
      { ...latest, "source.generator.control.request/duration": RUN_REQUEST },
    ]),
  );

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
  // The one SoC that renders with no decimal — 100 is exact, so "100.0%" is noise.
  full: {
    "bidi.battery/soc": mk(100, "bidi.battery/soc", "%", "Battery"),
    "bidi.battery/power": mk(200, "bidi.battery/power", "W", "Battery"),
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
// (TeslaSmallCard has no staleness UI at all — ticking the gallery's stale box changes
//  nothing here, which is itself the thing worth knowing.)
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

/**
 * A control point as the CARD sees it: a value plus the `pt_` the dialog posts to.
 *
 * The scenarios above are the card's read-only shape and carry no `pointReference`, so
 * `teslaChargeControlTargets` resolves every target to null and the dialog renders with all three
 * commands disabled — a real state (a car that has not polled since the deploy), but not the one
 * you want to look at. Same reasoning, and the same well-formed-but-inert ids, as `RUN_REQUEST`:
 * the parse succeeds and nothing dereferences them, because the fetch stub answers every control
 * route.
 */
type ControlLatestValue = LatestValue & {
  pointReference: string;
  sourceSystemId: number;
};

const evControl = (value: number, pt: string): ControlLatestValue => ({
  value,
  measurementTime: new Date(Date.now() - FRESH * 1000),
  pointReference: pt,
  sourceSystemId: 6,
});

/**
 * Every Tesla scenario again, with the three charge-control points added — the shape a viewer who
 * OWNS the car sees. Derived from the read-only set rather than hand-written, so the card and the
 * dialog can never describe different cars (the same trick `GENERATOR_CONTROL_SCENARIOS` uses).
 *
 * `ev.charge/active` is the switch the Start/Stop buttons command; its value mirrors the scenario's
 * own charge state so the dialog's buttons agree with the words above them.
 */
export const TESLA_CONTROL_SCENARIOS: Record<
  string,
  Record<string, (LatestValue & Partial<ControlLatestValue>) | null>
> = Object.fromEntries(
  Object.entries(TESLA_SCENARIOS).map(([name, latest]) => [
    name,
    {
      ...latest,
      "ev.charge/active": evControl(
        latest["ev.charge/state"]?.value === "Charging" ? 1 : 0,
        "pt_01kybrhzkmfyxvz63d15rscj20",
      ),
      "ev.charge.limit/soc": evControl(
        Number(latest["ev.charge.limit/soc"]?.value ?? 80),
        "pt_01kybrhzkmfyxvz63d15rscj21",
      ),
      "ev.charge.limit/current": evControl(32, "pt_01kybrhzkmfyxvz63d15rscj22"),
    },
  ]),
);

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
