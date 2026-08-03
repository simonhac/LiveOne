/**
 * `requireDeviceAccess`'s two write gates, side by side.
 *
 *   `{requireWrite:true}`  — CONFIG writes. Owner **or** admin. Deliberately UNCHANGED: admins
 *                            administer other people's devices (settings, credentials, metadata).
 *   `{requireOwner:true}`  — CONTROL. Owner ONLY. A non-owner admin is refused 403, and an
 *                            ownerless device is commandable by nobody.
 *
 * The last describe block is the no-leak proof: the same admin, same device, is still allowed
 * through the write gate. If the narrowing had been done by dropping `isAdmin` from `canWrite`
 * (the change this PR deliberately did NOT make), it would go red.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: null as string | null })),
}));
jest.mock("@/lib/auth-utils", () => ({
  isUserAdmin: jest.fn(async () => false),
}));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: jest.fn(),
    areaByHandle: jest.fn(),
  },
}));

import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { requireDeviceAccess } from "@/lib/api-auth";

const mockClerk = jest.mocked(auth) as unknown as jest.Mock;
const mockIsAdmin = jest.mocked(isUserAdmin);
const mockDevice = jest.mocked(DeviceConfigRegistry.deviceByHandle);

/** Sign in (or not) as `userId`, optionally as a platform admin. */
function signIn(userId: string | null, admin = false) {
  mockClerk.mockImplementation(async () => ({ userId }));
  mockIsAdmin.mockImplementation(async () => admin);
}

/** The device under test — owned by `user_owner`, or ownerless when `owner` is null. */
function device(owner: string | null) {
  mockDevice.mockResolvedValue({
    id: 10,
    ownerClerkUserId: owner,
    vendorType: "tesla",
    displayName: "Tez",
    timezoneOffsetMin: 600,
  } as unknown as Awaited<
    ReturnType<typeof DeviceConfigRegistry.deviceByHandle>
  >);
}

function req(): NextRequest {
  return {
    url: "http://localhost/api/v4/points/pt_x/action",
    method: "POST",
    headers: new Headers(),
  } as unknown as NextRequest;
}

async function status(options: {
  requireWrite?: boolean;
  requireOwner?: boolean;
}): Promise<number | "allowed"> {
  const res = await requireDeviceAccess(req(), 10, options);
  return res instanceof NextResponse ? res.status : "allowed";
}

beforeEach(() => {
  jest.clearAllMocks();
  device("user_owner");
  signIn(null);
});

describe("requireOwner — the control gate", () => {
  it("the OWNER may command", async () => {
    signIn("user_owner");
    expect(await status({ requireWrite: true, requireOwner: true })).toBe(
      "allowed",
    );
  });

  it("🛑 a non-owner ADMIN is REFUSED 403", async () => {
    signIn("user_admin", true);
    const res = await requireDeviceAccess(req(), 10, {
      requireWrite: true,
      requireOwner: true,
    });
    expect(res).toBeInstanceOf(NextResponse);
    if (!(res instanceof NextResponse)) throw new Error("unreachable");
    // 403, not 404: the caller may legitimately READ this device; we are refusing the command,
    // not hiding the device.
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only the device owner can control this device",
    );
  });

  it("an admin who DOES own the device may command (admin-ness is simply irrelevant)", async () => {
    signIn("user_owner", true);
    expect(await status({ requireWrite: true, requireOwner: true })).toBe(
      "allowed",
    );
  });

  it("a signed-in stranger is refused", async () => {
    signIn("user_stranger");
    // Refused at the write gate already — pinned so the two gates' order can't quietly change
    // this case into a 200.
    expect(await status({ requireWrite: true, requireOwner: true })).toBe(403);
  });

  describe("🛑 an OWNERLESS device is commandable by NOBODY (the null === null trap)", () => {
    beforeEach(() => device(null));

    it("not by an anonymous caller — `userId === ownerClerkUserId` is null === null", async () => {
      signIn(null);
      expect(await status({ requireWrite: true, requireOwner: true })).toBe(
        403,
      );
    });

    it("not by a signed-in user", async () => {
      signIn("user_someone");
      expect(await status({ requireWrite: true, requireOwner: true })).toBe(
        403,
      );
    });

    it("not by an admin", async () => {
      signIn("user_admin", true);
      expect(await status({ requireWrite: true, requireOwner: true })).toBe(
        403,
      );
    });
  });
});

describe("the CONFIG write gate is unchanged (the narrowing did not leak)", () => {
  it("a non-owner ADMIN still passes {requireWrite:true} — device settings/credentials/metadata", async () => {
    signIn("user_admin", true);
    const res = await requireDeviceAccess(req(), 10, { requireWrite: true });
    expect(res).not.toBeInstanceOf(NextResponse);
    if (res instanceof NextResponse) throw new Error("unreachable");
    expect(res.canWrite).toBe(true);
  });

  it("an anonymous caller on an OWNERLESS device still gets the pre-existing canWrite quirk", async () => {
    // Pinned, not blessed — `lib/__tests__/api-auth.test.ts` pins the same thing on the dashboard
    // helper. The control gate no longer depends on it, which is the point.
    device(null);
    signIn(null);
    const res = await requireDeviceAccess(req(), 10, { requireWrite: true });
    expect(res).not.toBeInstanceOf(NextResponse);
    if (res instanceof NextResponse) throw new Error("unreachable");
    expect(res.canWrite).toBe(true);
  });

  it("a signed-in stranger still cannot write", async () => {
    signIn("user_stranger");
    expect(await status({ requireWrite: true })).toBe(403);
  });
});
