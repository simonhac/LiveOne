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

type FakeDevice = {
  uuid: string;
  ownerClerkUserId: string | null;
  areaId: string | null;
  vendorType?: string;
};

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
    [1, { uuid: "dev-1", ownerClerkUserId: ME, areaId: "area-mine" }],
    [2, { uuid: "dev-2", ownerClerkUserId: THEM, areaId: "area-theirs" }],
    [3, { uuid: "dev-3", ownerClerkUserId: THEM, areaId: "area-mine" }],
    // an OpenElectricity NEM region
    [4, { uuid: "dev-4", ownerClerkUserId: null, areaId: null }],
    // an area's own derived output — owned, readable, in an area I own, and still not movable
    [
      5,
      {
        uuid: "dev-5",
        ownerClerkUserId: ME,
        areaId: "area-mine",
        vendorType: "helper",
      },
    ],
  ]);
});

const run = (rids: number[], isAdmin = false) =>
  assertDevicesRehomable(ME, isAdmin, rids);

describe("assertDevicesRehomable", () => {
  it("allows a device you own, and REPORTS where it saw it", async () => {
    // 🛑 The returned map is the authorization carried forward: every move is scoped on it, so the
    // decision and the write are about the same state. Returning nothing is what let a custody claim
    // authorized against area A be applied to a device that had since moved to B.
    await expect(run([1])).resolves.toEqual(new Map([["dev-1", "area-mine"]]));
  });

  it("allows admin anything with an owner", async () => {
    await expect(run([1, 2, 3], true)).resolves.toEqual(
      new Map([
        ["dev-1", "area-mine"],
        ["dev-2", "area-theirs"],
        ["dev-3", "area-mine"],
      ]),
    );
  });

  it("🛑 REFUSES someone else's device sitting in someone else's area", async () => {
    // The escalation the old read-based rule permitted: device 2 is public/readable as far as this
    // check was concerned, and taking it would have emptied `area-theirs` of it.
    await expect(run([2])).rejects.toBeInstanceOf(AreaAccessError);
  });

  it("allows someone else's device that is in an area YOU own — custody, not ownership", async () => {
    // Craig's devices sit in Craig Unified; its owner must be able to move them between their own
    // areas without owning each device. It is leaving a place they are already responsible for.
    await expect(run([3])).resolves.toEqual(new Map([["dev-3", "area-mine"]]));
  });

  it("🛑 REFUSES an AMBIENT device outright, for every caller including admin", async () => {
    // An ownerless device is Home Assistant's `entry_type=SERVICE` — an OpenElectricity NEM region.
    // Consumers reference it by id; no area contains it. Admission by READability is exactly how the
    // two OE regions ended up as members of three areas each before migration 0071.
    await expect(run([4])).rejects.toBeInstanceOf(AreaValidationError);
    await expect(run([4], true)).rejects.toBeInstanceOf(AreaValidationError);
  });

  it("🛑 REFUSES a HELPER outright, for every caller including admin", async () => {
    // A helper is the area's own computed output, and `helperSiteId(areaId)` bakes that area into
    // its `vendor_site_id` permanently. Adopting one elsewhere makes the adopting area's resolver
    // union another site's blend points — and hides the helper from `ensureHelperDevice`'s lookup,
    // so the next provenance recompute tries to mint a second one and 500s on
    // `devices_helper_area_unique`. Note this device passes every other leg: owned by the caller,
    // and sitting in an area the caller owns.
    await expect(run([5])).rejects.toBeInstanceOf(AreaValidationError);
    await expect(run([5], true)).rejects.toBeInstanceOf(AreaValidationError);
  });

  it("refuses the whole set if any one member fails", async () => {
    await expect(run([1, 2])).rejects.toBeInstanceOf(AreaAccessError);
  });

  it("422s a handle with no device row (not a 403 — it is a body error)", async () => {
    await expect(run([99])).rejects.toBeInstanceOf(AreaValidationError);
  });
});
