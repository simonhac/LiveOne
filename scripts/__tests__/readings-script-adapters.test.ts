import { describe, expect, it } from "@jest/globals";
import { Point } from "@/lib/ids";
import type { ActivePointLatest } from "@/lib/readings";
import type { PointAddr } from "@/lib/registry";
import { toAgg5mInsert } from "../openelectricity/bulk-ingest-helpers";
import { groupLatestByDevice } from "../utils/rebuild-dev-kv-helpers";

describe("readings script adapters", () => {
  it("maps scalar, counter, delta, and invalid OE values to DAO inserts", () => {
    const scalar = Point.generate();
    const counter = Point.generate();
    const delta = Point.generate();
    const targets = new Map([
      ["price", { point: scalar, metricType: "price", transform: null }],
      ["demand", { point: counter, metricType: "energy", transform: "d" }],
      ["energy", { point: delta, metricType: "energy", transform: null }],
    ]);
    const reading = (physicalPathTail: string, rawValue: unknown) => ({
      pointMetadata: { physicalPathTail },
      rawValue,
      intervalEndMs: 1234,
    });

    expect(toAgg5mInsert(reading("price", 42), targets)).toMatchObject({
      point: scalar,
      avg: 42,
      last: 42,
      delta: null,
      sampleCount: 1,
      errorCount: 0,
    });
    expect(toAgg5mInsert(reading("demand", 10), targets)).toMatchObject({
      point: counter,
      avg: null,
      last: 10,
      delta: null,
    });
    expect(toAgg5mInsert(reading("energy", 5), targets)).toMatchObject({
      point: delta,
      last: null,
      delta: 5,
    });
    expect(toAgg5mInsert(reading("price", "bad"), targets)).toMatchObject({
      avg: null,
      last: null,
      sampleCount: 0,
      errorCount: 1,
    });
    expect(toAgg5mInsert(reading("missing", 1), targets)).toBeNull();
  });

  it("groups latest PointId rows by their resolved legacy KV system", () => {
    const p1 = Point.generate();
    const p2 = Point.generate();
    const row = (point: typeof p1): ActivePointLatest => ({
      point,
      logicalPathStem: "source.grid",
      metricType: "power",
      metricUnit: "W",
      displayName: "Grid",
      value: 1,
      valueStr: null,
      measurementTimeMs: 1,
      receivedTimeMs: 2,
      sessionId: null,
      sessionLabel: null,
    });
    const address = (point: typeof p1, systemId: number): PointAddr => ({
      pointId: point,
      uuid: Point.toUuid(point),
      rid: 1 as never,
      systemId,
      index: 1,
    });
    const rows = [row(p1), row(p2)];
    const grouped = groupLatestByDevice(
      rows,
      new Map([
        [p1, address(p1, 7)],
        [p2, address(p2, 7)],
      ]),
    );
    expect(grouped.get(7)).toEqual(rows);
  });
});
