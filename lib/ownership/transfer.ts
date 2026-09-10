/**
 * Ownership transfer, with share-back, as ONE transaction.
 *
 * ## Why this is a single operation and not two calls
 *
 * Readability is DERIVED, not stored. `requireDeviceAccess` reads
 * `isAdmin || isOwner || isPublic` — the per-device viewer grant died with `user_systems` in
 * migration 0045 — so a non-admin, non-owner reaches a device only through a dashboard GRANT whose
 * doc references it (`grantedDeviceScopeForUser`). Ownership is therefore the thing that carries
 * access, and handing it over is the moment access disappears.
 *
 * That makes "transfer, then share back" a sequence with a hole in the middle. Worse, granting is
 * itself an owner-side mutation, so the obvious ordering — transfer first — can leave the previous
 * owner unable to perform the second half of their own plan. Doing both in one transaction removes
 * the ordering question entirely: either the new owner owns it AND the share-back exists, or
 * nothing moved.
 *
 * ## The check that makes it safe rather than merely atomic
 *
 * Atomicity alone would happily commit a transfer whose share-back grants nothing — for example
 * moving a DEVICE while naming no dashboard that references it. The caller would get a clean 200
 * and silently lose access to their own data. So this refuses any transfer after which a named
 * share-back recipient could NOT read every device being moved, and says which devices those are.
 *
 * 🛑 The check runs BEFORE the write, deliberately. It is a prediction, and it is exactly as
 * accurate as a post-check would be: the post-state depends only on the grants being written (known
 * here), the docs of the dashboards those grants are on (unchanged by this operation), and which
 * devices are moving (known here). A post-check would additionally have to re-implement
 * `allowedSystemIds` against the open transaction, since the existing helper reads through the
 * pool and would not see uncommitted rows.
 */
import { eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  dashboardGrants,
  dashboards,
  devices,
} from "@/lib/db/planetscale/schema";
import { Area, Dashboard, Device } from "@/lib/ids";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { listGrantsForUser } from "@/lib/dashboard/grants";

export type GrantRole = "admin" | "viewer";

export interface ShareBack {
  userId: string;
  role: GrantRole;
}

export interface TransferRequest {
  /** Clerk id of the new owner. */
  toUserId: string;
  /** `dv_…` ids. */
  deviceIds: string[];
  /** `ar_…` ids. */
  areaIds: string[];
  /** `db_…` ids. */
  dashboardIds: string[];
  /** Users who must retain access afterwards, granted on every dashboard in the set. */
  shareBack: ShareBack[];
  /**
   * Proceed even if a share-back recipient would lose read access to a transferred device. Never
   * defaulted on: the whole point of the check is that the loss is otherwise invisible.
   */
  force?: boolean;
}

/** One moved object, as `TransferResult.transferred` carries it. */
interface TransferredObject {
  kind: "device" | "area" | "dashboard";
  /** The object's TypeID (`dv_`/`ar_`/`db_`) as the wire carries it — branded at the source. */
  id: string;
  /** `dashboards.name` is nullable, so this is too — an unnamed dashboard still transfers. */
  name: string | null;
  fromUserId: string | null;
  toUserId: string;
}

export interface TransferResult {
  transferred: TransferredObject[];
  grantsWritten: Array<{
    dashboardId: string;
    userId: string;
    role: GrantRole;
  }>;
  /** Populated only when `force` carried the operation past the access check. */
  warnings: string[];
}

export class TransferError extends Error {
  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TransferError";
  }
}

/** Decode a batch of TypeIDs, naming the first bad one rather than failing anonymously. */
function decodeAll(
  kind: "device" | "area" | "dashboard",
  ids: string[],
  decode: (id: string) => string | null,
): string[] {
  return ids.map((id) => {
    const uuid = decode(id);
    if (!uuid) throw new TransferError(`not a valid ${kind} id: ${id}`);
    return uuid;
  });
}

/**
 * Would `userId` be able to read every one of `deviceHandles` once `extraDashboards` are granted?
 *
 * Mirrors `grantedDeviceScopeForUser`, plus the dashboards this transfer is about to grant. Platform
 * admins are not special-cased here on purpose — an admin CAN read everything, but relying on that
 * would make the check pass for the one operator whose access is least at risk while leaving the
 * warning off for everyone else. The caller decides what to do with an admin.
 */
async function readableDeviceHandles(
  userId: string,
  extraDashboardUuids: string[],
): Promise<Set<number>> {
  const existing = await listGrantsForUser(userId);
  const all = new Set<string>([
    ...existing.map((id) => Dashboard.toUuidOrNull(id) ?? id),
    ...extraDashboardUuids,
  ]);
  const scope = new Set<number>();
  for (const uuid of all) {
    const [row] = await requirePlanetscaleDb()
      .select({ doc: dashboards.doc })
      .from(dashboards)
      .where(eq(dashboards.id, uuid))
      .limit(1);
    if (!row?.doc) continue;
    for (const sid of await allowedSystemIds({ doc: row.doc as never }))
      scope.add(sid);
  }
  return scope;
}

/** `["user_x", {userId,role}]` → one shape. A bare id means viewer, the least it can mean. */
export function parseShareBack(
  raw: unknown,
  fallback: GrantRole,
): ShareBack[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: ShareBack[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push({ userId: entry, role: fallback });
      continue;
    }
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (typeof e.userId !== "string") return null;
      const role = e.role === undefined ? fallback : e.role;
      if (role !== "viewer" && role !== "admin") return null;
      out.push({ userId: e.userId, role });
      continue;
    }
    return null;
  }
  return out;
}

export function parseIdList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string"))
    return null;
  return raw as string[];
}

export async function transferOwnership(
  req: TransferRequest,
): Promise<TransferResult> {
  const deviceUuids = decodeAll("device", req.deviceIds, Device.toUuidOrNull);
  const areaUuids = decodeAll("area", req.areaIds, Area.toUuidOrNull);
  const dashUuids = decodeAll(
    "dashboard",
    req.dashboardIds,
    Dashboard.toUuidOrNull,
  );

  if (!deviceUuids.length && !areaUuids.length && !dashUuids.length)
    throw new TransferError("nothing to transfer");

  const db = requirePlanetscaleDb();

  // Read the current state first, so the result can state what actually moved rather than echoing
  // the request. A caller that names something already owned by the target learns that.
  const deviceRows = deviceUuids.length
    ? await db
        .select({
          id: devices.id,
          rid: devices.rid,
          name: devices.name,
          ownerUserId: devices.ownerUserId,
        })
        .from(devices)
        .where(inArray(devices.id, deviceUuids))
    : [];
  const areaRows = areaUuids.length
    ? await db
        .select({
          id: areas.id,
          name: areas.name,
          ownerUserId: areas.ownerUserId,
        })
        .from(areas)
        .where(inArray(areas.id, areaUuids))
    : [];
  const dashRows = dashUuids.length
    ? await db
        .select({
          id: dashboards.id,
          name: dashboards.name,
          ownerUserId: dashboards.ownerUserId,
        })
        .from(dashboards)
        .where(inArray(dashboards.id, dashUuids))
    : [];

  const missing = [
    ...deviceUuids.filter((u) => !deviceRows.some((r) => r.id === u)),
    ...areaUuids.filter((u) => !areaRows.some((r) => r.id === u)),
    ...dashUuids.filter((u) => !dashRows.some((r) => r.id === u)),
  ];
  if (missing.length)
    throw new TransferError(`${missing.length} object(s) named do not exist`, {
      missing,
    });

  // ---- the access check -------------------------------------------------
  //
  // 🛑 Devices are what carries data access, so they are what has to remain readable. An area or a
  // dashboard moving is recoverable by an admin; a device moving with no dashboard to see it
  // through is how someone loses sight of their own site.
  const warnings: string[] = [];
  if (deviceRows.length && req.shareBack.length) {
    const movingHandles = new Set(deviceRows.map((r) => r.rid));
    for (const sb of req.shareBack) {
      const readable = await readableDeviceHandles(sb.userId, dashUuids);
      const lost = [...movingHandles].filter((h) => !readable.has(h));
      if (!lost.length) continue;
      const names = deviceRows
        .filter((r) => lost.includes(r.rid))
        .map((r) => `${r.name} (${r.rid})`);
      const msg =
        `${sb.userId} would NOT be able to read ${lost.length} transferred device(s): ` +
        `${names.join(", ")}. No dashboard in this transfer references them, and no dashboard ` +
        `they are already granted on does either.`;
      if (!req.force)
        throw new TransferError(msg, {
          code: "share-back-would-not-restore-access",
          userId: sb.userId,
          devices: names,
        });
      warnings.push(msg);
    }
  }
  if (deviceRows.length && !req.shareBack.length)
    warnings.push(
      `${deviceRows.length} device(s) transferred with no share-back — only the new owner and ` +
        `platform admins will be able to read them.`,
    );

  // ---- the write --------------------------------------------------------
  const now = new Date();
  const grantsWritten: TransferResult["grantsWritten"] = [];

  await db.transaction(async (tx) => {
    if (deviceUuids.length)
      await tx
        .update(devices)
        .set({ ownerUserId: req.toUserId, updatedAt: now })
        .where(inArray(devices.id, deviceUuids));
    if (areaUuids.length)
      await tx
        .update(areas)
        .set({ ownerUserId: req.toUserId, updatedAt: now })
        .where(inArray(areas.id, areaUuids));
    if (dashUuids.length)
      await tx
        .update(dashboards)
        .set({ ownerUserId: req.toUserId, updatedAt: now })
        .where(inArray(dashboards.id, dashUuids));

    // 🛑 An INSERT, never a replace. `PUT …/grants` is declarative full-replace, and reusing that
    // shape here would delete every OTHER member of a dashboard as a side effect of transferring
    // it — a silent eviction nobody asked for.
    for (const uuid of dashUuids)
      for (const sb of req.shareBack) {
        // The new owner does not need a grant, and `dashboard_grants` is keyed (dashboard, user):
        // granting them would be a redundant row that outlives the ownership it duplicates.
        if (sb.userId === req.toUserId) continue;
        await tx
          .insert(dashboardGrants)
          .values({
            dashboardId: uuid,
            userId: sb.userId,
            role: sb.role,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [dashboardGrants.dashboardId, dashboardGrants.userId],
            set: { role: sb.role },
          });
        grantsWritten.push({
          dashboardId: Dashboard.encode(uuid),
          userId: sb.userId,
          role: sb.role,
        });
      }
  });

  const transferred: TransferredObject[] = [
    ...deviceRows.map((r) => ({
      kind: "device" as const,
      id: Device.encode(r.id),
      name: r.name,
      fromUserId: r.ownerUserId,
      toUserId: req.toUserId,
    })),
    ...areaRows.map((r) => ({
      kind: "area" as const,
      id: Area.encode(r.id),
      name: r.name,
      fromUserId: r.ownerUserId,
      toUserId: req.toUserId,
    })),
    ...dashRows.map((r) => ({
      kind: "dashboard" as const,
      id: Dashboard.encode(r.id),
      name: r.name,
      fromUserId: r.ownerUserId,
      toUserId: req.toUserId,
    })),
  ];

  return { transferred, grantsWritten, warnings };
}
