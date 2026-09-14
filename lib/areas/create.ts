/**
 * Write side of the Areas tables for the self-serve **area builder** — creating a multi-device "site"
 * area, editing its metadata, adding/removing member devices, and authoring role→point bindings.
 *
 * These are the persistence helpers the `/api/v4/areas` mutation routes call (the routes own auth); they
 * keep the routes thin, mirroring `lib/dashboard/dashboards.ts`. Areas are EXPLICIT: a device gets no
 * auto-minted Area — everything here mints a SYNTHETIC-handle area (no `systems` row) so a site
 * can grow from one member to many WITHOUT ever re-keying (see `lib/areas/handles.ts` and
 * docs/architecture/areas-and-dashboards.md).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { isUniqueViolationOn } from "@/lib/db/pg-error";
import {
  devices,
  areas,
  areaBindings,
  points,
} from "@/lib/db/planetscale/schema";
import type { AreaConfig, AreaLocation } from "@/lib/areas/types";
import { Device, Point, type DeviceId, type PointId } from "@/lib/ids";
import { ROLES, type RoleId } from "@/lib/roles/registry";
import { allocateAreaHandle } from "@/lib/areas/handles";
import { PointManager } from "@/lib/point/point-manager";
import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";
import { getAreaMemberDeviceIds, setDeviceArea } from "@/lib/areas/members";
import { getLegacySystemIdForArea } from "@/lib/areas/resolve";
import { DeviceRegistry } from "@/lib/registry";
import { HandleAreaConflictError } from "@/lib/registry/device-registry";
import { bindingShapeMatches } from "@/lib/areas/slots";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

type Db = ReturnType<typeof requirePlanetscaleDb>;

/** Raised when an alias collides with another of the owner's areas (SQLSTATE 23505). → HTTP 409. */
export class AreaAliasTakenError extends Error {
  constructor() {
    super("alias already in use");
    this.name = "AreaAliasTakenError";
  }
}

/** Raised when the caller lacks access to a member device they're trying to add. → HTTP 403. */
export class AreaAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AreaAccessError";
  }
}

/**
 * Raised when the world moved under a write: a device this request authorized against is no longer
 * where authorization saw it. → HTTP 409.
 *
 * 🛑 It exists so the whole write ROLLS BACK. Without it a full replace could commit its destructive
 * half and skip its constructive one — remove X and its bindings, silently fail to move Y in because
 * Y had gone elsewhere, and answer 200 with an empty area.
 */
export class AreaConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AreaConflictError";
  }
}

/** Raised on bad input (unknown role, non-member point, removing the last member, …). → HTTP 400. */
export class AreaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AreaValidationError";
  }
}

/**
 * 🛑 The alias 409 on BOTH write paths below goes through `isUniqueViolationOn`
 * (lib/db/pg-error.ts). Do NOT inline a private predicate: the two obvious ones are both dead on
 * this stack, and together they once turned every alias collision — the one thing `/api/v4/areas`
 * documents a 409 for — into a 500.
 *
 *  1. `(err as {code?: string}).code === "23505"` never matches: drizzle ≥0.44 re-throws a failed
 *     query as a `DrizzleQueryError` whose own `code` is undefined and whose `cause` is the pg error.
 *  2. `constraintOf(err) === "areas_owner_alias_unique"` never matches either, and fixing (1) alone
 *     does not help: PlanetScale's proxy strips `constraint` from every error it forwards. The index
 *     name arrives in the `message` text only.
 *
 * `lib/db/pg-error.ts`'s docstring carries the measurement, including why a migration restating the
 * `uniqueIndex` as a named constraint would NOT fix (2).
 */
const AREA_ALIAS_UNIQUE = "areas_owner_alias_unique";

/**
 * Where each device WAS when it was authorized — `devices.id` → its `area_id` at that moment.
 *
 * 🛑 This is not a convenience; it is the authorization CARRIED FORWARD, and every move applies only
 * `WHERE area_id` still equals what this map recorded. Scoping a write on a SECOND, later read (the
 * first cut of this) closes nothing: a custody claim authorized against area A, followed by the
 * owner moving the device to B, would simply re-read B and take it from there — deciding against one
 * state and writing to another.
 */
export type AuthorizedPlacements = Map<string, string | null>;

/**
 * Assert the caller may place each `systemId` in an area they own — the no-escalation firewall.
 *
 * 🛑 **This used to ask only "can the caller READ it", and that is no longer a sufficient question.**
 * The old rule was sound precisely because membership was ADDITIVE: the worst a caller could do by
 * naming your device was aggregate data they could already see, and your own area kept it too. With
 * `devices.area_id` a device is in 0 or 1 area, so naming it here TAKES IT OUT of wherever it was —
 * a read-shaped permission would let anyone who can see a device silently remove it from someone
 * else's site, blanking that site's Sankey and its bindings. So there are now two legs:
 *
 *  1. **Ownership.** Admin, or the caller owns the device.
 *  2. **Custody.** The device is currently in an area the CALLER owns — so it is leaving a place
 *     they are already responsible for. This is what lets an owner re-home their own site's members
 *     between their own areas without owning every device in them (Craig's devices in Craig Unified).
 *
 * Two kinds of device are **not placeable at all**, by anyone including an admin →
 * `AreaValidationError` (422, not 403: each is a statement about the DEVICE, not about the caller,
 * so every caller gets the same answer).
 *
 *  - **Ownerless.** An OpenElectricity NEM region — Home Assistant's `entry_type=SERVICE`: an
 *    ambient producer that many areas consume by REFERENCE and none contains. It was admissible
 *    under the read rule, and that is exactly how OE regions ended up as members of three areas
 *    each before migration 0071 made them ambient.
 *  - **A `vendor='helper'` device.** A helper is an area's own COMPUTED output — it owns the
 *    battery-provenance blend points of the area that minted it, and `helperSiteId(areaId)` bakes
 *    that area into its `vendor_site_id` permanently. Adopting one into a second area makes that
 *    area's resolver union another site's blend, which is the "serving points of a device you do
 *    not hold" class this whole change exists to close. `replaceMembers` has always refused to
 *    EVICT a helper by omission; this is the missing other half, and without it the two rules
 *    contradict — you could not drop a helper you had just been allowed to steal.
 *
 *    🛑 It is also how `ensureHelperDevice` broke. Adopt Daylesford's helper into another area and
 *    the dedupe (which looks in the area) misses, so the next provenance recompute tries to MINT a
 *    second helper and dies on `devices_helper_area_unique` — a 500 on
 *    `POST /api/v4/areas/{id}/recompute-provenance`, reproduced on `origin/main` by
 *    `v4-surface-smoke`. The dedupe now heals that too, but the adoption should not have been
 *    possible.
 *
 * A fourth `user_systems` viewer-grant term was dropped with that table in migration 0045 (slice F).
 */
export async function assertDevicesRehomable(
  userId: string,
  isAdmin: boolean,
  systemIds: number[],
): Promise<AuthorizedPlacements> {
  const observed: AuthorizedPlacements = new Map();
  for (const sid of systemIds) {
    const dev = await DeviceConfigRegistry.deviceByHandle(sid);
    if (!dev) throw new AreaValidationError(`System ${sid} not found`);
    if (dev.ownerClerkUserId == null)
      throw new AreaValidationError(
        `Device ${sid} is ambient (no owner) and cannot be placed in an area — reference it by id instead`,
      );
    if (dev.vendorType === "helper")
      throw new AreaValidationError(
        `Device ${sid} is an area's derived output and belongs to the area that mints it — it cannot be moved`,
      );
    observed.set(dev.uuid, dev.areaId);
    if (isAdmin || dev.ownerClerkUserId === userId) continue;
    if (dev.areaId && (await areaOwner(dev.areaId)) === userId) continue;
    throw new AreaAccessError(`No access to system ${sid}`);
  }
  return observed;
}

/** Who owns an area, for the custody leg above. Null for an unknown area. */
async function areaOwner(areaId: string): Promise<string | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ ownerUserId: areas.ownerUserId })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  return row?.ownerUserId ?? null;
}

export interface CreateAreaInput {
  ownerClerkUserId: string;
  displayName: string;
  alias?: string | null;
  timezoneOffsetMin: number;
  displayTimezone: string;
  location?: AreaLocation | null;
  /** Member device systemIds. Each is MOVED into the new area, leaving whatever area it was in. */
  memberSystemIds: number[];
  /**
   * What `assertDevicesRehomable` observed about each member — its `devices.id` → the area it was in
   * when the caller was authorized. The move applies only where that still holds; the route supplies
   * it, because the route is where the authorization happened.
   */
  authorized: AuthorizedPlacements;
}

/**
 * Create a multi-device (site) area with a freshly-allocated synthetic handle and its member rows, in
 * one transaction. Returns the area uuid + its integer addressing handle. Retries on a handle race;
 * surfaces an alias collision as `AreaAliasTakenError`.
 *
 * config-v4 Phase 13 PR 6: the handle is minted ONLY into `legacy_handles` — `areas.legacy_system_id`
 * is gone (migration 0052). The handle-race retry therefore hangs off `HandleAreaConflictError` from
 * `ensureAreaForHandle` instead of a 23505 on `areas_legacy_system_unique`: that index is what used to
 * detect the race, and it no longer exists. See `HandleAreaConflictError` for why the upsert's own PK
 * conflict is not a substitute.
 */
export async function createArea(
  input: CreateAreaInput,
): Promise<{ id: string; legacySystemId: number; vacatedAreaIds: string[] }> {
  const db = requirePlanetscaleDb();
  const id = uuidv7();
  const members = [...new Set(input.memberSystemIds)];
  // The areas the new members LEFT — the caller refreshes serving for each, or they go on serving a
  // device they no longer hold.
  const vacatedAreas = new Set<string>();

  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = await allocateAreaHandle(db);
    try {
      await db.transaction(async (tx) => {
        await tx.insert(areas).values({
          // config-v4: the KEYS are the renamed `areas` columns; the VALUES still come from the
          // unchanged CreateAreaInput (renaming that input shape is elective → Phase 9).
          id,
          ownerUserId: input.ownerClerkUserId,
          name: input.displayName,
          slug: input.alias ?? null,
          timezoneOffsetMin: input.timezoneOffsetMin,
          dayOffsetMin: input.timezoneOffsetMin,
          displayTimezone: input.displayTimezone,
          location: input.location ?? null,
          status: "active",
        });
        await DeviceRegistry.ensureAreaForHandle(handle, id, tx);
        if (members.length > 0) {
          // Slice 1a: this RESOLVES the uuid (`uuidForRid`) rather than ensuring the row
          // (`ensureDeviceRow`). It is not a weakening — `devices` is the registry now, not a mirror, so a
          // member handle with no `devices` row is a genuine error and `uuidForRid` THROWS, aborting the
          // tx. Previously it would have silently minted a device from a `systems` row.
          // Sequential, not Promise.all: a drizzle tx is ONE pg client, so overlapping statements on it
          // are serialised anyway and only make the ordering harder to reason about.
          const deviceIds: string[] = [];
          for (const systemId of members) {
            deviceIds.push(await DeviceRegistry.uuidForRid(systemId, tx));
          }
          // 🛑 A MOVE, and it cleans up BOTH ends. Each named device leaves whatever area it was in
          // — its eagerly-minted area-of-one, normally, but possibly a site area someone else owns,
          // which is why the route runs `assertDevicesRehomable` before it gets here — and that
          // area's bindings onto its points go with it. Ordinal is gone with the membership row.
          for (const vacated of await moveDevicesInto(
            tx,
            id,
            deviceIds,
            input.authorized,
          ))
            vacatedAreas.add(vacated);
        }
      });
      return { id, legacySystemId: handle, vacatedAreaIds: [...vacatedAreas] };
    } catch (err) {
      // A retry re-runs the whole transaction, so anything the aborted attempt recorded is not a fact
      // about the database any more.
      vacatedAreas.clear();
      if (err instanceof HandleAreaConflictError) continue; // lost a handle race — re-allocate
      if (isUniqueViolationOn(err, AREA_ALIAS_UNIQUE))
        throw new AreaAliasTakenError();
      throw err;
    }
  }
  throw new Error("Could not allocate a free area handle after 5 attempts");
}

/** Patch an area's metadata (name/alias/timezone/status/location). Alias collision → AreaAliasTakenError. */
export async function updateAreaMeta(
  areaId: string,
  patch: {
    displayName?: string;
    alias?: string | null;
    timezoneOffsetMin?: number;
    displayTimezone?: string;
    status?: string;
    location?: AreaLocation | null;
  },
): Promise<void> {
  // config-v4: the KEYS are drizzle FIELD names on `areas` (displayName→name, alias→slug); the `patch`
  // shape is the unchanged caller-facing API. NOTE this object is deliberately typed against the table
  // rather than `Record<string, unknown>`: an untyped record made the rename invisible to tsc, so a stale
  // `set.displayName` would have compiled and then silently not renamed the area post-cutover — the
  // W-series cannot catch it either, because that check only models INSERTs.
  const set: Partial<typeof areas.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.name = patch.displayName;
  if (patch.alias !== undefined) set.slug = patch.alias;
  if (patch.timezoneOffsetMin !== undefined) {
    set.timezoneOffsetMin = patch.timezoneOffsetMin;
    set.dayOffsetMin = patch.timezoneOffsetMin;
  }
  if (patch.displayTimezone !== undefined)
    set.displayTimezone = patch.displayTimezone;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.location !== undefined) set.location = patch.location;
  try {
    await requirePlanetscaleDb()
      .update(areas)
      .set(set)
      .where(eq(areas.id, areaId));
  } catch (err) {
    if (isUniqueViolationOn(err, AREA_ALIAS_UNIQUE))
      throw new AreaAliasTakenError();
    throw err;
  }
}

/**
 * Move a device INTO an area. Idempotent (a device already there is left alone entirely).
 *
 * Named `addMember` for its callers' sake, but it is a re-home: the device leaves whatever area it
 * was in, and that area's bindings onto its points go with it. Returns the area it left, if any, so
 * the caller can refresh serving at both ends.
 */
export async function addMember(
  areaId: string,
  systemId: number,
  authorized: AuthorizedPlacements,
): Promise<string[]> {
  const db = requirePlanetscaleDb();
  const deviceId = await DeviceRegistry.uuidForRid(systemId, db);
  return db.transaction(async (tx) => [
    ...(await moveDevicesInto(tx, areaId, [deviceId], authorized)),
  ]);
}

/**
 * Delete every binding of `areaId` whose point lives on `deviceUuid` — "this device's bindings in
 * this area", the one predicate every membership change needs.
 *
 * 🛑 It has to run on the SOURCE side of a move as well as the destination side. A device is in at
 * most one area, so pulling it into B takes it out of A — and A's `area_bindings` rows onto its
 * points survive that move, because nothing about them mentions membership. They are not inert: the
 * resolver treats bindings as the OVERRIDE that SELECTS an area's points, so A would go on serving a
 * device it no longer holds, with no error and nothing to grep for. Found in review; the first cut
 * of this change cleaned only the departing side.
 *
 * Addressed through `points.device_id` since slice E PR 2a — no `devices.rid` hop.
 */
async function detachBindings(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  areaId: string,
  deviceUuid: string,
): Promise<void> {
  await tx
    .delete(areaBindings)
    .where(
      and(
        eq(areaBindings.areaId, areaId),
        inArray(
          areaBindings.pointUid,
          tx
            .select({ id: points.id })
            .from(points)
            .where(eq(points.deviceId, deviceUuid)),
        ),
      ),
    );
}

/**
 * Move `deviceUuids` into `areaId`, detaching each from the area `authorized` recorded it in —
 * bindings and all. Returns the areas actually VACATED, so the caller can refresh serving at both
 * ends.
 *
 * 🛑 **The UPDATE goes FIRST and the binding delete is conditional on it.** A move is only real if
 * the device is still where AUTHORIZATION saw it, so the write is scoped on that — a device someone
 * else moved in the meantime becomes a no-op rather than a theft. Deleting the bindings before
 * knowing that would destroy a live area's wiring on behalf of a move that never happened, which is
 * the worst failure available here: bindings are authored by hand and nothing rebuilds them.
 */
async function moveDevicesInto(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  areaId: string,
  deviceUuids: string[],
  authorized: AuthorizedPlacements,
): Promise<Set<string>> {
  const vacated = new Set<string>();
  for (const uuid of deviceUuids) {
    const from = authorized.get(uuid) ?? null;
    if (from === areaId) continue; // already here — no detach, no write
    const applied = await tx
      .update(devices)
      .set({ areaId, updatedAt: new Date() })
      .where(
        and(
          eq(devices.id, uuid),
          from === null ? isNull(devices.areaId) : eq(devices.areaId, from),
        ),
      )
      .returning({ id: devices.id });
    // 🛑 THROW, do not skip. Skipping was how a full replace committed its destructive half: the
    // departing members and their bindings were already gone by the time we got here, so continuing
    // would commit an emptied area and report success. Throwing rolls the whole transaction back, and
    // the route turns it into a 409 telling the caller to refetch.
    if (applied.length === 0)
      throw new AreaConflictError(
        `device ${uuid} is no longer in the area it was authorized from — refetch and try again`,
      );
    if (from) {
      await detachBindings(tx, from, uuid);
      vacated.add(from);
    }
  }
  return vacated;
}

/**
 * Take a member device OUT of an area — it becomes ambient (`devices.area_id = NULL`), not deleted —
 * and drop its now-orphaned bindings in the same transaction, so the resolver never dereferences a
 * point on a departed member (the `point_uid → points.id` FK guards nonexistent points but not
 * membership drift).
 *
 * The "cannot remove the last member" rule is RETIRED (plan decision 2): a zero-device area is
 * first-class now. It had to go — it is what made the picker rule "hide areas-of-one" a render-time
 * convention rather than the structural "hide areas with zero devices" — and it never protected
 * anything, since an area with no devices simply resolves to no points and drops out of flow
 * eligibility on its own.
 */
export async function removeMember(
  areaId: string,
  systemId: number,
): Promise<void> {
  const db = requirePlanetscaleDb();
  const memberIds = await getAreaMemberDeviceIds(areaId);
  const rids = await DeviceRegistry.ridsForDevices(memberIds);
  const target = memberIds.find((id) => rids.get(id) === systemId);
  if (!target) return; // not a member — no-op
  const deviceUuid = Device.toUuid(target);
  await db.transaction(async (tx) => {
    await detachBindings(tx, areaId, deviceUuid);
    // 🛑 Scoped on THIS area. Membership was read before the transaction opened, so a device that has
    // since moved elsewhere must not be orphaned by a removal aimed at the area it has already left.
    await tx
      .update(devices)
      .set({ areaId: null, updatedAt: new Date() })
      .where(and(eq(devices.id, deviceUuid), eq(devices.areaId, areaId)));
  });
}

/**
 * Move ONE device into an area, or out of every area (`toAreaId = null`) — the device-side inverse of
 * the area-side `PUT /members`, backing `PATCH /api/v4/devices/{id} { areaId }`.
 *
 * Both verbs exist because both questions are natural and neither is derivable from the other in one
 * request: "which devices are in this area" (the area builder's picker) and "which area is this
 * device in" (the device settings dialog, and the only way to say *not assigned*). Home Assistant has
 * the same pair, for the same reason.
 *
 * Returns the area the device LEFT and whether the move actually APPLIED, so the caller can refresh
 * serving for both ends — a re-home invalidates the KV subscription registry and the point-series
 * cache of the source area just as much as the destination's, and refreshing only the destination
 * leaves the old area serving latest values for a device it no longer holds.
 *
 * `moved: false, conflicted: false` is "already there" — success. `conflicted: true` is "someone
 * moved it between authorization and the write": nothing was written, and this function does NOT
 * know where the device is now, so the caller must refetch rather than be told.
 *
 * Departing bindings go with it, by exactly the predicate `removeMember` uses. A no-op move (already
 * there) short-circuits BEFORE the delete: re-stating a device's current area must not drop its
 * bindings.
 */
export async function rehomeDevice(
  deviceId: DeviceId,
  toAreaId: string | null,
  authorized: AuthorizedPlacements,
): Promise<{ fromAreaId: string | null; moved: boolean; conflicted: boolean }> {
  const db = requirePlanetscaleDb();
  const deviceUuid = Device.toUuid(deviceId);
  if (!authorized.has(deviceUuid))
    throw new AreaValidationError(`Device ${deviceId} was not authorized`);
  // 🛑 The area AUTHORIZATION saw, not a fresh read. Re-reading here and scoping on that would
  // decide against one state and write to another: a custody claim authorized while the device sat
  // in the caller's area A, followed by its owner moving it to B, would re-read B and take it.
  const fromAreaId = authorized.get(deviceUuid) ?? null;
  if (fromAreaId === toAreaId)
    return { fromAreaId, moved: false, conflicted: false };

  let moved = false;
  await db.transaction(async (tx) => {
    const applied = await tx
      .update(devices)
      .set({ areaId: toAreaId, updatedAt: new Date() })
      .where(
        and(
          eq(devices.id, deviceUuid),
          fromAreaId === null
            ? isNull(devices.areaId)
            : eq(devices.areaId, fromAreaId),
        ),
      )
      .returning({ id: devices.id });
    // 🛑 The move goes FIRST and the binding delete is conditional on it having applied. Zero rows
    // means someone moved the device out from under us; deleting a live area's bindings on behalf of
    // a move that did not happen is the worst outcome available, because bindings are hand-authored
    // and nothing rebuilds them.
    if (applied.length === 0) return;
    moved = true;
    if (fromAreaId) await detachBindings(tx, fromAreaId, deviceUuid);
  });
  // 🛑 `conflicted` is NOT the same as "already there". Both write nothing, but one is success and
  // the other means the device is somewhere neither the caller nor this function knows — reporting
  // `fromAreaId` as its current area would be a guess, and a wrong one.
  return { fromAreaId, moved, conflicted: !moved };
}

/**
 * Declarative FULL REPLACE of an area's membership (clean-sheet §9.2: `PUT` on a collection diffs
 * server-side, applies transactionally, and the caller then returns the new state). Backs
 * `PUT /api/v4/areas/{id}/members`, which replaces the legacy `POST`+`DELETE /devices` pair.
 *
 * 🛑 `desired` is no longer an ORDER. The array index used to become `area_members.ordinal`, so "a
 * pure reorder is a real edit" was part of this contract; with one area per device there is no
 * membership row to carry an ordinal, and intra-area order is presentation — reproduced by
 * `getAreaMemberDeviceIds`' `(helper-last, rid)` sort. Duplicates are still rejected (the wire is
 * still a set stated as an array), and a reorder is now genuinely a no-op.
 *
 * 🛑 And it is a full replace in BOTH directions now: a device named here LEAVES the area it was in,
 * which may be an area someone else owns. The route runs `assertDevicesRehomable` first — read its
 * docstring before touching either side.
 *
 * Members that leave become AMBIENT (`area_id = NULL`), not deleted, and take their now-orphaned
 * bindings with them, by exactly the predicate `removeMember` uses, so the resolver never
 * dereferences a point on a device that is no longer a member. Members that JOIN are detached from
 * their previous area the same way; the areas they vacated are RETURNED so the caller can refresh
 * serving at both ends.
 *
 * 🛑 The removal leg is the half that fails SILENTLY when it is wrong, in BOTH directions: an
 * under-delete leaves a ghost member, an over-delete quietly drops bindings that should have survived,
 * and neither raises. `scripts/utils/area-builder-smoke.ts` historically cleared every binding BEFORE
 * removing a member, so its remove ran against zero rows and proved only that the SQL parses. The case
 * that actually proves it — and which `v4-surface-smoke.ts` now drives — is a TWO-member area with a
 * binding on EACH member, removing one: the departing member's binding must go and the survivor's must
 * remain.
 *
 * An EMPTY membership is now legal (plan decision 2) — `PUT {members: []}` empties the area and
 * leaves every former member ambient. The old refusal restated `removeMember`'s "cannot remove the
 * last member" rule declaratively; both are retired together.
 *
 * 🛑 **HELPER members are SERVER-MANAGED and are never evicted by an omission.** An area's `helper`
 * device (`vendor='helper'`, ordinal 99 — `lib/areas/helper.ts`) is minted by the battery-provenance
 * writer, not chosen by a human: `writeBlendOutputs` creates it, registers the blend points on it and
 * binds them into the area. It is therefore not part of the membership a client AUTHORS, and a full
 * replace that omitted it — which is exactly what a client that read `members`, filtered to the real
 * devices it shows in a picker, and PUT the result back would do — would silently delete the area's
 * blend bindings and blank its provenance card until the next daily recompute re-created them. So a
 * helper is dropped from the departing set: naming it keeps it (and re-ordinals it), omitting it keeps
 * it too. This is the same "store choices, not derived state" line §8.2 draws for the doc.
 */
export async function replaceMembers(
  areaId: string,
  desired: DeviceId[],
  authorized: AuthorizedPlacements,
): Promise<string[]> {
  const wanted = [...new Set(desired)];
  if (wanted.length !== desired.length)
    throw new AreaValidationError("Duplicate member in the members list");

  const db = requirePlanetscaleDb();
  const current = await getAreaMemberDeviceIds(areaId);
  const wantedSet = new Set(wanted);
  const candidates = current.filter((id) => !wantedSet.has(id));
  // Read the vendor from `devices`, never from the wire — the caller does not get to declare which of
  // its omissions were "really" server-managed.
  const serverManaged = new Set(
    candidates.length === 0
      ? []
      : (
          await db
            .select({ id: devices.id })
            .from(devices)
            .where(
              and(
                inArray(
                  devices.id,
                  candidates.map((id) => Device.toUuid(id)),
                ),
                eq(devices.vendor, "helper"),
              ),
            )
        ).map((r) => Device.encode(r.id)),
  );
  const departing = candidates.filter((id) => !serverManaged.has(id));

  return db.transaction(async (tx) => {
    for (const leaving of departing) {
      const deviceUuid = Device.toUuid(leaving);
      await detachBindings(tx, areaId, deviceUuid);
      // 🛑 Scoped on THIS area — `current` was read before the transaction opened, so a device that
      // has since moved must not be orphaned by a removal aimed at the area it already left.
      await tx
        .update(devices)
        .set({ areaId: null, updatedAt: new Date() })
        .where(and(eq(devices.id, deviceUuid), eq(devices.areaId, areaId)));
    }
    // 🛑 Joining members are a MOVE, not an assignment: each leaves whatever area it was in, and that
    // area's bindings onto its points go with it. The first cut of this wrote `area_id` and stopped,
    // which left the source area still SELECTING the device's points through bindings nothing had
    // removed — serving a device it no longer held, silently.
    return [
      ...(await moveDevicesInto(
        tx,
        areaId,
        wanted.map((id) => Device.toUuid(id)),
        authorized,
      )),
    ];
  });
}

export interface BindingInput {
  role: string;
  metricType: string;
  /** The bound point's opaque `pt_` TypeID — decoded to `area_bindings.point_uid` at the seam. */
  pointId: PointId;
  priority?: number;
  transform?: string | null;
}

/**
 * Replace ALL of an area's bindings with the given ordered list (ordinal = array index), in one
 * transaction. Validates each role is known, each point's owning device is a current member, and there
 * are no duplicate (role, metricType, pointId) tuples — the same triple `area_bindings_unique` enforces
 * since migration 0047. `metricType` comes from the chosen point's `point_info.metric_type` (the caller
 * sources it from `/api/device/[id]/points`).
 */
export async function replaceBindings(
  areaId: string,
  bindings: BindingInput[],
): Promise<void> {
  // Membership is stated in device uuids but `point_info.system_id` is still an int handle
  // (Phase 13), so the member set has to come back to handles to validate a point's owner against it.
  const memberIds = await getAreaMemberDeviceIds(areaId);
  const memberRids = await DeviceRegistry.ridsForDevices(memberIds);
  const members = new Set<number>(memberRids.values());
  const seen = new Set<string>();
  // One `IN (uuid, …)` instead of the old OR-of-(system_id, index)-pairs: the wire now names the point
  // directly, so there is nothing to reconstruct an address from.
  const wantedUids = bindings.map((b) => Point.toUuid(b.pointId));
  const pointRows =
    bindings.length === 0
      ? []
      : await requirePlanetscaleDb()
          .select({
            systemId: devices.rid,
            pointUid: points.id,
            logicalPathStem: points.logicalPath,
            metricType: points.metricType,
          })
          .from(points)
          .innerJoin(devices, eq(devices.id, points.deviceId))
          .where(inArray(points.id, wantedUids));
  const pointByUid = new Map(pointRows.map((point) => [point.pointUid, point]));
  const nextPriority = new Map<string, number>();
  const seenPriorities = new Set<string>();
  // Collected in binding order so the INSERT can name `point_uid` without re-looking-up (and without a
  // non-null assertion — the loop below has already proven every point resolves).
  const resolvedUids: string[] = [];
  // The owning device of each resolved point, in binding order — read from `points ⋈ devices`, not from the
  // wire, so a caller cannot claim a point belongs to a device it does not.
  const resolvedSystemIds: number[] = [];
  for (let bi = 0; bi < bindings.length; bi++) {
    const b = bindings[bi];
    if (!(b.role in ROLES))
      throw new AreaValidationError(`Unknown role: ${b.role}`);
    if (!b.metricType)
      throw new AreaValidationError("Each binding needs a metricType");
    const point = pointByUid.get(wantedUids[bi]);
    if (!point) throw new AreaValidationError(`Point ${b.pointId} not found`);
    if (!members.has(point.systemId))
      throw new AreaValidationError(
        `Point ${b.pointId} belongs to system ${point.systemId}, which is not a member of this area`,
      );
    if (
      point.metricType !== b.metricType ||
      !bindingShapeMatches(b.role as RoleId, b.metricType, point)
    )
      throw new AreaValidationError(
        `Point ${b.pointId} does not match ${b.role}/${b.metricType}`,
      );
    const key = `${b.role}|${b.metricType}|${b.pointId}`;
    if (seen.has(key))
      throw new AreaValidationError(`Duplicate binding: ${key}`);
    seen.add(key);
    const slot = `${b.role}|${b.metricType}`;
    const priority =
      b.priority ??
      (() => {
        const current = nextPriority.get(slot) ?? 0;
        nextPriority.set(slot, current + 1);
        return current;
      })();
    if (!Number.isInteger(priority) || priority < 0)
      throw new AreaValidationError(
        "Binding priority must be a non-negative integer",
      );
    const priorityKey = `${slot}|${priority}`;
    if (seenPriorities.has(priorityKey))
      throw new AreaValidationError(
        `Duplicate binding priority: ${priorityKey}`,
      );
    seenPriorities.add(priorityKey);
    b.priority = priority;
    resolvedUids.push(point.pointUid);
    resolvedSystemIds.push(point.systemId);
  }
  const db = requirePlanetscaleDb();
  // The battery/power point's OWNING device, for the area-config carry-over below. Sourced from the
  // resolved `point_info` row (the wire no longer names a device), so it stays an int `systems.id`
  // exactly as the `systems.config` lookup needs.
  const batteryIdx = bindings.findIndex(
    (binding) => binding.role === "battery" && binding.metricType === "power",
  );
  const selectedBatterySystemId =
    batteryIdx < 0 ? undefined : resolvedSystemIds[batteryIdx];

  await db.transaction(async (tx) => {
    // 🛑 RE-CHECK membership inside the transaction. `members` above was read before it opened, and a
    // concurrent re-home invalidates it: a binding PUT validates device D in area A, D's owner moves
    // it to B — which deletes A's bindings onto D as its firewall — and this then re-inserts exactly
    // those bindings. Both requests succeed, and A resumes serving a device it no longer holds,
    // because binding readers join through `points` and never consult membership. Re-reading here
    // and refusing is what makes the re-home's cleanup actually final.
    if (resolvedUids.length > 0) {
      const stillMembers = new Set(
        (
          await tx
            .select({ id: devices.id })
            .from(devices)
            .where(eq(devices.areaId, areaId))
        ).map((d) => d.id),
      );
      const owners = await tx
        .select({ id: points.id, deviceId: points.deviceId })
        .from(points)
        .where(inArray(points.id, resolvedUids));
      for (const point of owners)
        if (!stillMembers.has(point.deviceId))
          throw new AreaConflictError(
            `a device moved out of this area while its bindings were being saved — refetch and try again`,
          );
    }
    await tx.delete(areaBindings).where(eq(areaBindings.areaId, areaId));
    if (bindings.length > 0) {
      await tx.insert(areaBindings).values(
        bindings.map((b, i) => ({
          areaId,
          role: b.role as RoleId,
          metricType: b.metricType,
          pointUid: resolvedUids[i],
          ordinal: i,
          priority: b.priority!,
          transform: b.transform ?? null,
        })),
      );
    }
    const [currentArea] = await tx
      .select({ config: areas.config })
      .from(areas)
      .where(eq(areas.id, areaId))
      .limit(1);
    const selectedBattery =
      selectedBatterySystemId == null
        ? null
        : (
            await tx
              .select({ config: devices.config })
              .from(devices)
              .where(eq(devices.rid, selectedBatterySystemId))
              .limit(1)
          )[0];
    const nextAreaConfig: AreaConfig = { ...(currentArea?.config ?? {}) };
    if (selectedBattery?.config?.batteryProvenance)
      nextAreaConfig.batteryProvenance =
        selectedBattery.config.batteryProvenance;
    else delete nextAreaConfig.batteryProvenance;
    await tx
      .update(areas)
      .set({
        config: Object.keys(nextAreaConfig).length > 0 ? nextAreaConfig : null,
        updatedAt: new Date(),
      })
      .where(eq(areas.id, areaId));
  });
}

/**
 * Refresh live serving after a membership/binding change: drop the in-memory point-series cache for
 * the handle and rebuild the KV subscription registry (derived from `area_bindings` plus every
 * member point whose path nothing else in the area claims) so latest values propagate to the area.
 * No longer the ONLY trigger: a rebuild also fires when a point is minted, and daily as a backstop —
 * membership/binding mutations used to be the only ones, which is why a point minted later on an
 * already-member device stayed invisible. Best-effort — a missing/unconfigured
 * KV (dev) logs a warning rather than failing the mutation.
 */
export async function refreshAreaServing(areaId: string): Promise<void> {
  try {
    const handle = await getLegacySystemIdForArea(areaId);
    if (handle != null)
      PointManager.getInstance().invalidateSeriesCache(handle);
    await buildSubscriptionRegistry();
  } catch (err) {
    console.warn(
      `[areas] refreshAreaServing(${areaId}) failed (KV may be unconfigured in dev):`,
      err,
    );
  }
}
