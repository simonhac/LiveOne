import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// resolveLogicalSystem fans out to the systems cache, the point manager, and the Areas resolver —
// mock all three so we can drive the loud-skip / null-area guard deterministically.
jest.mock("@/lib/systems-manager", () => ({
  SystemsManager: { getInstance: jest.fn() },
}));
jest.mock("@/lib/point/point-manager", () => ({
  PointManager: { getInstance: jest.fn() },
}));
jest.mock("@/lib/areas/resolve", () => ({
  getAreaForSystem: jest.fn(),
}));
jest.mock("@/lib/areas/devices", () => ({
  listFlowEligibleAreaHandles: jest.fn(),
}));

import {
  isCompleteRoleSet,
  resolveLogicalSystem,
  listCompleteLogicalSystems,
} from "../logical-system";
import { SystemsManager } from "@/lib/systems-manager";
import { PointManager } from "@/lib/point/point-manager";
import { getAreaForSystem } from "@/lib/areas/resolve";
import { listFlowEligibleAreaHandles } from "@/lib/areas/devices";

describe("isCompleteRoleSet", () => {
  it("is complete when there is a source and a load role", () => {
    expect(isCompleteRoleSet(["source.solar", "load"])).toBe(true);
    expect(isCompleteRoleSet(["source.solar.local", "load.hws"])).toBe(true);
  });

  it("treats battery/grid as both a source and a load (they split)", () => {
    expect(isCompleteRoleSet(["bidi.battery"])).toBe(true);
    expect(isCompleteRoleSet(["bidi.grid"])).toBe(true);
  });

  it("is incomplete with only generation (e.g. a solar-only override feed)", () => {
    expect(isCompleteRoleSet(["source.solar"])).toBe(false);
    expect(
      isCompleteRoleSet(["source.solar.local", "source.solar.remote"]),
    ).toBe(false);
  });

  it("is incomplete with only loads", () => {
    expect(isCompleteRoleSet(["load", "load.hws"])).toBe(false);
  });

  it("is incomplete with no role-bearing stems", () => {
    expect(isCompleteRoleSet([])).toBe(false);
    expect(isCompleteRoleSet(["unknown.thing"])).toBe(false);
  });
});

function fakePoint(stem: string, name: string) {
  return {
    metricType: "power",
    logicalPathStem: stem,
    metricUnit: "W",
    transform: null,
    name,
    getReference: () => ({ systemId: 1, pointId: 0 }),
  };
}

describe("resolveLogicalSystem (Area is mandatory — flow is area-only)", () => {
  // resolveLogicalSystem resolves the viewable system (real OR multi-device area handle) via
  // getViewableSystem, then the points, then the mandatory Area. Areas are EXPLICIT now — a system
  // with no Area returns null (never minted here); flow belongs only to Areas.
  const getViewableSystem = jest.fn<(id: number) => Promise<unknown>>();
  const getActivePointsForSystem =
    jest.fn<(id: number, typedOnly: boolean) => Promise<unknown[]>>();

  beforeEach(() => {
    jest.clearAllMocks();
    (SystemsManager.getInstance as jest.MockedFunction<any>).mockReturnValue({
      getViewableSystem,
    });
    (PointManager.getInstance as jest.MockedFunction<any>).mockReturnValue({
      getActivePointsForSystem,
    });
    getViewableSystem.mockResolvedValue({
      vendorType: "selectronic",
      timezoneOffsetMin: 600,
    });
    getActivePointsForSystem.mockResolvedValue([
      fakePoint("source.solar.local", "Solar"),
      fakePoint("load.hws", "Hot Water"),
    ]);
  });

  it("returns a logical system carrying the resolved Area id", async () => {
    (getAreaForSystem as jest.MockedFunction<any>).mockResolvedValue({
      id: "area-uuid-1",
    });
    const ls = await resolveLogicalSystem(1);
    expect(ls).not.toBeNull();
    expect(ls!.areaId).toBe("area-uuid-1");
    expect(ls!.id).toBe(1);
    expect(ls!.isComplete).toBe(true);
  });

  it("returns null for a COMPLETE system with no Area (never mints one — flow is area-only)", async () => {
    // A complete role set used to lazy-heal an area-of-one; now a system with no Area simply has no
    // flow view. Devices get a flow matrix only once grouped into an explicit Area.
    (getAreaForSystem as jest.MockedFunction<any>).mockResolvedValue(null);
    const ls = await resolveLogicalSystem(1);
    expect(ls).toBeNull();
  });

  it("returns null for an INCOMPLETE system with no Area", async () => {
    getActivePointsForSystem.mockResolvedValue([
      fakePoint("source.solar", "Solar"),
    ]);
    (getAreaForSystem as jest.MockedFunction<any>).mockResolvedValue(null);
    const ls = await resolveLogicalSystem(1);
    expect(ls).toBeNull();
  });

  it("returns null for a non-existent system without consulting Areas", async () => {
    getViewableSystem.mockResolvedValue(null);
    const ls = await resolveLogicalSystem(999);
    expect(ls).toBeNull();
    expect(getAreaForSystem).not.toHaveBeenCalled();
  });
});

describe("listCompleteLogicalSystems (area-only, driven off flow-eligible handles)", () => {
  const getViewableSystem = jest.fn<(id: number) => Promise<unknown>>();
  const getActivePointsForSystem =
    jest.fn<(id: number, typedOnly: boolean) => Promise<unknown[]>>();

  beforeEach(() => {
    jest.clearAllMocks();
    (SystemsManager.getInstance as jest.MockedFunction<any>).mockReturnValue({
      getViewableSystem,
    });
    (PointManager.getInstance as jest.MockedFunction<any>).mockReturnValue({
      getActivePointsForSystem,
    });
    getViewableSystem.mockResolvedValue({
      vendorType: "x",
      timezoneOffsetMin: 600,
    });
  });

  it("enumerates flow-eligible Area handles, dropping ones with no Area or an incomplete role set", async () => {
    // 7 → complete + has Area (kept); 8 → complete but no Area (dropped); 9 → incomplete (dropped).
    (listFlowEligibleAreaHandles as jest.MockedFunction<any>).mockResolvedValue(
      [7, 8, 9],
    );
    getActivePointsForSystem.mockImplementation(async (id: number) =>
      id === 9
        ? [fakePoint("source.solar", "Solar")]
        : [
            fakePoint("source.solar.local", "Solar"),
            fakePoint("load.hws", "HW"),
          ],
    );
    (getAreaForSystem as jest.MockedFunction<any>).mockImplementation(
      async (id: number) => (id === 8 ? null : { id: `area-${id}` }),
    );

    const list = await listCompleteLogicalSystems();
    expect(list.map((l) => l.id)).toEqual([7]);
    // Never enumerates raw systems: only the flow-eligible handles are consulted.
    expect(listFlowEligibleAreaHandles).toHaveBeenCalledTimes(1);
  });
});
