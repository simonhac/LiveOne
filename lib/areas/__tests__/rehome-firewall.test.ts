/**
 * `assertDevicesRehomable` — the no-escalation firewall on area membership.
 *
 * 🛑 This is the one genuinely NEW security surface in the device→0..1-area change, and the reason it
 * is new is worth stating rather than implying. While membership was additive (`area_members`), "the
 * caller can READ this device" was a sufficient admission rule: naming your device in my area let me
 * aggregate data I could already see, and your area kept it too. With `devices.area_id` a device is in
 * 0 or 1 area, so naming it TAKES IT OUT — and a read-shaped permission would let anyone who can see a
 * device silently remove it from someone else's site, deleting that site's bindings on the way out.
 *
 * So the tests below are about the DIFFERENCE between the two rules, not about the parts they share.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

type FakeDevice = { ownerClerkUserId: string | null; areaId: string | null };

let fleet: Map<number, FakeDevice>;
let areaOwners: Map<string, string | null>;

jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: jest.fn(async (rid: number) => fleet.get(rid) ?? null),
  },
}));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({
    select: () => ({
      from: () => ({
        where: (pred: { areaId?: string }) => ({
          limit: async () => {
            const owner = areaOwners.get(pred.areaId ?? "");
            return owner === undefined ? [] : [{ ownerUserId: owner }];
          },
        }),
      }),
    }),
  }),
}));
// The `eq(areas.id, areaId)` the DAO builds is opaque here, so stand it up as the predicate the fake
// `where` above reads — the test is about the DECISION, not about drizzle's builder.
jest.mock("drizzle-orm", () => ({
  ...(jest.requireActual("drizzle-orm") as object),
  eq: (_col: unknown, areaId: string) => ({ areaId }),
}));

import {
  assertDevicesRehomable,
  AreaAccessError,
  AreaValidationError,
} from "../create";

const ME = "user_me";
const THEM = "user_them";

beforeEach(() => {
  areaOwners = new Map([
    ["area-mine", ME],
    ["area-theirs", THEM],
  ]);
  fleet = new Map<number, FakeDevice>([
    [1, { ownerClerkUserId: ME, areaId: "area-mine" }],
    [2, { ownerClerkUserId: THEM, areaId: "area-theirs" }],
    [3, { ownerClerkUserId: THEM, areaId: "area-mine" }],
    [4, { ownerClerkUserId: null, areaId: null }], // an OpenElectricity NEM region
  ]);
});

const run = (rids: number[], isAdmin = false) =>
  assertDevicesRehomable(ME, isAdmin, rids);

describe("assertDevicesRehomable", () => {
  it("allows a device you own", async () => {
    await expect(run([1])).resolves.toBeUndefined();
  });

  it("allows admin anything with an owner", async () => {
    await expect(run([1, 2, 3], true)).resolves.toBeUndefined();
  });

  it("🛑 REFUSES someone else's device sitting in someone else's area", async () => {
    // The escalation the old read-based rule permitted: device 2 is public/readable as far as this
    // check was concerned, and taking it would have emptied `area-theirs` of it.
    await expect(run([2])).rejects.toBeInstanceOf(AreaAccessError);
  });

  it("allows someone else's device that is in an area YOU own — custody, not ownership", async () => {
    // Craig's devices sit in Craig Unified; its owner must be able to move them between their own
    // areas without owning each device. It is leaving a place they are already responsible for.
    await expect(run([3])).resolves.toBeUndefined();
  });

  it("🛑 REFUSES an AMBIENT device outright, for every caller including admin", async () => {
    // An ownerless device is Home Assistant's `entry_type=SERVICE` — an OpenElectricity NEM region.
    // Consumers reference it by id; no area contains it. Admission by READability is exactly how the
    // two OE regions ended up as members of three areas each before migration 0071.
    await expect(run([4])).rejects.toBeInstanceOf(AreaValidationError);
    await expect(run([4], true)).rejects.toBeInstanceOf(AreaValidationError);
  });

  it("refuses the whole set if any one member fails", async () => {
    await expect(run([1, 2])).rejects.toBeInstanceOf(AreaAccessError);
  });

  it("422s a handle with no device row (not a 403 — it is a body error)", async () => {
    await expect(run([99])).rejects.toBeInstanceOf(AreaValidationError);
  });
});
