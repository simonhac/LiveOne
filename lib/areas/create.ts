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
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  areaBindings,
  areaMembers,
  pointInfo,
  points,
  systems,
} from "@/lib/db/planetscale/schema";
import type { AreaConfig, AreaLocation } from "@/lib/areas/types";
import { Device, Point, type PointId } from "@/lib/ids";
import { ROLES, type RoleId } from "@/lib/roles/registry";
import { allocateAreaHandle } from "@/lib/areas/handles";
import { SystemsManager } from "@/lib/systems-manager";
import { PointManager } from "@/lib/point/point-manager";
import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { getLegacySystemIdForArea } from "@/lib/areas/resolve";
import { DeviceRegistry } from "@/lib/registry";
import { ensureDeviceRow } from "@/lib/registry/v4-mirror";
import { bindingShapeMatches } from "@/lib/areas/slots";
import { DeviceConfigRegistry } from "\@/lib/registry/device-config";

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
 * member is allowed when the caller can READ it (admin / owner / public-ownerless): you can only
 * aggregate data you can already see. (Read, not write: public grid-region systems — e.g. an
 * OpenElectricity NEM region — are legitimately added as members without owning them.)
 *
 * A fourth `user_systems` viewer-grant term was dropped with that table in migration 0045 (slice F).
 * This is the strict direction — a caller who could previously add a granted member now gets
 * `AreaAccessError` — which is the correct default for a firewall whose whole job is refusing
 * escalation.
 */
export async function assertMembersReadable(
  userId: string,
  isAdmin: boolean,
  systemIds: number[],
): Promise<void> {
  const sm = SystemsManager.getInstance();
  for (const sid of systemIds) {
    const sys = await DeviceConfigRegistry.deviceByHandle(sid);
    if (!sys) throw new AreaValidationError(`System ${sid} not found`);
    if (
      isAdmin ||
      sys.ownerClerkUserId === userId ||
      sys.ownerClerkUserId == null
    )
      continue;
    throw new AreaAccessError(`No access to system ${sid}`);
  }
}

export interface CreateAreaInput {
  ownerClerkUserId: string;
  displayName: string;
  alias?: string | null;
  timezoneOffsetMin: number;
  displayTimezone: string;
  location?: AreaLocation | null;
  /** ≥1 member device systemIds; ordered → `area_members.ordinal`. */
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
          // config-v4: the KEYS are the renamed `areas` columns; the VALUES still come from the
          // unchanged CreateAreaInput (renaming that input shape is elective → Phase 9).
          id,
          ownerUserId: input.ownerClerkUserId,
          legacySystemId: handle,
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
          // `area_members.device_id` is a hard FK, so each member's `devices` row must exist before its
          // membership row. `ensureDeviceRow` is idempotent and self-healing (slice A2), and rides this
          // tx — so a member whose device row was somehow missing is minted and joined atomically.
          // Sequential, not Promise.all: a drizzle tx is ONE pg client, so overlapping statements on it
          // are serialised anyway and only make the ordering harder to reason about.
          const deviceIds: string[] = [];
          for (const systemId of members) {
            deviceIds.push(await ensureDeviceRow(systemId, tx));
          }
          await tx.insert(areaMembers).values(
            deviceIds.map((deviceId, i) => ({
              areaId: id,
              deviceId,
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
    if (
      isUniqueViolation(err) &&
      constraintOf(err) === "areas_owner_alias_unique"
    )
      throw new AreaAliasTakenError();
    throw err;
  }
}

/**
 * Add a member device (append at the next ordinal; idempotent on the PK).
 *
 * The `max(ordinal)` read and the insert share a transaction: they were two round trips before, so two
 * concurrent adds could both read the same max and collide on the ordinal. `ensureDeviceRow` rides the
 * same tx because `area_members.device_id` is a hard FK.
 */
export async function addMember(
  areaId: string,
  systemId: number,
): Promise<void> {
  await requirePlanetscaleDb().transaction(async (tx) => {
    const deviceId = await ensureDeviceRow(systemId, tx);
    const [{ maxOrd }] = await tx
      .select({ maxOrd: max(areaMembers.ordinal) })
      .from(areaMembers)
      .where(eq(areaMembers.areaId, areaId));
    await tx
      .insert(areaMembers)
      .values({ areaId, deviceId, ordinal: (maxOrd ?? -1) + 1 })
      .onConflictDoNothing();
  });
}

/**
 * Remove a member device and, in the same transaction, its now-orphaned bindings (so the resolver
 * never dereferences a point on a dropped member — the `point_uid → points.id` FK guards nonexistent
 * points but not membership drift). Refuses to remove the last member.
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
  if (memberIds.length <= 1)
    throw new AreaValidationError("Cannot remove the last member of an area");
  const deviceUuid = Device.toUuid(target);
  await db.transaction(async (tx) => {
    // "Every binding whose point lives on the departing device", by uuid since slice E PR 2a.
    // `deviceUuid` is already in hand, so this addresses `points.device_id` DIRECTLY and needs no
    // `devices.rid` hop at all — one fewer legacy-id round trip than the predicate it replaces.
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
    await tx
      .delete(areaMembers)
      .where(
        and(
          eq(areaMembers.areaId, areaId),
          eq(areaMembers.deviceId, deviceUuid),
        ),
      );
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
 * An area's current bindings, ordered by ordinal (the editor's GET). Stated in `pt_` TypeIDs — the
 * same grammar the editor PUTs back, so the round trip is symmetric. `point_uid` is NOT NULL
 * (migration 0047), so the encode needs no non-null assertion.
 */
export async function getAreaBindingsForEditor(
  areaId: string,
): Promise<BindingInput[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      role: areaBindings.role,
      metricType: areaBindings.metricType,
      pointUid: areaBindings.pointUid,
      transform: areaBindings.transform,
    })
    .from(areaBindings)
    .where(eq(areaBindings.areaId, areaId))
    .orderBy(asc(areaBindings.ordinal));
  return rows.map(({ pointUid, ...r }) => ({
    ...r,
    pointId: Point.encode(pointUid),
  }));
}

/**
 * Replace ALL of an area's bindings with the given ordered list (ordinal = array index), in one
 * transaction. Validates each role is known, each point's owning device is a current member, and there
 * are no duplicate (role, metricType, pointId) tuples — the same triple `area_bindings_unique` enforces
 * since migration 0047. `metricType` comes from the chosen point's `point_info.metric_type` (the caller
 * sources it from `/api/system/[id]/points`).
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
            systemId: pointInfo.systemId,
            index: pointInfo.index,
            pointUid: pointInfo.pointUid,
            logicalPathStem: pointInfo.logicalPathStem,
            metricType: pointInfo.metricType,
          })
          .from(pointInfo)
          .where(inArray(pointInfo.pointUid, wantedUids));
  const pointByUid = new Map(pointRows.map((point) => [point.pointUid, point]));
  const nextPriority = new Map<string, number>();
  const seenPriorities = new Set<string>();
  // Collected in binding order so the INSERT can name `point_uid` without re-looking-up (and without a
  // non-null assertion — the loop below has already proven every point resolves).
  const resolvedUids: string[] = [];
  // The owning system of each resolved point, in binding order — read from `point_info`, not from the
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
  // resolved `point_info` row (the wire no longer names a system), so it stays an int `systems.id`
  // exactly as the `systems.config` lookup needs.
  const batteryIdx = bindings.findIndex(
    (binding) => binding.role === "battery" && binding.metricType === "power",
  );
  const selectedBatterySystemId =
    batteryIdx < 0 ? undefined : resolvedSystemIds[batteryIdx];

  await db.transaction(async (tx) => {
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
              .select({ config: systems.config })
              .from(systems)
              .where(eq(systems.id, selectedBatterySystemId))
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
