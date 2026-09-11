/**
 * Which archive column becomes which point.
 *
 * 🛑 The case that matters is Mondo's two battery-ish points. `Battery Storage` (the
 * `HybridBattery`) carries `bidi.battery/power`; `Battery` (the `Hybridinverter`) has NO logical
 * path at all, because `adapter.ts` derives a stem for solar/battery/grid/load and lets
 * `"inverter"` fall through to null. They sit side by side with near-identical names, and the
 * overlap against the Fronius is what settles them: `battery_storage_w` tracks
 * `5/bidi.battery/power` at r = 0.9976 slope 0.999, `battery_w` at r = 0.675–0.934. Mapping them
 * the wrong way round yields a plausible battery trace that is not the battery.
 */
import { describe, it, expect } from "@jest/globals";
import {
  MONDO_5MIN,
  describeMatcher,
  resolveMatcher,
  type PointRow,
} from "../mapping";

const p = (over: Partial<PointRow> & { id: string }): PointRow => ({
  physicalPath: "x",
  logicalPath: null,
  metricType: "power",
  unit: "W",
  name: "x",
  ...over,
});

/** The real shape: both battery points, each with a power/energy twin sharing its name. */
const POINTS: PointRow[] = [
  p({
    id: "pt_storage_power",
    name: "Battery Storage",
    logicalPath: "bidi.battery/power",
    physicalPath: "grp/ddd29e41/energyNowW",
  }),
  p({
    id: "pt_storage_energy",
    name: "Battery Storage",
    physicalPath: "grp/ddd29e41/totalEnergyWh",
    metricType: "energy",
  }),
  p({
    id: "pt_inverter_power",
    name: "Battery",
    physicalPath: "grp/5ecacac2/energyNowW",
  }),
  p({
    id: "pt_inverter_energy",
    name: "Battery",
    physicalPath: "grp/5ecacac2/totalEnergyWh",
    metricType: "energy",
  }),
];

describe("resolveMatcher", () => {
  it("keeps the two battery points apart", () => {
    const storage = MONDO_5MIN.find((m) => m.source === "battery_storage_w")!;
    const inverter = MONDO_5MIN.find((m) => m.source === "battery_w")!;
    expect(resolveMatcher(POINTS, storage.match).map((x) => x.id)).toEqual([
      "pt_storage_power",
    ]);
    expect(resolveMatcher(POINTS, inverter.match).map((x) => x.id)).toEqual([
      "pt_inverter_power",
    ]);
  });

  it("needs the physical-path suffix to disambiguate a name-matched point", () => {
    // `Battery` names BOTH the power point and its totalEnergyWh twin. Without the suffix the
    // matcher is ambiguous, and the CLI refuses on any count but one.
    expect(
      resolveMatcher(POINTS, { by: "name", value: "Battery" }).length,
    ).toBe(2);
  });

  it("returns nothing rather than guessing when a point is absent", () => {
    const siteLoad = MONDO_5MIN.find((m) => m.source === "site_load_w")!;
    expect(resolveMatcher(POINTS, siteLoad.match)).toEqual([]);
  });
});

describe("MONDO_5MIN", () => {
  it("maps every column the archive carries, and none it does not", () => {
    // The archive's own column list, minus the two timestamps. A column added to the exporter and
    // not to this table would be silently dropped; one removed would refuse at run time.
    expect(new Set(MONDO_5MIN.map((m) => m.source))).toEqual(
      new Set([
        "battery_w",
        "battery_storage_w",
        "heat_pump_w",
        "hvac_w",
        "meter_mains_power_w",
        "pool_w",
        "solar_1_w",
        "solar_2_w",
        "tesla_ev_charger_w",
        "battery_soc_pct",
        "site_load_w",
      ]),
    );
  });

  it("scales nothing — the archive is already in each point's unit", () => {
    // Watts averaged over the interval, against watt points; percent against a soc point. The
    // handoff's warning is about the reverse mistake (treating averaged watts as energy), and the
    // defence against it is that there is no conversion here to get wrong.
    for (const m of MONDO_5MIN) expect(m.scale).toBeUndefined();
  });

  it("names one point per column", () => {
    expect(new Set(MONDO_5MIN.map((m) => describeMatcher(m.match))).size).toBe(
      MONDO_5MIN.length,
    );
  });
});
