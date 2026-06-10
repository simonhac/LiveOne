import { describe, it, expect } from "@jest/globals";
import {
  flowPathToDeviceStem,
  colorForFlowPath,
  labelForFlowPath,
  compareSourcePaths,
  compareLoadPaths,
} from "../flow-node-meta";
import { CHART_COLORS, getColorForPath } from "../../chart-colors";

describe("flowPathToDeviceStem", () => {
  it("normalizes directional battery/grid to the device stem", () => {
    expect(flowPathToDeviceStem("source.battery")).toBe("bidi.battery");
    expect(flowPathToDeviceStem("load.battery")).toBe("bidi.battery");
    expect(flowPathToDeviceStem("source.grid")).toBe("bidi.grid");
    expect(flowPathToDeviceStem("load.grid")).toBe("bidi.grid");
  });
  it("passes solar and load paths through unchanged", () => {
    expect(flowPathToDeviceStem("source.solar.local")).toBe(
      "source.solar.local",
    );
    expect(flowPathToDeviceStem("load.hws")).toBe("load.hws");
    expect(flowPathToDeviceStem("load.rest-of-house")).toBe(
      "load.rest-of-house",
    );
  });
});

describe("colorForFlowPath", () => {
  it("resolves battery/grid to their device colors (not the gray fallback)", () => {
    expect(colorForFlowPath("source.battery")).toBe(CHART_COLORS.battery.main);
    expect(colorForFlowPath("load.battery")).toBe(CHART_COLORS.battery.main);
    expect(colorForFlowPath("source.grid")).toBe(CHART_COLORS.grid.main);
    expect(colorForFlowPath("load.grid")).toBe(CHART_COLORS.grid.main);
  });
  it("resolves solar / rest-of-house / sub-meters (matching the full-path getColorForPath)", () => {
    expect(colorForFlowPath("source.solar.local")).toBe(
      CHART_COLORS.solar.primary,
    );
    expect(colorForFlowPath("source.solar.remote")).toBe(
      CHART_COLORS.solar.secondary,
    );
    expect(colorForFlowPath("source.solar.residual")).toBe(
      CHART_COLORS.solar.residual,
    );
    expect(colorForFlowPath("load.rest-of-house")).toBe(
      CHART_COLORS.restOfHouse,
    );
    expect(colorForFlowPath("load.hws")).toBe(
      getColorForPath("load.hws/power"),
    );
  });
});

describe("labelForFlowPath", () => {
  const names = new Map<string, string>([
    ["source.solar.local", "Rooftop"],
    ["load.hws", "Hot Water"],
    ["load", "Site Load"],
  ]);

  it("uses fixed directional labels for battery/grid", () => {
    expect(labelForFlowPath("source.battery", names)).toBe("Battery Discharge");
    expect(labelForFlowPath("load.battery", names)).toBe("Battery Charge");
    expect(labelForFlowPath("source.grid", names)).toBe("Grid Import");
    expect(labelForFlowPath("load.grid", names)).toBe("Grid Export");
  });
  it("labels the synthetic remainder 'Other'", () => {
    expect(labelForFlowPath("load.rest-of-house", names)).toBe("Other");
  });
  it("prefers configured display names, falling back to derived labels", () => {
    expect(labelForFlowPath("source.solar.local", names)).toBe("Rooftop");
    expect(labelForFlowPath("source.solar.remote", names)).toBe("Solar Remote");
    expect(labelForFlowPath("source.solar", names)).toBe("Solar");
    expect(labelForFlowPath("load.hws", names)).toBe("Hot Water");
    expect(labelForFlowPath("load", names)).toBe("Site Load");
    expect(labelForFlowPath("load.pool", names)).toBe("Pool");
  });
});

describe("ordering", () => {
  it("orders sources solar → battery → grid", () => {
    const sorted = [
      "source.grid",
      "source.battery",
      "source.solar.residual",
      "source.solar.local",
      "source.solar.remote",
    ].sort(compareSourcePaths);
    expect(sorted).toEqual([
      "source.solar.local",
      "source.solar.remote",
      "source.solar.residual",
      "source.battery",
      "source.grid",
    ]);
  });
  it("orders loads battery → grid → master → sub-meters → rest-of-house", () => {
    const sorted = [
      "load.rest-of-house",
      "load.hws",
      "load",
      "load.grid",
      "load.battery",
    ].sort(compareLoadPaths);
    expect(sorted).toEqual([
      "load.battery",
      "load.grid",
      "load",
      "load.hws",
      "load.rest-of-house",
    ]);
  });
});
