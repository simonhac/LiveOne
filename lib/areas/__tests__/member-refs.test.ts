/**
 * `resolveMemberDeviceRefs` — the `members: [dv_…]` seam every v4 area write goes through
 *.
 *
 * The point under test is the STATUS MAP, and it is a security decision rather than a formatting one:
 * a well-formed `dv_` id that names nothing and one that names a device the caller cannot see must be
 * indistinguishable (§8.4 no-escalation — otherwise this endpoint is an existence oracle over other
 * owners' devices), while a malformed id, which cannot name anything at all, is a body error.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

let rids: Map<string, number>;
let readableThrows: Error | null = null;

jest.mock("@/lib/registry", () => ({
  DeviceRegistry: { ridsForDevices: jest.fn(async () => rids) },
}));
jest.mock("@/lib/areas/create", () => {
  class AreaAccessError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AreaAccessError";
    }
  }
  class AreaValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AreaValidationError";
    }
  }
  return {
    AreaAccessError,
    AreaValidationError,
    assertMembersReadable: jest.fn(async () => {
      if (readableThrows) throw readableThrows;
    }),
  };
});
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/areas/list", () => ({ listReadableAreas: jest.fn() }));

import { Area, Device } from "@/lib/ids";
import { AreaAccessError, AreaValidationError } from "@/lib/areas/create";
import { resolveMemberDeviceRefs } from "../http";

const A = Device.encode("018f0000-0000-7000-8000-000000000001");
const B = Device.encode("018f0000-0000-7000-8000-000000000002");
const UNKNOWN = Device.encode("018f0000-0000-7000-8000-0000000000ff");

beforeEach(() => {
  rids = new Map([
    [A, 1],
    [B, 2],
  ]);
  readableThrows = null;
});

const run = (refs: unknown) => resolveMemberDeviceRefs("user_1", false, refs);

describe("resolveMemberDeviceRefs", () => {
  it("resolves an ordered list to handles, preserving ORDER (it becomes the ordinal)", async () => {
    await expect(run([B, A])).resolves.toEqual({
      ok: true,
      deviceIds: [B, A],
      systemIds: [2, 1],
    });
  });

  it.each([
    ["a non-array", { members: A }],
    ["an empty array", []],
    ["a non-string entry", [42]],
    ["a malformed TypeID", ["not-a-typeid"]],
    ["the WRONG TypeID prefix", [Area.generate()]],
    ["a duplicate", [A, A]],
  ])("422s %s", async (_label, refs) => {
    await expect(run(refs)).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it("🛑 403s an UNKNOWN device id — not 404, not 422", async () => {
    // A 404 here would confirm to any caller which `dv_` ids exist; the §8.4 collapse is the point.
    const r = await run([UNKNOWN]);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("…and an unreadable one gets the SAME 403, so the two are indistinguishable", async () => {
    readableThrows = new AreaAccessError("No access to system 2");
    const r = await run([B]);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("422s the firewall's own validation error (a handle with no device row)", async () => {
    readableThrows = new AreaValidationError("System 2 not found");
    await expect(run([B])).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it("rethrows anything the firewall raises that is neither (a 403 must mean what it says)", async () => {
    readableThrows = new Error("boom");
    await expect(run([A])).rejects.toThrow("boom");
  });
});
