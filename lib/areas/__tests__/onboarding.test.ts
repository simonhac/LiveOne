/**
 * Where a newly onboarded device is placed.
 *
 * This decides something that used to be structural — every device minted its own area because
 * `devices.primary_area_id` was NOT NULL — so the failure modes are all silent ones. Nothing here
 * throws when it gets the answer wrong: the device is created either way, polls either way, and the
 * cost shows up as a discarded site address, an area nobody asked for, or a device trapped in an
 * area nothing can move it out of.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const AREA_DEFAULT = "aaaaaaaa-0000-7000-8000-000000000001";
const AREA_NEW = "bbbbbbbb-0000-7000-8000-000000000002";
const AREA_OTHER = "cccccccc-0000-7000-8000-000000000003";

/**
 * Queued answers for the two reads, in call order: the default-area lookup, then the has-other-area
 * lookup. A queue rather than a table fake — the module asks two specific questions and the thing
 * worth pinning is what it does with each answer, not that drizzle composes.
 */
let reads: Array<Array<{ id: string }>> = [];
const upserts: Array<{ clerkUserId: string; defaultAreaId: string }> = [];

const chain = () => {
  const self: Record<string, unknown> = {};
  for (const k of ["from", "innerJoin", "where"]) self[k] = () => self;
  self.limit = async () => reads.shift() ?? [];
  return self;
};

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({
    select: () => chain(),
    insert: () => ({
      values: (v: { clerkUserId: string; defaultAreaId: string }) => ({
        onConflictDoUpdate: async () => {
          upserts.push(v);
        },
      }),
    }),
  }),
}));

const createArea = jest.fn(async (_input: unknown) => ({
  id: AREA_NEW,
  legacySystemId: 42,
  vacatedAreaIds: [] as string[],
}));
jest.mock("@/lib/areas/create", () => ({
  createArea: (...args: unknown[]) =>
    (createArea as (...a: unknown[]) => unknown)(...args),
}));

import { resolveOnboardingArea } from "../onboarding";

const SITE = {
  displayName: "Enphase System",
  timezoneOffsetMin: 600,
  displayTimezone: "Australia/Melbourne",
  location: { country: "AU", state: "VIC", postcode: "3130" },
};

beforeEach(() => {
  reads = [];
  upserts.length = 0;
  createArea.mockClear();
});

describe("resolveOnboardingArea", () => {
  it("reuses the owner's default area, and creates nothing", async () => {
    reads = [[{ id: AREA_DEFAULT }]];
    expect(await resolveOnboardingArea("user_1", SITE)).toEqual({
      areaId: AREA_DEFAULT,
      createdAreaId: null,
      recordedAsDefault: false,
    });
    // 🛑 The point of the column. A household's second inverter joins the first one's site instead
    // of minting a second — which is the proliferation the area-of-one retirement exists to end.
    expect(createArea).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
  });

  it("creates a site carrying the vendor's timezone and location when there is no default", async () => {
    reads = [[], []]; // no usable default; no other area
    const out = await resolveOnboardingArea("user_1", SITE);
    expect(out).toEqual({
      areaId: AREA_NEW,
      createdAreaId: AREA_NEW,
      recordedAsDefault: true,
    });
    // 🛑 The site address has to travel. It is the only moment the vendor offers it, and it is what
    // feeds the Enphase sun-times window and the NEM region — dropping it here is silent and
    // unrecoverable without the user re-entering it by hand.
    expect(createArea).toHaveBeenCalledWith({
      ownerClerkUserId: "user_1",
      displayName: "Enphase System",
      timezoneOffsetMin: 600,
      displayTimezone: "Australia/Melbourne",
      location: { country: "AU", state: "VIC", postcode: "3130" },
      memberSystemIds: [],
      authorized: new Map(),
    });
  });

  it("records a first area as the owner's default, so the column self-populates", async () => {
    reads = [[], []]; // no default; no other area
    await resolveOnboardingArea("user_1", SITE);
    expect(upserts).toEqual([
      { clerkUserId: "user_1", defaultAreaId: AREA_NEW },
    ]);
  });

  it("does NOT record a default when the owner already has another area", async () => {
    reads = [[], [{ id: AREA_OTHER }]]; // no usable default, but other areas exist
    const out = await resolveOnboardingArea("user_1", SITE);
    expect(out.recordedAsDefault).toBe(false);
    // A multi-site owner has no obvious default, and guessing one from whichever device they
    // happened to connect next is worse than leaving it blank: blank means "mint a site for this
    // connection", which is the pre-0073 behaviour and is never surprising.
    expect(upserts).toEqual([]);
    expect(out.areaId).toBe(AREA_NEW);
  });

  it("creates a fresh site when the recorded default is archived or re-owned", async () => {
    // The default lookup joins on `status = 'active'` AND owner, so an unusable default reads as
    // absent. It must not be used: placing a new device into an archived site makes it invisible
    // the moment it is created.
    reads = [[], [{ id: AREA_OTHER }]];
    const out = await resolveOnboardingArea("user_1", SITE);
    expect(out.areaId).toBe(AREA_NEW);
    expect(createArea).toHaveBeenCalled();
  });
});
