import { describe, expect, it } from "@jest/globals";
import { Point } from "@/lib/ids";
import {
  resolveSlotsFromData,
  type ResolutionBinding,
  type ResolutionCandidate,
} from "../resolution";
import { bindingShapeMatches } from "../slots";

function candidate(
  systemId: number,
  index: number,
  logicalPathStem: string,
  metricType: string,
  active = true,
): ResolutionCandidate {
  return {
    systemId,
    index,
    id: Point.generate(),
    logicalPathStem,
    metricType,
    active,
  };
}

function slot(
  points: ResolutionCandidate[],
  bindings: ResolutionBinding[],
  name: string,
  config: Parameters<typeof resolveSlotsFromData>[2] = null,
) {
  return resolveSlotsFromData(points, bindings, config).find(
    (result) => result.slot === name,
  )!;
}

describe("deterministic area information resolution", () => {
  it("uses the lowest-priority valid explicit binding", () => {
    const first = candidate(1, 1, "bidi.battery", "soc");
    const preferred = candidate(2, 1, "bidi.battery", "soc");
    const result = slot(
      [first, preferred],
      [
        {
          pointSystemId: 1,
          pointId: 1,
          role: "battery",
          metricType: "soc",
          priority: 5,
        },
        {
          pointSystemId: 2,
          pointId: 1,
          role: "battery",
          metricType: "soc",
          priority: 0,
        },
      ],
      "battery/soc",
    );
    expect(result).toMatchObject({
      mode: "explicit",
      available: true,
      producer: { kind: "point", id: preferred.id },
    });
  });

  it("ignores an explicit binding whose stored metric does not match its point", () => {
    const point = candidate(1, 1, "bidi.battery", "soc");
    expect(
      slot(
        [point],
        [
          {
            pointSystemId: 1,
            pointId: 1,
            role: "battery",
            metricType: "power",
            priority: 0,
          },
        ],
        "battery/soc",
      ),
    ).toMatchObject({
      mode: "auto",
      producer: { kind: "point", id: point.id },
    });
  });

  it("auto-connects exactly one candidate and reports an inactive producer", () => {
    const point = candidate(1, 1, "source.solar.local", "power", false);
    expect(slot([point], [], "solar/power")).toMatchObject({
      mode: "auto",
      available: false,
      reason: "inactive",
      producer: { kind: "point", id: point.id },
    });
  });

  it("reports multiple auto candidates as an ordered needs-choice state", () => {
    const a = candidate(1, 1, "bidi.grid", "power");
    const b = candidate(2, 1, "bidi.grid", "power");
    const result = slot([a, b], [], "grid/power");
    expect(result).toMatchObject({
      mode: "absent",
      available: false,
      reason: "ambiguous",
      producer: null,
    });
    expect(result.candidates).toEqual([a.id, b.id].sort());
  });

  it("does not hide automatic ambiguity behind a config fallback", () => {
    const a = candidate(1, 1, "grid.emissionsIntensity", "intensity");
    const b = candidate(2, 1, "grid.emissionsIntensity", "intensity");
    expect(
      slot([a, b], [], "grid/emissions-intensity", {
        batteryProvenance: {
          generatorSource: {
            emissionsIntensity: 900,
            pricePerKwh: 50,
            renewableFraction: 0,
          },
        },
      }),
    ).toMatchObject({ mode: "absent", reason: "ambiguous" });
  });

  it("falls back to validated area config only after point candidates", () => {
    const result = slot([], [], "grid/emissions-intensity", {
      batteryProvenance: {
        generatorSource: {
          emissionsIntensity: 900,
          pricePerKwh: 60,
          renewableFraction: 0,
        },
      },
    });
    expect(result).toEqual({
      slot: "grid/emissions-intensity",
      role: "grid",
      metricType: "emissions-intensity",
      mode: "config",
      available: true,
      producer: {
        kind: "config",
        key: "batteryProvenance.generatorSource.emissionsIntensity",
      },
    });
  });

  it("returns an explicit missing state when no producer exists", () => {
    expect(slot([], [], "battery/charge-energy")).toMatchObject({
      mode: "absent",
      available: false,
      reason: "missing",
      producer: null,
    });
  });
});

describe("binding shape validation", () => {
  it("accepts the point's actual role stem and metric, including area-level grid signals", () => {
    expect(
      bindingShapeMatches("solar", "energy", {
        logicalPathStem: "source.solar.remote",
        metricType: "energy",
      }),
    ).toBe(true);
    expect(
      bindingShapeMatches("grid", "intensity", {
        logicalPathStem: "grid.emissionsIntensity",
        metricType: "intensity",
      }),
    ).toBe(true);
  });

  it("rejects a wrong role or declared metric", () => {
    const point = {
      logicalPathStem: "bidi.battery",
      metricType: "soc",
    };
    expect(bindingShapeMatches("solar", "soc", point)).toBe(false);
    expect(bindingShapeMatches("battery", "power", point)).toBe(false);
  });
});
