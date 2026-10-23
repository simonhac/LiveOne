/**
 * Per-dashboard grants (P4): membership keyed by grantee clerk user id + role.
 *
 * A grant is the "invite a specific person" counterpart to the public `?access=` share token. Like a
 * token, a grant is READ-scoped to exactly what the dashboard shows — Dashboard → its Area(s) →
 * `area_bindings` → points (lib/dashboard/access.ts) — never general device access.
 *
 * One role per (dashboard, user) — the pair is the primary key:
 *  - `view`    read-only.
 *  - `control` `view`, plus the right to COMMAND the devices the dashboard shows that its OWNER owns
 *              (generator start/stop, EV charging). See {@link controllableDeviceScopeForUser}.
 *  - `admin`   plumbed for a future editable variant; today it conveys exactly `view`.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboardGrants } from "@/lib/db/planetscale/schema";
import type { DashboardGrant } from "@/lib/db/planetscale/schema";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { Dashboard } from "@/lib/ids";
import type { DashboardGrantRole } from "./grant-roles";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { ownsSubject } from "@/lib/control/ownership";

// config-v4: this module's public surface speaks the opaque `db_…` dashboard id; the raw uuid
// (dashboard_grants.dashboard_id) is decoded on the way into SQL and encoded on the way out.

/** The opaque `db_…` dashboard ids this user has been granted access to (uses dashboard_grants_user_idx). */
export async function listGrantsForUser(
  clerkUserId: string,
): Promise<string[]> {
  const rows = await requirePlanetscaleDb()
    .select({ dashboardId: dashboardGrants.dashboardId })
    .from(dashboardGrants)
    .where(eq(dashboardGrants.userId, clerkUserId));
  return rows.map((r) => Dashboard.encode(r.dashboardId));
}

/** A single (dashboard, user) membership, or null. The unique-index lookup used by the view route. */
export async function getGrant(
  dashboardId: string,
  clerkUserId: string,
): Promise<DashboardGrant | null> {
  const uuid = Dashboard.toUuidOrNull(dashboardId);
  if (!uuid) return null;
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(dashboardGrants)
    .where(
      and(
        eq(dashboardGrants.dashboardId, uuid),
        eq(dashboardGrants.userId, clerkUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** All members of a dashboard, for the manage-members UI (caller decorates with email/username). */
export async function listGrantsForDashboard(
  dashboardId: string,
): Promise<DashboardGrant[]> {
  const uuid = Dashboard.toUuidOrNull(dashboardId);
  if (!uuid) return [];
  return requirePlanetscaleDb()
    .select()
    .from(dashboardGrants)
    .where(eq(dashboardGrants.dashboardId, uuid));
}

/** One member of the target state handed to {@link replaceDashboardGrants}. */
export interface DashboardGrantInput {
  clerkUserId: string;
  role: DashboardGrantRole;
}

/** What a full replace actually did, by grantee. Every id appears in exactly one bucket. */
export interface GrantReplaceResult {
  added: string[];
  updated: string[]; // present before and after, role changed
  unchanged: string[]; // present before and after, same role
  removed: string[];
}

/**
 * Declarative FULL REPLACE of a dashboard's membership (clean-sheet §9.2: `PUT` = full replace —
 * the server diffs, applies transactionally, and returns the new state).
 *
 * 🛑 The delete is driven POSITIVELY. It deletes `inArray(user_id, <the ids computed to be leaving>)`
 * rather than `notInArray(user_id, <the ids staying>)`. Two reasons, and the second is the one that
 * bites:
 *
 *  1. `notInArray(col, [])` is a degenerate predicate — an empty keep-list is exactly the
 *     "remove everyone" case, i.e. the one where getting it wrong is most destructive.
 *  2. A negative predicate cannot be checked by the caller. The positive one is returned as
 *     `removed`, so an over-delete (a kept grantee vanishing) and an under-delete (a revoked grantee
 *     surviving) are both VISIBLE in the response instead of silent. Both failure modes look
 *     identical from a naive `{ok:true}`.
 *
 * Rows that stay are UPDATED in place, never deleted-and-reinserted, so a kept grantee's `created_at`
 * (and therefore "member since" in the UI) survives a replace that removes someone else.
 */
export async function replaceDashboardGrants(
  dashboardId: string,
  members: DashboardGrantInput[],
): Promise<GrantReplaceResult> {
  const uuid = Dashboard.toUuidOrNull(dashboardId);
  if (!uuid) throw new Error("invalid dashboard id");
  const wanted = new Map(members.map((m) => [m.clerkUserId, m.role]));
  if (wanted.size !== members.length) {
    throw new Error("replaceDashboardGrants: duplicate grantee");
  }
  return requirePlanetscaleDb().transaction(async (tx) => {
    const current = await tx
      .select({ userId: dashboardGrants.userId, role: dashboardGrants.role })
      .from(dashboardGrants)
      .where(eq(dashboardGrants.dashboardId, uuid));
    const before = new Map(current.map((r) => [r.userId, r.role]));

    const removed = current
      .filter((r) => !wanted.has(r.userId))
      .map((r) => r.userId);
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    for (const [userId, role] of wanted) {
      const was = before.get(userId);
      if (was === undefined) added.push(userId);
      else if (was !== role) updated.push(userId);
      else unchanged.push(userId);
    }

    if (removed.length > 0) {
      await tx
        .delete(dashboardGrants)
        .where(
          and(
            eq(dashboardGrants.dashboardId, uuid),
            inArray(dashboardGrants.userId, removed),
          ),
        );
    }
    if (members.length > 0) {
      await tx
        .insert(dashboardGrants)
        .values(
          members.map((m) => ({
            dashboardId: uuid,
            userId: m.clerkUserId,
            role: m.role,
            createdAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [dashboardGrants.dashboardId, dashboardGrants.userId],
          // `excluded.role` — the row we tried to insert. `created_at` is deliberately NOT in the SET,
          // so a re-stated member keeps their original join date.
          set: { role: sql`excluded.role` },
        });
    }
    return { added, updated, unchanged, removed };
  });
}

/**
 * The union of device handles this user may READ via their grants — `allowedSystemIds` across every
 * dashboard they're granted. The read-scope enforced in `requireDashboardAccess` (a grant on a
 * dashboard implies read access to the devices that dashboard's data shows, nothing more).
 */
export async function grantedDeviceScopeForUser(
  clerkUserId: string,
): Promise<Set<number>> {
  const dashboardIds = await listGrantsForUser(clerkUserId);
  const scope = new Set<number>();
  for (const id of dashboardIds) {
    const dash = await getDashboard(id);
    if (!dash) continue;
    const allowed = await allowedSystemIds({ doc: dash.doc });
    for (const sid of allowed) scope.add(sid);
  }
  return scope;
}

/**
 * The device handles this user may COMMAND via their `control` grants.
 *
 * 🛑 Two conditions, and the second is the one that matters: the device is in a `control`-granted
 * dashboard's read scope, AND it is owned by THAT DASHBOARD'S OWNER. Commands run on the device
 * owner's stored vendor credentials (`lib/control/ownership.ts`), so only the owner can delegate
 * them — referencing someone else's (or an ownerless) device in your own dashboard grants nothing.
 *
 * Grant-scoped live, like the read scope: removing a device from the dashboard, or downgrading the
 * grant to `view`, withdraws control on the next request.
 */
export async function controllableDeviceScopeForUser(
  clerkUserId: string,
): Promise<Set<number>> {
  const rows = await requirePlanetscaleDb()
    .select({ dashboardId: dashboardGrants.dashboardId })
    .from(dashboardGrants)
    .where(
      and(
        eq(dashboardGrants.userId, clerkUserId),
        eq(dashboardGrants.role, "control"),
      ),
    );
  const scope = new Set<number>();
  for (const { dashboardId } of rows) {
    const dash = await getDashboard(Dashboard.encode(dashboardId));
    if (!dash) continue;
    for (const handle of await allowedSystemIds({ doc: dash.doc })) {
      const device = await DeviceConfigRegistry.deviceByHandle(handle);
      if (device && ownsSubject(dash.ownerClerkUserId, device.ownerClerkUserId))
        scope.add(handle);
    }
  }
  return scope;
}
