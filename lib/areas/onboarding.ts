/**
 * ONBOARDING PLACEMENT — which area a newly connected device goes in.
 *
 * ## Why this module exists
 *
 * Until migration 0073 there was no decision here, only a structural fact: `devices.primary_area_id`
 * was NOT NULL, so `insertDeviceToPg` minted an "area-of-one" per device and put it there. That is
 * the proliferation the device→0..1-area change exists to end — 14 of prod's 17 areas were shells
 * holding one device each, and the ambiguity of a device sitting in both its shell and its real site
 * cost two production defects (every Kutis EV run priced at $0.00 for two months, and the
 * flow-eligibility guard that stops a child area claiming its parent's Sankey).
 *
 * Removing the mint leaves a real question, and **Home Assistant's answer does not translate.** HA
 * leaves a discovered device area-less and lets the user assign it, which it can afford because
 * nothing HA renders depends on the area. Here the area is the sole home of `display_timezone` and
 * `location`, so onboarding into no area would silently DISCARD the site address the Enphase OAuth
 * callback supplies — the coordinates behind sun-times and the NEM region — and drop the device onto
 * the platform's +600/Brisbane floor. Losing data at the only moment the vendor offers it is worse
 * than either alternative.
 *
 * So: **an owned device is always placed; an ownerless one never is.**
 *
 * ## The chain
 *
 * 1. `users.default_area_id`, when it is set and still names an ACTIVE area the user owns. This is
 *    the "default area per user" — the thing that stops a household's second inverter minting a
 *    second site.
 * 2. Otherwise create a site area for this connection, named after the device, carrying the
 *    timezone and location the vendor gave us. This is exactly what the writer used to do
 *    structurally, now done once, deliberately, and visibly.
 * 3. And if that was the user's FIRST area, record it as their default — so the column
 *    self-populates and needs no UI before it starts doing its job.
 *
 * 🛑 An OWNERLESS device is not routed through here at all. It is Home Assistant's
 * `entry_type=DeviceEntryType.SERVICE` — an OpenElectricity NEM region, consumed by every area in
 * its state and contained by none — and `assertDevicesRehomable` refuses to place one, so minting an
 * area for it would trap it somewhere nothing could free it from.
 */
import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, users } from "@/lib/db/planetscale/schema";
import type { AreaLocation } from "@/lib/areas/types";
import { createArea } from "@/lib/areas/create";

/** What the vendor told us about the site, used only when an area has to be created. */
export interface OnboardingSite {
  /** The new device's display name — the created area is named after it. */
  displayName: string;
  timezoneOffsetMin: number;
  displayTimezone: string;
  location?: AreaLocation | null;
}

export interface OnboardingPlacement {
  /** The area the device should be created in. */
  areaId: string;
  /** Non-null when this call created that area, rather than reusing the owner's default. */
  createdAreaId: string | null;
  /** True when this call also recorded the created area as the owner's default. */
  recordedAsDefault: boolean;
}

/**
 * The area the owner's default points at, if it is still usable — and its location, so a blank one
 * can be filled from what the vendor just told us.
 *
 * Re-validated rather than trusted: the FK is `ON DELETE SET NULL`, so a dangling id is not possible,
 * but an ARCHIVED area is — and placing a new device into an archived site is how a device becomes
 * invisible the moment it is created. Ownership is re-checked for the same reason it is checked
 * anywhere else: the area could have been re-owned since the default was recorded.
 */
async function readDefaultArea(ownerClerkUserId: string): Promise<{
  /** Whatever `users.default_area_id` holds, usable or not — the CAS token for a replacement. */
  recorded: string | null;
  /** The same area, only when it is still ACTIVE and still this owner's. */
  usable: { id: string; location: AreaLocation | null } | null;
}> {
  const [row] = await requirePlanetscaleDb()
    .select({
      recorded: users.defaultAreaId,
      areaId: areas.id,
      areaOwner: areas.ownerUserId,
      areaStatus: areas.status,
      location: areas.location,
    })
    .from(users)
    // LEFT, so an UNUSABLE default is distinguishable from an absent one. An inner join reported
    // both as "nothing recorded", and the replacement write then CAS'd on `default_area_id IS NULL`
    // and silently did nothing — leaving a user whose default had been archived unable to ever
    // acquire a new one, because the next connection saw the area this one created and stopped
    // trying. Found in review.
    .leftJoin(areas, eq(areas.id, users.defaultAreaId))
    .where(eq(users.clerkUserId, ownerClerkUserId))
    .limit(1);
  if (!row) return { recorded: null, usable: null };
  const usable =
    row.areaId &&
    row.areaOwner === ownerClerkUserId &&
    row.areaStatus === "active"
      ? { id: row.areaId, location: row.location ?? null }
      : null;
  return { recorded: row.recorded ?? null, usable };
}

/** Does this owner have any active area at all? Decides whether a new area becomes the default. */
async function hasAnyArea(ownerClerkUserId: string): Promise<boolean> {
  const [row] = await requirePlanetscaleDb()
    .select({ id: areas.id })
    .from(areas)
    .where(
      and(eq(areas.ownerUserId, ownerClerkUserId), eq(areas.status, "active")),
    )
    .limit(1);
  return !!row;
}

/**
 * Fill a blank `location` on an area from what the vendor just supplied. Never overwrites.
 *
 * The case: connect a Tesla first (its callback passes `location: null`), and the default area it
 * creates has no location. Connect an Enphase second and the default is REUSED — so without this,
 * the site address Enphase supplies, which is the only source of the sun-times window and the NEM
 * region, would be discarded by the very mechanism whose stated reason for existing is not
 * discarding it. Filling a blank is safe in a way overwriting is not: it cannot move a site the
 * user has placed, and it cannot let one vendor's idea of an address overrule another's.
 */
async function fillBlankLocation(
  areaId: string,
  ownerClerkUserId: string,
  location: AreaLocation,
): Promise<void> {
  await requirePlanetscaleDb()
    .update(areas)
    .set({ location, updatedAt: new Date() })
    // The clauses that MATTER are re-stated as predicates rather than merely checked by the caller.
    // Two concurrent connects both reading "blank" must not have the second overwrite the first,
    // and the owner is re-stated because the area could have been transferred between the read and
    // this write — writing a location into it would then be editing somebody else's site.
    //
    // `status` is deliberately NOT re-stated: filling in a blank location on an area archived a
    // moment ago is harmless (nothing reads an archived area's location) and refusing would cost a
    // real write to avoid a no-op.
    .where(
      and(
        eq(areas.id, areaId),
        eq(areas.ownerUserId, ownerClerkUserId),
        isNull(areas.location),
      ),
    );
}

/**
 * Record `areaId` as this owner's default, creating the `users` row if they have none.
 *
 * `onConflictDoUpdate` rather than insert-then-update: a `users` row is created lazily (see
 * `lib/user-preferences.ts`), so a user can onboard a device before they have one, and two
 * concurrent connects must not race each other into a 23505.
 *
 * 🛑 The `setWhere` is a compare-and-swap on BOTH halves of what was observed — the id, and the
 * fact that it was UNUSABLE — because comparing the id alone is not enough. Interleaving: the
 * default names archived area A, onboarding reads "A, unusable" and starts creating B, the user
 * restores A and deliberately re-selects it, and a bare `default_area_id = A` then succeeds and
 * silently replaces their choice with B. Re-stating "…and A is still not an active area this user
 * owns" makes the restore win, which is the right answer: they acted later and on purpose.
 */
async function recordDefaultArea(
  ownerClerkUserId: string,
  areaId: string,
  /**
   * What the column held when we decided to replace it — `null` for "nothing recorded", or the id
   * of a default we OBSERVED to be unusable (archived, or re-owned). Replacing exactly that value
   * is the CAS: it cannot clobber a default somebody set concurrently, and unlike a bare
   * `IS NULL` it does not permanently strand a user whose recorded default has gone stale.
   */
  replacing: string | null,
): Promise<boolean> {
  const written = await requirePlanetscaleDb()
    .insert(users)
    .values({ clerkUserId: ownerClerkUserId, defaultAreaId: areaId })
    .onConflictDoUpdate({
      target: users.clerkUserId,
      set: { defaultAreaId: areaId, updatedAt: new Date() },
      // 🛑 Only fills a BLANK, and that is what makes the decision safe under concurrency. Two
      // first-ever connections racing each other both see no default and both create a site; with
      // an unconditional SET the second would silently re-point the default at its own area, and an
      // earlier cut that asked "is this my only area?" AFTER creating produced the worse outcome
      // still — each saw the other's area, neither recorded anything, and the user was left with no
      // default for ever. First writer wins; the loser is a no-op.
      setWhere:
        replacing === null
          ? isNull(users.defaultAreaId)
          : and(
              eq(users.defaultAreaId, replacing),
              notExists(
                requirePlanetscaleDb()
                  .select({ one: sql`1` })
                  .from(areas)
                  .where(
                    and(
                      eq(areas.id, replacing),
                      eq(areas.ownerUserId, ownerClerkUserId),
                      eq(areas.status, "active"),
                    ),
                  ),
              ),
            ),
    })
    // 🛑 REPORTED, not assumed. Two racing first connections both decide to record; only one write
    // lands, and both claiming `recordedAsDefault: true` made `createDevice` log two different
    // areas as the user's default.
    .returning({ id: users.clerkUserId });
  return written.length > 0;
}

/**
 * Resolve — and if necessary create — the area a newly onboarded device belongs in.
 *
 * Called by `DeviceWriter.createDevice` for every OWNED device. Ownerless devices never reach here.
 */
export async function resolveOnboardingArea(
  ownerClerkUserId: string,
  site: OnboardingSite,
): Promise<OnboardingPlacement> {
  const { recorded, usable } = await readDefaultArea(ownerClerkUserId);
  if (usable) {
    if (!usable.location && site.location)
      await fillBlankLocation(usable.id, ownerClerkUserId, site.location);
    return {
      areaId: usable.id,
      createdAreaId: null,
      recordedAsDefault: false,
    };
  }

  // 🛑 Asked BEFORE the create, so it is a question about the world the caller found rather than one
  // the caller has already changed. An earlier cut asked afterwards, excluding the area just made,
  // on the theory that it avoided a race; it created a worse one — two concurrent first connections
  // each saw the OTHER's new area, so neither recorded a default and the user never got one. Asking
  // first means both racers decide "record it", and `recordDefaultArea`'s CAS settles which.
  //
  // A RECORDED-BUT-UNUSABLE default also gets a replacement, regardless of how many other areas the
  // owner has: the column already names this user's onboarding target, it has simply gone stale, so
  // repointing it is maintenance rather than the guess we decline to make for a multi-site owner
  // who has never chosen one.
  const shouldRecord =
    recorded !== null || !(await hasAnyArea(ownerClerkUserId));

  // No usable default: mint the site this connection implies. `memberSystemIds: []` because the
  // device does not exist yet — the writer places it by setting `devices.area_id` on insert, which
  // is one statement rather than a create-then-move.
  const created = await createArea({
    ownerClerkUserId,
    displayName: site.displayName,
    timezoneOffsetMin: site.timezoneOffsetMin,
    displayTimezone: site.displayTimezone,
    location: site.location ?? null,
    memberSystemIds: [],
    // Empty because there is nothing to authorize: no existing device is being moved, so there is no
    // other owner's placement to observe. `createArea` only consults this map for `memberSystemIds`.
    authorized: new Map(),
  });

  const recordedAsDefault = shouldRecord
    ? await recordDefaultArea(ownerClerkUserId, created.id, recorded)
    : false;

  return {
    areaId: created.id,
    createdAreaId: created.id,
    recordedAsDefault,
  };
}
