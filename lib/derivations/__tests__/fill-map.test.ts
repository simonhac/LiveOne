import { describe, expect, it } from "@jest/globals";
import {
  FillMappingError,
  buildRunDetectorParams,
  mapRunPeriodToInterval,
  mapTrackerToDerivation,
  type LegacyRunPeriodRow,
  type LegacyTrackerRow,
} from "@/lib/derivations/fill-map";
import { deriveDerivationId } from "@/lib/derivations/ids";
import { mergeDetectConfig } from "@/lib/derivations/params";

const AREA = "0197c9e1-4d2a-7f3b-8c1d-2e6d41c07f95";
const SIGNAL_UID = "11111111-2222-5333-8444-555555555555";
const ENERGY_UID = "66666666-7777-5888-8999-aaaaaaaaaaaa";

const uids: Record<string, string> = {
  "1:0": SIGNAL_UID,
  "1:4": ENERGY_UID,
};
const pointUid = (systemId: number, index: number) =>
  uids[`${systemId}:${index}`] ?? null;

function tracker(over: Partial<LegacyTrackerRow> = {}): LegacyTrackerRow {
  return {
    id: "tracker-1",
    systemId: 1,
    role: "generator",
    displayName: "Generator",
    enabled: true,
    signalKind: "power-threshold",
    signalSystemId: 1,
    signalPointId: 0,
    lowerW: -50,
    upperW: null,
    hysteresisW: null,
    energySystemId: 1,
    energyPointId: 4,
    delayOnSeconds: null,
    delayOffSeconds: 120,
    detectorVersion: 1,
    createdAt: new Date("2025-09-01T00:00:00Z"),
    updatedAt: new Date("2025-09-02T00:00:00Z"),
    ...over,
  };
}

describe("deriveDerivationId", () => {
  it("is deterministic, so dev and prod mint the same id", () => {
    expect(deriveDerivationId(AREA, "run-detector", "generator")).toBe(
      deriveDerivationId(AREA, "run-detector", "generator"),
    );
  });

  it("separates kinds, roles and areas", () => {
    const base = deriveDerivationId(AREA, "run-detector", "generator");
    expect(deriveDerivationId(AREA, "hws-model", null)).not.toBe(base);
    expect(deriveDerivationId(AREA, "run-detector", "load")).not.toBe(base);
    expect(
      deriveDerivationId(
        "0197c9e1-4d2a-7f3b-8c1d-000000000000",
        "run-detector",
        "generator",
      ),
    ).not.toBe(base);
  });

  it("gives a role-less derivation a stable id", () => {
    expect(deriveDerivationId(AREA, "hws-model", null)).toBe(
      deriveDerivationId(AREA, "hws-model", null),
    );
  });

  it("mints a valid v5 uuid", () => {
    expect(deriveDerivationId(AREA, "hws-model", null)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("buildRunDetectorParams", () => {
  it("omits keys whose legacy column was NULL, so they still inherit the role default", () => {
    const params = buildRunDetectorParams(tracker());
    expect(params).toEqual({
      signalKind: "power-threshold",
      lowerW: -50,
      delayOffSeconds: 120,
    });
    expect("hysteresisW" in params).toBe(false);
    expect("delayOnSeconds" in params).toBe(false);
    expect("upperW" in params).toBe(false);
  });

  it("copies explicitly-configured values, including a zero that is not a NULL", () => {
    const params = buildRunDetectorParams(
      tracker({ hysteresisW: 0, delayOnSeconds: 0 }),
    );
    expect(params.hysteresisW).toBe(0);
    expect(params.delayOnSeconds).toBe(0);
  });

  it("round-trips through the read-side merge to the legacy effective config", () => {
    const t = tracker();
    // What resolve.ts will compute from the written params…
    const merged = mergeDetectConfig(buildRunDetectorParams(t), t.role);
    // …must equal what the old resolve.ts computed straight from the columns.
    expect(merged).toEqual({
      lowerW: -50,
      upperW: null,
      hysteresisW: 0, // generator default
      delayOnMs: 0, // generator default
      delayOffMs: 120_000, // explicit column
      boundaryMode: "edge",
    });
  });

  it("rejects a detector with no threshold at all", () => {
    expect(() =>
      buildRunDetectorParams(tracker({ lowerW: null, upperW: null })),
    ).toThrow(FillMappingError);
  });

  it("rejects an unsupported signal kind rather than silently mislabelling it", () => {
    expect(() =>
      buildRunDetectorParams(tracker({ signalKind: "state-machine" })),
    ).toThrow(FillMappingError);
  });
});

describe("mapTrackerToDerivation", () => {
  it("maps columns onto the derivation, resolving points to uuids", () => {
    const d = mapTrackerToDerivation(tracker(), AREA, pointUid);
    expect(d).toMatchObject({
      id: deriveDerivationId(AREA, "run-detector", "generator"),
      areaId: AREA,
      kind: "run-detector",
      role: "generator",
      name: "Generator",
      enabled: true,
      output: "intervals",
      outputPointId: null,
      sourcePoints: { signal: SIGNAL_UID, energy: ENERGY_UID },
      detectorVersion: 1,
    });
    expect(d.createdAt).toEqual(new Date("2025-09-01T00:00:00Z"));
  });

  it("carries a null energy point through as null", () => {
    const d = mapTrackerToDerivation(
      tracker({ energySystemId: null, energyPointId: null }),
      AREA,
      pointUid,
    );
    expect(d.sourcePoints.energy).toBeNull();
  });

  it("refuses when a source point has no uuid rather than writing a dangling ref", () => {
    expect(() =>
      mapTrackerToDerivation(tracker({ signalPointId: 99 }), AREA, pointUid),
    ).toThrow(FillMappingError);
    expect(() =>
      mapTrackerToDerivation(tracker({ energyPointId: 99 }), AREA, pointUid),
    ).toThrow(FillMappingError);
  });
});

describe("mapRunPeriodToInterval", () => {
  const period: LegacyRunPeriodRow = {
    systemId: 1,
    role: "generator",
    startTime: new Date("2026-01-01T10:00:00Z"),
    endTime: new Date("2026-01-01T11:30:00Z"),
    durationSeconds: 5400,
    energyKwh: 3.219,
    maxPowerW: -120.5,
    minPowerW: -3580.25,
    avgPowerW: -2145.75,
    sampleCount: 90,
    detectorVersion: 1,
    createdAt: new Date("2026-01-01T11:31:00Z"),
    updatedAt: new Date("2026-01-01T11:32:00Z"),
  };

  it("copies every stat column verbatim under the new key", () => {
    expect(mapRunPeriodToInterval(period, "deriv-1")).toEqual({
      derivationId: "deriv-1",
      startTime: period.startTime,
      endTime: period.endTime,
      durationSeconds: 5400,
      energyKwh: 3.219,
      maxPowerW: -120.5,
      minPowerW: -3580.25,
      avgPowerW: -2145.75,
      sampleCount: 90,
      detectorVersion: 1,
      createdAt: period.createdAt,
      updatedAt: period.updatedAt,
    });
  });

  it("preserves an open interval's NULLs", () => {
    const open = mapRunPeriodToInterval(
      { ...period, endTime: null, durationSeconds: null, energyKwh: null },
      "deriv-1",
    );
    expect(open.endTime).toBeNull();
    expect(open.durationSeconds).toBeNull();
    expect(open.energyKwh).toBeNull();
  });
});
