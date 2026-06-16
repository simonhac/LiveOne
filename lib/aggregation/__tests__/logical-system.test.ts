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
jest.mock("@/lib/areas/sync", () => ({
  ensureIdentityArea: jest.fn(),
}));

import { isCompleteRoleSet, resolveLogicalSystem } from "../logical-system";
import { SystemsManager } from "@/lib/systems-manager";
import { PointManager } from "@/lib/point/point-manager";
import { getAreaForSystem } from "@/lib/areas/resolve";
import { ensureIdentityArea } from "@/lib/areas/sync";

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

describe("resolveLogicalSystem (Area is mandatory — P3-tail-1)", () => {
  const getSystem = jest.fn<(id: number) => Promise<unknown>>();
  const isAreasBackedSystem = jest.fn<(id: number) => Promise<boolean>>();
  const getActivePointsForSystem =
    jest.fn<(id: number, typedOnly: boolean) => Promise<unknown[]>>();

  beforeEach(() => {
    jest.clearAllMocks();
    (SystemsManager.getInstance as jest.MockedFunction<any>).mockReturnValue({
      getSystem,
      isAreasBackedSystem,
    });
    (PointManager.getInstance as jest.MockedFunction<any>).mockReturnValue({
      getActivePointsForSystem,
    });
    getSystem.mockResolvedValue({
      vendorType: "selectronic",
      timezoneOffsetMin: 600,
    });
    // Default: a real device (own point_info), not an areas-backed virtual system.
    isAreasBackedSystem.mockResolvedValue(false);
    getActivePointsForSystem.mockResolvedValue([
      fakePoint("source.solar.local", "Solar"),
      fakePoint("load.hws", "Hot Water"),
    ]);
  });

  it("returns a logical system carrying the resolved Area id", async () => {
    (getAreaForSystem as jest.MockedFunction<any>).mockResolvedValue({
      id: "area-uuid-1",
      kind: "identity",
    });
    const ls = await resolveLogicalSystem(1);
    expect(ls).not.toBeNull();
    expect(ls!.areaId).toBe("area-uuid-1");
    expect(ls!.id).toBe(1);
    expect(ls!.isComplete).toBe(true);
  });

  it("heals a missing identity Area for a physical system and uses the minted id", async () => {
    (getAreaForSystem as jest.MockedFunction<any>).mockResolvedValue(null);
    (ensureIdentityArea as jest.MockedFunction<any>).mockResolvedValue(
      "area-healed",
    );
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const ls = await resolveLogicalSystem(1);
    expect(ensureIdentityArea).toHaveBeenCalledTimes(1);
    expect(ls).not.toBeNull();
    expect(ls!.areaId).toBe("area-healed");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Healed missing identity Area for system 1"),
    );
    warnSpy.mockRestore();
  });

  it("does NOT fabricate an Area for an areas-backed system with no Area (genuine fault)", async () => {
    isAreasBackedSystem.mockResolvedValue(true);
    (getAreaForSystem as jest.MockedFunction<any>).mockResolvedValue(null);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const ls = await resolveLogicalSystem(1);
    expect(ls).toBeNull();
    expect(ensureIdentityArea).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Areas-backed system 1 has no Area"),
    );
    errSpy.mockRestore();
  });

  it("returns null when the heal itself fails", async () => {
    (getAreaForSystem as jest.MockedFunction<any>).mockResolvedValue(null);
    (ensureIdentityArea as jest.MockedFunction<any>).mockRejectedValue(
      new Error("db down"),
    );
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const ls = await resolveLogicalSystem(1);
    expect(ls).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("No Area for system 1"),
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it("returns null for a non-existent system without consulting Areas", async () => {
    getSystem.mockResolvedValue(null);
    const ls = await resolveLogicalSystem(999);
    expect(ls).toBeNull();
    expect(getAreaForSystem).not.toHaveBeenCalled();
  });
});
