/**
 * Write side of the Areas tables for the self-serve **area builder** — creating a multi-device "site"
 * area, editing its metadata, adding/removing member devices, and authoring role→point bindings.
 *
 * These are the persistence helpers the `/api/areas` mutation routes call (the routes own auth); they
 * keep the routes thin, mirroring `lib/dashboard/dashboards.ts`. Areas are EXPLICIT: a device gets no
 * auto-minted Area — everything here mints a SYNTHETIC-handle area (no `systems` row) so a site
 * can grow from one member to many WITHOUT ever re-keying (see `lib/areas/handles.ts` and
 * docs/architecture/areas-and-dashboards.md).
 */
import { and, asc, eq, max } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  areaBindings,
  areaDevices,
  userSystems,
} from "@/lib/db/planetscale/schema";
import type { AreaLocation } from "@/lib/areas/types";
import { ROLES, type RoleId } from "@/lib/roles/registry";
import { allocateAreaHandle } from "@/lib/areas/handles";
import { SystemsManager } from "@/lib/systems-manager";
import { PointManager } from "@/lib/point/point-manager";
import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";
import { getAreaDeviceSystemIds } from "@/lib/areas/devices";
import { getLegacySystemIdForArea } from "@/lib/areas/resolve";

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

/** Raised on bad input (unknown role, non-member point, removing the last member, …). → HTTP 400. */
export class AreaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AreaValidationError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}
function constraintOf(err: unknown): string | undefined {
  return (err as { constraint?: string })?.constraint;
}

/**
 * Assert the caller may pull each `systemId` into an area they own — the no-escalation firewall. A
 * member is allowed when the caller can READ it (admin / owner / public-ownerless / viewer): you can
 * only aggregate data you can already see. (Read, not write: public grid-region systems — e.g. an
 * OpenElectricity NEM region — are legitimately added as members without owning them.)
 */
export async function assertMembersReadable(
  userId: string,
  isAdmin: boolean,
  systemIds: number[],
): Promise<void> {
  const sm = SystemsManager.getInstance();
  const db = requirePlanetscaleDb();
  for (const sid of systemIds) {
    const sys = await sm.getSystem(sid);
    if (!sys) throw new AreaValidationError(`System ${sid} not found`);
    if (
      isAdmin ||
      sys.ownerClerkUserId === userId ||
      sys.ownerClerkUserId == null
    )
      continue;
    const [viewer] = await db
      .select({ systemId: userSystems.systemId })
      .from(userSystems)
      .where(
        and(eq(userSystems.clerkUserId, userId), eq(userSystems.systemId, sid)),
      )
      .limit(1);
    if (!viewer) throw new AreaAccessError(`No access to system ${sid}`);
  }
}

export interface CreateAreaInput {
  ownerClerkUserId: string;
  displayName: string;
  alias?: string | null;
  timezoneOffsetMin: number;
  displayTimezone: string;
  location?: AreaLocation | null;
  /** ≥1 member device systemIds; ordered → `area_devices.ordinal`. */
  memberSystemIds: number[];
}

/**
 * Create a multi-device (site) area with a freshly-allocated synthetic handle and its member rows, in
 * one transaction. Returns the area uuid + its integer addressing handle. Retries on a handle race
 * (`areas_legacy_system_unique`); surfaces an alias collision as `AreaAliasTakenError`.
 */
export async function createArea(
  input: CreateAreaInput,
): Promise<{ id: string; legacySystemId: number }> {
  const db = requirePlanetscaleDb();
  const id = uuidv7();
  const members = [...new Set(input.memberSystemIds)];

  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = await allocateAreaHandle(db);
    try {
      await db.transaction(async (tx) => {
        await tx.insert(areas).values({
          id,
          ownerClerkUserId: input.ownerClerkUserId,
          legacySystemId: handle,
          displayName: input.displayName,
          alias: input.alias ?? null,
          timezoneOffsetMin: input.timezoneOffsetMin,
          displayTimezone: input.displayTimezone,
          location: input.location ?? null,
          status: "active",
        });
        if (members.length > 0) {
          await tx.insert(areaDevices).values(
            members.map((systemId, i) => ({
              areaId: id,
              systemId,
              ordinal: i,
            })),
          );
        }
      });
      return { id, legacySystemId: handle };
    } catch (err) {
      const constraint = constraintOf(err);
      if (isUniqueViolation(err) && constraint === "areas_legacy_system_unique")
        continue; // lost a handle race — re-allocate
      if (isUniqueViolation(err) && constraint === "areas_owner_alias_unique")
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
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.alias !== undefined) set.alias = patch.alias;
  if (patch.timezoneOffsetMin !== undefined)
    set.timezoneOffsetMin = patch.timezoneOffsetMin;
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
    if (
      isUniqueViolation(err) &&
      constraintOf(err) === "areas_owner_alias_unique"
    )
      throw new AreaAliasTakenError();
    throw err;
  }
}

/** Add a member device (append at the next ordinal; idempotent on the PK). */
export async function addMember(
  areaId: string,
  systemId: number,
): Promise<void> {
  const db = requirePlanetscaleDb();
  const [{ maxOrd }] = await db
    .select({ maxOrd: max(areaDevices.ordinal) })
    .from(areaDevices)
    .where(eq(areaDevices.areaId, areaId));
  await db
    .insert(areaDevices)
    .values({ areaId, systemId, ordinal: (maxOrd ?? -1) + 1 })
    .onConflictDoNothing();
}

/**
 * Remove a member device and, in the same transaction, its now-orphaned bindings (so the resolver
 * never dereferences a point on a dropped member — the point_info FK guards nonexistent points but not
 * membership drift). Refuses to remove the last member.
 */
export async function removeMember(
  areaId: string,
  systemId: number,
): Promise<void> {
  const db = requirePlanetscaleDb();
  const members = await getAreaDeviceSystemIds(areaId);
  if (!members.includes(systemId)) return; // not a member — no-op
  if (members.length <= 1)
    throw new AreaValidationError("Cannot remove the last member of an area");
  await db.transaction(async (tx) => {
    await tx
      .delete(areaBindings)
      .where(
        and(
          eq(areaBindings.areaId, areaId),
          eq(areaBindings.pointSystemId, systemId),
        ),
      );
    await tx
      .delete(areaDevices)
      .where(
        and(eq(areaDevices.areaId, areaId), eq(areaDevices.systemId, systemId)),
      );
  });
}

export interface BindingInput {
  role: string;
  metricType: string;
  pointSystemId: number;
  pointId: number;
  transform?: string | null;
}

/** An area's current bindings, ordered by ordinal (the editor's GET). */
export async function getAreaBindingsForEditor(
  areaId: string,
): Promise<BindingInput[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      role: areaBindings.role,
      metricType: areaBindings.metricType,
      pointSystemId: areaBindings.pointSystemId,
      pointId: areaBindings.pointId,
      transform: areaBindings.transform,
    })
    .from(areaBindings)
    .where(eq(areaBindings.areaId, areaId))
    .orderBy(asc(areaBindings.ordinal));
  return rows;
}

/**
 * Replace ALL of an area's bindings with the given ordered list (ordinal = array index), in one
 * transaction. Validates each role is known, each point's system is a current member, and there are no
 * duplicate (role, metricType, pointSystemId, pointId) tuples. `metricType` comes from the chosen
 * point's `point_info.metric_type` (the caller sources it from `/api/system/[id]/points`).
 */
export async function replaceBindings(
  areaId: string,
  bindings: BindingInput[],
): Promise<void> {
  const members = new Set(await getAreaDeviceSystemIds(areaId));
  const seen = new Set<string>();
  for (const b of bindings) {
    if (!(b.role in ROLES))
      throw new AreaValidationError(`Unknown role: ${b.role}`);
    if (!b.metricType)
      throw new AreaValidationError("Each binding needs a metricType");
    if (!members.has(b.pointSystemId))
      throw new AreaValidationError(
        `System ${b.pointSystemId} is not a member of this area`,
      );
    const key = `${b.role}|${b.metricType}|${b.pointSystemId}|${b.pointId}`;
    if (seen.has(key))
      throw new AreaValidationError(`Duplicate binding: ${key}`);
    seen.add(key);
  }
  const db = requirePlanetscaleDb();
  await db.transaction(async (tx) => {
    await tx.delete(areaBindings).where(eq(areaBindings.areaId, areaId));
    if (bindings.length > 0) {
      await tx.insert(areaBindings).values(
        bindings.map((b, i) => ({
          areaId,
          role: b.role as RoleId,
          metricType: b.metricType,
          pointSystemId: b.pointSystemId,
          pointId: b.pointId,
          ordinal: i,
          transform: b.transform ?? null,
        })),
      );
    }
  });
}

/**
 * Refresh live serving after a membership/binding change: drop the in-memory point-series cache for
 * the handle and rebuild the KV subscription registry (which is derived from `area_bindings` +
 * binding-less members) so latest values propagate to the area. Best-effort — a missing/unconfigured
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
