/**
 * The stacked-vs-lines layout signal (isAggregateFromLatest / isAggregateFromPoints) — the vendor-free
 * replacement for getLayout(vendorType)==="site". Pinned against the real install shapes: a sub-LOAD
 * breakdown (load.<sub>, excluding hws) means a whole-home meter / multi-device area → stacked; a single
 * inverter (only load/power, possibly with sub-SOURCES) → lines.
 */
import { describe, it, expect } from "@jest/globals";
import type { LatestPointValue, LatestPointValues } from "@/lib/types/api";
import {
  isAggregateFromLatest,
  isAggregateFromPoints,
  type PointClass,
} from "@/lib/capabilities/derive";

const latest = (paths: string[]): LatestPointValues =>
  Object.fromEntries(
    paths.map((p): [string, LatestPointValue] => [
      p,
      {
        value: 1,
        logicalPath: p,
        measurementTime: new Date(0),
        metricUnit: "W",
        displayName: p,
      },
    ]),
  );

const points = (paths: string[]): PointClass[] =>
  paths.map((p) => {
    const i = p.lastIndexOf("/");
    return { logicalPathStem: p.slice(0, i), metricType: p.slice(i + 1) };
  });

describe("isAggregateFromLatest", () => {
  it("true when a real sub-load (load.<sub>) is present — mondo / multi-device", () => {
    expect(
      isAggregateFromLatest(latest(["load/power", "load.hvac/power"])),
    ).toBe(true);
    expect(isAggregateFromLatest(latest(["load.pool/power"]))).toBe(true);
  });

  it("false for a single inverter — only the master load, or a sub-SOURCE", () => {
    expect(
      isAggregateFromLatest(latest(["load/power", "source.solar/power"])),
    ).toBe(false);
    // selectronic reports source.solar.local but is sidebar — sub-source is NOT a stacking signal.
    expect(
      isAggregateFromLatest(latest(["load/power", "source.solar.local/power"])),
    ).toBe(false);
  });

  it("false for hot water alone (load.hws is excluded)", () => {
    expect(
      isAggregateFromLatest(latest(["load/power", "load.hws/power"])),
    ).toBe(false);
    expect(isAggregateFromLatest(latest(["load.hws/temperature"]))).toBe(false);
  });

  it("isAggregateFromPoints agrees with isAggregateFromLatest", () => {
    const p = ["load/power", "load.hvac/power", "source.solar.local/power"];
    expect(isAggregateFromPoints(points(p))).toBe(
      isAggregateFromLatest(latest(p)),
    );
    expect(
      isAggregateFromPoints(points(["load/power", "source.solar/power"])),
    ).toBe(false);
  });
});
