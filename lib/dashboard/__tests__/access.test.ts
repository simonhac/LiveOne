import { describe, it, expect } from "@jest/globals";
import { toReadAccess } from "@/lib/dashboard/access";

describe("toReadAccess — dashboard read-scope shaping", () => {
  it("passes through a single system's points", () => {
    const out = toReadAccess([
      { systemId: 1, pointId: 0 },
      { systemId: 1, pointId: 5 },
    ]);
    expect(out.systemIds).toEqual([1]);
    expect(out.points).toEqual([
      { systemId: 1, pointId: 0 },
      { systemId: 1, pointId: 5 },
    ]);
  });

  it("dedups systemIds across a composite's child systems (preserves point order)", () => {
    const out = toReadAccess([
      { systemId: 5, pointId: 7 }, // Kinkora-style: battery soc on sys 5
      { systemId: 6, pointId: 9 }, // battery power on sys 6
      { systemId: 6, pointId: 13 }, // grid power on sys 6
      { systemId: 9, pointId: 1 }, // amber rate on sys 9
    ]);
    expect(out.systemIds).toEqual([5, 6, 9]);
    expect(out.points).toHaveLength(4);
  });

  it("returns empty for a dashboard with no resolvable points", () => {
    expect(toReadAccess([])).toEqual({ systemIds: [], points: [] });
  });
});
