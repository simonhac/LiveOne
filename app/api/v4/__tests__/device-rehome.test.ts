/**
 * ROUTE-level tests for `PATCH /api/v4/devices/{id}` — the device-side half of area membership.
 *
 * 🛑 The thing worth pinning here is that the handler asks TWO authorization questions, not one, and
 * refreshes TWO areas, not one. Both are easy to half-implement and neither failure raises:
 *
 *  1. Owning the device is not permission to put it in a stranger's area, and owning an area is not
 *     permission to take a stranger's device out of theirs. A handler that checked only the device
 *     would let anyone push a device into someone else's site and change what that site reports; one
 *     that checked only the destination would let an area owner harvest devices out of other sites.
 *  2. A move invalidates the SOURCE area's KV subscription registry and point-series cache just as
 *     much as the destination's. Refreshing only the destination leaves the old area serving latest
 *     values for a device it no longer holds — no error, nothing to grep for.
 *
 * Plus the no-op short-circuit: re-stating a device's current area must not run the binding delete.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Area, Device } from "@/lib/ids";

const AREA = Area.generate();
const AREA_UUID = Area.toUuid(AREA);
const OTHER_AREA = Area.generate();
const DEVICE = Device.generate();
const DEVICE_UUID = Device.toUuid(DEVICE);

jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/lib/registry/device-writer", () => ({
  DeviceWriter: { updateDevice: jest.fn() },
}));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { devicesVisibleByUser: jest.fn() },
}));
jest.mock("@/lib/capabilities/server", () => ({
  capabilitiesForDevice: jest.fn(),
}));
jest.mock("@/lib/areas/http", () => ({ loadAreaForAuth: jest.fn() }));
jest.mock("@/lib/areas/create", () => {
  class AreaValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AreaValidationError";
    }
  }
  class AreaAccessError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AreaAccessError";
    }
  }
  return {
    AreaValidationError,
    AreaAccessError,
    assertDevicesRehomable: jest.fn(),
    rehomeDevice: jest.fn(),
    refreshAreaServing: jest.fn(),
  };
});

import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { loadAreaForAuth } from "@/lib/areas/http";
import {
  assertDevicesRehomable,
  rehomeDevice,
  refreshAreaServing,
  AreaAccessError,
  AreaValidationError,
} from "@/lib/areas/create";
import { PATCH } from "../devices/[id]/route";
import { DeviceWriter } from "@/lib/registry/device-writer";

const mockAuth = jest.mocked(requireAuth);
const mockDb = jest.mocked(requirePlanetscaleDb);
const mockVisible = jest.mocked(DeviceConfigRegistry.devicesVisibleByUser);
const mockLoadArea = jest.mocked(loadAreaForAuth);
const mockRehomable = jest.mocked(assertDevicesRehomable);
const mockRehome = jest.mocked(rehomeDevice);
const mockRefresh = jest.mocked(refreshAreaServing);

/** A `select(...).from(...).where(...).limit(...)` chain that resolves to `rows`. */
function selectChain(rows: unknown[]) {
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then")
          return (...a: any[]) => Promise.resolve(rows).then(...(a as [any]));
        return () => chain;
      },
    },
  );
  return { select: () => chain };
}

const call = (body: unknown, id: string = DEVICE) =>
  PATCH(
    new NextRequest(`http://localhost/api/v4/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user_1", isAdmin: false } as any);
  mockDb.mockReturnValue(selectChain([{ rid: 7 }]) as any);
  mockVisible.mockResolvedValue([{ id: 7 }] as any);
  mockLoadArea.mockResolvedValue({
    id: AREA_UUID,
    ownerClerkUserId: "user_1",
  } as any);
  // What `assertDevicesRehomable` observed while authorizing — the state the write is scoped on.
  mockRehomable.mockResolvedValue(new Map([[DEVICE_UUID, null]]) as never);
  mockRehome.mockResolvedValue({
    fromAreaId: null,
    moved: true,
    conflicted: false,
  } as any);
});

describe("PATCH /api/v4/devices/{id}", () => {
  it.each([false, true])(
    "renames for an owner/admin without moving or changing area settings (admin=%s)",
    async (isAdmin) => {
      mockAuth.mockResolvedValue({
        userId: isAdmin ? "admin" : "user_1",
        isAdmin,
      } as any);
      mockDb.mockReturnValue(
        selectChain([{ rid: 7, name: "Old", ownerUserId: "user_1" }]) as any,
      );
      const res = await call({ name: " Amber CitiPower NMI 0123456789 " });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        name: "Amber CitiPower NMI 0123456789",
        previousName: "Old",
        renamed: true,
      });
      expect(DeviceWriter.updateDevice).toHaveBeenCalledWith(7, {
        displayName: "Amber CitiPower NMI 0123456789",
      });
      expect(mockRehome).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    },
  );

  it("does not give an area owner permission to rename someone else's device", async () => {
    mockDb.mockReturnValue(
      selectChain([{ rid: 7, name: "Old", ownerUserId: "other" }]) as any,
    );
    expect((await call({ name: "New" })).status).toBe(404);
    expect(DeviceWriter.updateDevice).not.toHaveBeenCalled();
    expect(mockRehomable).not.toHaveBeenCalled();
  });

  it.each([null, 42, "", "   ", "a".repeat(101)])(
    "refuses invalid name %p",
    async (name) => {
      expect((await call({ name })).status).toBe(422);
      expect(DeviceWriter.updateDevice).not.toHaveBeenCalled();
    },
  );

  it("rejects a combined rename and move without either write", async () => {
    expect((await call({ name: "New", areaId: AREA })).status).toBe(422);
    expect(DeviceWriter.updateDevice).not.toHaveBeenCalled();
    expect(mockRehome).not.toHaveBeenCalled();
  });

  it("reports an unchanged name without writing", async () => {
    mockDb.mockReturnValue(
      selectChain([{ rid: 7, name: "Same", ownerUserId: "user_1" }]) as any,
    );
    const res = await call({ name: "Same" });
    expect((await res.json()).renamed).toBe(false);
    expect(DeviceWriter.updateDevice).not.toHaveBeenCalled();
  });
  it("moves the device and refreshes serving at BOTH ends", async () => {
    const fromUuid = Area.toUuid(OTHER_AREA);
    mockRehome.mockResolvedValue({
      fromAreaId: fromUuid,
      moved: true,
      conflicted: false,
    } as any);
    const res = await call({ areaId: AREA });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: DEVICE,
      areaId: AREA,
      previousAreaId: OTHER_AREA,
      moved: true,
    });
    expect(mockRehome).toHaveBeenCalledWith(DEVICE, AREA_UUID, expect.any(Map));
    // 🛑 Both. The source area's subscriptions still name this device's points.
    expect(mockRefresh.mock.calls.map((c) => c[0]).sort()).toEqual(
      [fromUuid, AREA_UUID].sort(),
    );
  });

  it("unassigns on `areaId: null`, without authorizing a destination", async () => {
    mockRehome.mockResolvedValue({
      fromAreaId: AREA_UUID,
      moved: true,
      conflicted: false,
    } as any);
    const res = await call({ areaId: null });
    expect(res.status).toBe(200);
    expect(mockRehome).toHaveBeenCalledWith(DEVICE, null, expect.any(Map));
    // There is no destination to own, so the area load must not even be attempted.
    expect(mockLoadArea).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledWith(AREA_UUID);
  });

  it("🛑 refreshes NOTHING on a no-op move", async () => {
    mockRehome.mockResolvedValue({
      fromAreaId: AREA_UUID,
      moved: false,
    } as any);
    const res = await call({ areaId: AREA });
    expect(res.status).toBe(200);
    expect((await res.json()).moved).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("🛑 404s — not 403 — when the caller may not TAKE the device out of where it is", async () => {
    // The §8.4 collapse. Holding a well-formed `dv_` string is not permission to learn whether it
    // names anything, so "no such device" and "not yours to move" must be indistinguishable; a 403
    // would confirm the existence of any device a caller cared to guess at, and the message would
    // have echoed its integer handle while doing so.
    mockRehomable.mockRejectedValue(new AreaAccessError("No access"));
    const res = await call({ areaId: AREA });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Device not found" });
    expect(mockRehome).not.toHaveBeenCalled();
  });

  it("🛑 403s when the caller may not PUT it in the destination — owning the device is not enough", async () => {
    mockLoadArea.mockResolvedValue({
      id: AREA_UUID,
      ownerClerkUserId: "user_other",
    } as any);
    const res = await call({ areaId: AREA });
    expect(res.status).toBe(403);
    expect(mockRehome).not.toHaveBeenCalled();
  });

  it("collapses an UNKNOWN destination into the same 403 as an un-owned one", async () => {
    mockLoadArea.mockResolvedValue(null);
    expect((await call({ areaId: AREA })).status).toBe(403);
  });

  it("422s an AMBIENT device — a fact about the device, not an access decision", async () => {
    mockRehomable.mockRejectedValue(
      new AreaValidationError("Device 7 is ambient (no owner)"),
    );
    expect((await call({ areaId: AREA })).status).toBe(422);
  });

  it("🛑 422s a body with NO areaId key — absent is not 'unassign'", async () => {
    // The shape that would let a client bug silently orphan a device. This route has no other field
    // to patch, so `{}` can only be a mistake.
    const res = await call({});
    expect(res.status).toBe(422);
    expect(mockRehome).not.toHaveBeenCalled();
  });

  it("422s a non-string, non-null areaId and a malformed ar_ id", async () => {
    expect((await call({ areaId: 7 })).status).toBe(422);
    expect((await call({ areaId: "not-an-id" })).status).toBe(422);
  });

  it("400s a malformed device id, before any lookup", async () => {
    const res = await call({ areaId: AREA }, "nonsense");
    expect(res.status).toBe(400);
    expect(mockVisible).not.toHaveBeenCalled();
  });

  it("…and an unknown device id gets the SAME 404, byte for byte", async () => {
    mockDb.mockReturnValue(selectChain([]) as any);
    const res = await call({ areaId: AREA });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Device not found" });
  });

  it("🛑 does NOT gate on the picker's visible set", async () => {
    // `devicesVisibleByUser` is owned ∪ public ∪ granted, ACTIVE only — the wrong question for this
    // verb in three ways, each of which 404'd an entitled caller: an admin is not in it; an area
    // owner with CUSTODY of someone else's device is not in it (custody is precisely what the picker
    // cannot express); and a DISABLED device is filtered out, so a device could not be re-homed
    // exactly when you most want to tidy it away. `assertDevicesRehomable` is the whole
    // authorization. Found in review.
    mockVisible.mockResolvedValue([]);
    expect((await call({ areaId: AREA })).status).toBe(200);
  });

  it("propagates a 401 from requireAuth before reading anything", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "no" }, { status: 401 }) as any,
    );
    expect((await call({ areaId: AREA })).status).toBe(401);
    expect(mockVisible).not.toHaveBeenCalled();
  });
});
