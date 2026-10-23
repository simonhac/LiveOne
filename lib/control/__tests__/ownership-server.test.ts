/**
 * `viewerControlFields` — the two viewer-relative fields the dashboard's SSR seed stamps onto a
 * payload that was built without a viewer.
 *
 * 🛑 What these cases protect is the CONTROL COG ON FIRST PAINT. The seed used to carry neither
 * field, the client reads absent as false, and so every cog was missing until the first client
 * refetch replaced the seed (up to `staleTime`, 25 s). The two fail-closed cases matter just as
 * much: an anonymous/shared view must come back `false` / `[]`, because the seed is written into
 * hydration JSON that ships to the browser.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle: jest.fn() },
}));

// The `control`-grant leg of the control rule: a DB read, stubbed per case (empty by default).
jest.mock("@/lib/dashboard/grants", () => ({
  controllableDeviceScopeForUser: jest.fn(async () => new Set<number>()),
}));

import { viewerControlFields } from "@/lib/control/ownership-server";
import { controllableDeviceScopeForUser } from "@/lib/dashboard/grants";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

/** Device 14 is the generator controller (owned by `user_owner`); 21 is somebody else's. */
const OWNERS: Record<number, string | null> = {
  14: "user_owner",
  21: "user_other",
  99: null, // ownerless — commandable by nobody
};

const mockByHandle = DeviceConfigRegistry.deviceByHandle as jest.MockedFunction<
  (handle: number) => Promise<{ ownerClerkUserId: string | null } | null>
>;

/** An AREA payload owned by `user_owner`, carrying points from three different devices. */
const AREA_PAYLOAD = {
  area: { ownerClerkUserId: "user_owner" },
  latest: {
    "source.generator.control.request/duration": { sourceSystemId: 14 },
    "source.solar/power": { sourceSystemId: 21 },
    "bidi.grid/power": { sourceSystemId: 99 },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(controllableDeviceScopeForUser).mockResolvedValue(new Set());
  mockByHandle.mockImplementation(async (handle: number) =>
    handle in OWNERS ? { ownerClerkUserId: OWNERS[handle] } : null,
  );
});

describe("viewerControlFields", () => {
  it("a. the owner gets canControl, and only the devices they actually own", async () => {
    const fields = await viewerControlFields(AREA_PAYLOAD, "user_owner");
    expect(fields.canControl).toBe(true);
    expect(fields.canControlDevices).toEqual([14]);
  });

  it("b. an anonymous/shared viewer gets nothing — no registry lookup at all", async () => {
    const fields = await viewerControlFields(AREA_PAYLOAD, null);
    expect(fields).toEqual({ canControl: false, canControlDevices: [] });
    expect(mockByHandle).not.toHaveBeenCalled();
  });

  it("c. a signed-in NON-owner of the subject still gets the member devices they own", async () => {
    // The mirror of the case the per-device leg exists for: the subject-level answer is false, but
    // a viewer who owns a member device may still command THAT device.
    const fields = await viewerControlFields(AREA_PAYLOAD, "user_other");
    expect(fields.canControl).toBe(false);
    expect(fields.canControlDevices).toEqual([21]);
  });

  it("🛑 d. an OWNERLESS device is commandable by nobody", async () => {
    // `ownsSubject` refuses two nulls, so an anonymous caller cannot compare `null === null` into
    // ownership of an ownerless subject.
    const fields = await viewerControlFields(
      { area: { ownerClerkUserId: null }, latest: AREA_PAYLOAD.latest },
      "user_owner",
    );
    expect(fields.canControl).toBe(false);
    expect(fields.canControlDevices).toEqual([14]);
  });

  it("e. a DEVICE payload reads its owner off the `device` block", async () => {
    const fields = await viewerControlFields(
      {
        device: { ownerClerkUserId: "user_owner" },
        latest: { "ev.battery/soc": { sourceSystemId: 14 } },
      },
      "user_owner",
    );
    expect(fields).toEqual({ canControl: true, canControlDevices: [14] });
  });

  it("f. an empty latest map is not an error", async () => {
    const fields = await viewerControlFields(
      { area: { ownerClerkUserId: "user_owner" } },
      "user_owner",
    );
    expect(fields).toEqual({ canControl: true, canControlDevices: [] });
  });

  it("g. a `control` grantee gets the devices their grant delegates — but not the AREA subject", async () => {
    jest
      .mocked(controllableDeviceScopeForUser)
      .mockResolvedValue(new Set([14]));
    const fields = await viewerControlFields(AREA_PAYLOAD, "user_grantee");
    // An area is never commanded itself, so the subject-level answer stays the area owner's.
    expect(fields).toEqual({ canControl: false, canControlDevices: [14] });
    // Resolved once per payload, not once per device.
    expect(controllableDeviceScopeForUser).toHaveBeenCalledTimes(1);
  });

  it("h. …and on a DEVICE subject the grant makes the subject controllable too", async () => {
    jest
      .mocked(controllableDeviceScopeForUser)
      .mockResolvedValue(new Set([14]));
    const fields = await viewerControlFields(
      {
        device: { id: 14, ownerClerkUserId: "user_owner" },
        latest: { "ev.battery/soc": { sourceSystemId: 14 } },
      },
      "user_grantee",
    );
    expect(fields).toEqual({ canControl: true, canControlDevices: [14] });
  });

  it("🛑 i. a grant scope naming an OWNERLESS device still commands nothing", async () => {
    jest
      .mocked(controllableDeviceScopeForUser)
      .mockResolvedValue(new Set([99]));
    const fields = await viewerControlFields(AREA_PAYLOAD, "user_grantee");
    expect(fields.canControlDevices).toEqual([]);
  });
});
