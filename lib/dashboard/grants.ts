/**
 * Per-dashboard grants (P4): membership keyed by grantee clerk user id + role.
 *
 * A grant is the "invite a specific person" counterpart to the public `?access=` share token. Like a
 * token, a grant is READ-scoped to exactly what the dashboard shows — Dashboard → its Area(s) →
 * `area_bindings` → points (lib/dashboard/access.ts) — never general system access. role ∈
 * admin|viewer (config-v4 narrowed away `owner`); today invites are viewer (read-only) and `role`
 * is plumbed for a future editable variant.
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboardGrants } from "@/lib/db/planetscale/schema";
import type { DashboardGrant } from "@/lib/db/planetscale/schema";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { Dashboard } from "@/lib/ids";

export type DashboardGrantRole = "admin" | "viewer";

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

/** Add (or re-role) a member on a dashboard. Upserts on the (dashboardId, clerkUserId) unique index. */
export async function createGrant(args: {
  dashboardId: string;
  clerkUserId: string;
  role: DashboardGrantRole;
}): Promise<void> {
  const uuid = Dashboard.toUuidOrNull(args.dashboardId);
  if (!uuid) return;
  await requirePlanetscaleDb()
    .insert(dashboardGrants)
    .values({
      dashboardId: uuid,
      userId: args.clerkUserId,
      role: args.role,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [dashboardGrants.dashboardId, dashboardGrants.userId],
      set: { role: args.role },
    });
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

/** Remove one membership. Returns true if a row was deleted. */
export async function revokeGrant(
  dashboardId: string,
  clerkUserId: string,
): Promise<boolean> {
  const uuid = Dashboard.toUuidOrNull(dashboardId);
  if (!uuid) return false;
  const result = await requirePlanetscaleDb()
    .delete(dashboardGrants)
    .where(
      and(
        eq(dashboardGrants.dashboardId, uuid),
        eq(dashboardGrants.userId, clerkUserId),
      ),
    )
    .returning();
  return result.length > 0;
}

/**
 * The union of system handles this user may READ via their grants — `allowedSystemIds` across every
 * dashboard they're granted. The read-scope enforced in `requireDashboardAccess` (a grant on a
 * dashboard implies read access to the systems that dashboard's data shows, nothing more).
 */
export async function grantedSystemScopeForUser(
  clerkUserId: string,
): Promise<Set<number>> {
  const dashboardIds = await listGrantsForUser(clerkUserId);
  const scope = new Set<number>();
  for (const id of dashboardIds) {
    const dash = await getDashboard(id);
    if (!dash) continue;
    const allowed = await allowedSystemIds({
      descriptor: dash.descriptor,
      doc: dash.doc,
    });
    for (const sid of allowed) scope.add(sid);
  }
  return scope;
}
