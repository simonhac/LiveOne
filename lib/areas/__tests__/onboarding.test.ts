/**
 * Where a newly onboarded device is placed.
 *
 * This decides something that used to be structural — every device minted its own area because
 * `devices.primary_area_id` was NOT NULL — so the failure modes are all silent ones. Nothing here
 * throws when it gets the answer wrong: the device is created either way, polls either way, and the
 * cost shows up as a discarded site address, an area nobody asked for, a device in somebody else's
 * site, or a user who can never acquire a default at all.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const OWNER = "user_1";
const AREA_DEFAULT = "aaaaaaaa-0000-7000-8000-000000000001";
const AREA_NEW = "bbbbbbbb-0000-7000-8000-000000000002";
const AREA_OTHER = "cccccccc-0000-7000-8000-000000000003";

/** One row of the `users ⟕ areas` read, or `null` for "this user has no `users` row". */
type DefaultRow = {
  recorded: string | null;
  areaId: string | null;
  areaOwner: string | null;
  areaStatus: string | null;
  location: unknown;
} | null;

let defaultRow: DefaultRow = null;
/** What `hasAnyArea` finds. Only consulted when there is no RECORDED default. */
let otherAreas: Array<{ id: string }> = [];
/** Whether the guarded upsert's `setWhere` matches — i.e. whether this writer wins the race. */
let defaultWriteApplies = true;

const upserts: Array<{ clerkUserId: string; defaultAreaId: string }> = [];
const upsertOpts: Array<Record<string, unknown>> = [];
const locationFills: Array<unknown> = [];

/**
 * Two shapes of read, told apart by whether a join was used: the default lookup LEFT JOINs `areas`
 * onto `users`, `hasAnyArea` selects from `areas` alone.
 */
const chain = () => {
  let joined = false;
  const self: Record<string, unknown> = {};
  self.from = () => self;
  self.leftJoin = () => {
    joined = true;
    return self;
  };
  self.where = () => self;
  self.limit = async () =>
    joined ? (defaultRow ? [defaultRow] : []) : otherAreas;
  return self;
};

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({
    select: () => chain(),
    update: () => ({
      set: (v: { location?: unknown }) => ({
        where: async () => {
          locationFills.push(v.location);
        },
      }),
    }),
    insert: () => ({
      values: (v: { clerkUserId: string; defaultAreaId: string }) => ({
        onConflictDoUpdate: (opts: Record<string, unknown>) => ({
          returning: async () => {
            upserts.push(v);
            upsertOpts.push(opts);
            return defaultWriteApplies ? [{ id: v.clerkUserId }] : [];
          },
        }),
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

/** A usable default: recorded, active, this owner's. */
const usable = (location: unknown): DefaultRow => ({
  recorded: AREA_DEFAULT,
  areaId: AREA_DEFAULT,
  areaOwner: OWNER,
  areaStatus: "active",
  location,
});

beforeEach(() => {
  defaultRow = null;
  otherAreas = [];
  defaultWriteApplies = true;
  upserts.length = 0;
  upsertOpts.length = 0;
  locationFills.length = 0;
  createArea.mockClear();
});

describe("resolveOnboardingArea", () => {
  it("reuses the owner's default area, and creates nothing", async () => {
    defaultRow = usable({ country: "AU" });
    expect(await resolveOnboardingArea(OWNER, SITE)).toEqual({
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
    const out = await resolveOnboardingArea(OWNER, SITE);
    expect(out).toEqual({
      areaId: AREA_NEW,
      createdAreaId: AREA_NEW,
      recordedAsDefault: true,
    });
    // 🛑 The site address has to travel. It is the only moment the vendor offers it, and it is what
    // feeds the Enphase sun-times window and the NEM region — dropping it here is silent and
    // unrecoverable without the user re-entering it by hand.
    expect(createArea).toHaveBeenCalledWith({
      ownerClerkUserId: OWNER,
      displayName: "Enphase System",
      timezoneOffsetMin: 600,
      displayTimezone: "Australia/Melbourne",
      location: { country: "AU", state: "VIC", postcode: "3130" },
      memberSystemIds: [],
      authorized: new Map(),
    });
    expect(upserts).toEqual([{ clerkUserId: OWNER, defaultAreaId: AREA_NEW }]);
  });

  it("does NOT record a default when the owner already has another area", async () => {
    otherAreas = [{ id: AREA_OTHER }]; // nothing recorded, but other areas exist
    const out = await resolveOnboardingArea(OWNER, SITE);
    expect(out.recordedAsDefault).toBe(false);
    // A multi-site owner has no obvious default, and guessing one from whichever device they
    // happened to connect next is worse than leaving it blank: blank means "mint a site for this
    // connection", which is the pre-0073 behaviour and is never surprising.
    expect(upserts).toEqual([]);
    expect(out.areaId).toBe(AREA_NEW);
  });

  it("🛑 REPLACES a recorded default that has been archived, however many areas the owner has", async () => {
    // The regression the first cut of the CAS introduced: guarding the write on `default IS NULL`
    // meant a user whose default had been archived could never acquire a new one — the column was
    // not null, so the update matched nothing, and the NEXT connection saw the area this one had
    // just created and stopped trying. Silent, permanent, and visible only as "my devices keep
    // landing in new sites".
    defaultRow = {
      recorded: AREA_DEFAULT,
      areaId: AREA_DEFAULT,
      areaOwner: OWNER,
      areaStatus: "archived",
      location: null,
    };
    otherAreas = [{ id: AREA_OTHER }];
    const out = await resolveOnboardingArea(OWNER, SITE);
    expect(out).toEqual({
      areaId: AREA_NEW,
      createdAreaId: AREA_NEW,
      recordedAsDefault: true,
    });
    expect(upserts).toEqual([{ clerkUserId: OWNER, defaultAreaId: AREA_NEW }]);
  });

  it("…and replaces one whose area has been re-owned", async () => {
    defaultRow = {
      recorded: AREA_DEFAULT,
      areaId: AREA_DEFAULT,
      areaOwner: "user_someone_else",
      areaStatus: "active",
      location: null,
    };
    const out = await resolveOnboardingArea(OWNER, SITE);
    expect(out.areaId).toBe(AREA_NEW);
    expect(out.recordedAsDefault).toBe(true);
  });

  it("🛑 fills a BLANK location on a reused default from the vendor's address", async () => {
    // Tesla first (its callback passes `location: null`), Enphase second. Without this the address
    // Enphase supplies — the only source of the sun-times window and the NEM region — is discarded
    // by the very mechanism whose reason for existing is not discarding it.
    defaultRow = usable(null);
    await resolveOnboardingArea(OWNER, SITE);
    expect(locationFills).toEqual([SITE.location]);
  });

  it("…and never OVERWRITES a location the default already has", async () => {
    defaultRow = usable({ country: "AU", state: "NSW" });
    await resolveOnboardingArea(OWNER, SITE);
    expect(locationFills).toEqual([]);
  });

  it("🛑 CAS-guards the default write, and reports whether it actually landed", async () => {
    // Two first-ever connections both decide to record; the `setWhere` is what stops the second
    // silently re-pointing the first, and the `returning()` is what stops both of them CLAIMING to
    // have won — `createDevice` logged two different areas as the user's default.
    defaultWriteApplies = false;
    const out = await resolveOnboardingArea(OWNER, SITE);
    expect(upsertOpts[0]).toHaveProperty("setWhere");
    expect(upsertOpts[0].setWhere).toBeDefined();
    expect(out.recordedAsDefault).toBe(false);
    // …and losing the race does not change where THIS device goes: it still lands in the site this
    // call created, which is a real site with the right location.
    expect(out.areaId).toBe(AREA_NEW);
  });

  it("asks 'does this owner have any area' BEFORE creating one", async () => {
    // Asking afterwards (excluding the one just made) is what let two racing first connections each
    // see the other's new area and record no default at all.
    let askedBeforeCreate = false;
    createArea.mockImplementationOnce(async () => {
      askedBeforeCreate = true;
      return { id: AREA_NEW, legacySystemId: 42, vacatedAreaIds: [] };
    });
    await resolveOnboardingArea(OWNER, SITE);
    expect(askedBeforeCreate).toBe(true);
    expect(upserts).toHaveLength(1);
  });
});
