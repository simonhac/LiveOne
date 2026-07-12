/**
 * Per-dashboard grants (P4): membership keyed by grantee clerk user id + role.
 *
 * A grant is the "invite a specific person" counterpart to the public `?access=` share token. Like a
 * token, a grant is READ-scoped to exactly what the dashboard shows — Dashboard → its Area(s) →
 * `area_bindings` → points (lib/dashboard/access.ts) — never general system access. role ∈
 * owner|admin|viewer; today invites are viewer (read-only) and `role` is plumbed for a future
 * editable variant.
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboardGrants } from "@/lib/db/planetscale/schema";
import type { DashboardGrant } from "@/lib/db/planetscale/schema";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";

export type DashboardGrantRole = "owner" | "admin" | "viewer";

/** The dashboard ids this user has been granted access to (uses dashboard_grants_user_idx). */
export async function listGrantsForUser(
  clerkUserId: string,
): Promise<number[]> {
  const rows = await requirePlanetscaleDb()
    .select({ dashboardId: dashboardGrants.dashboardId })
    .from(dashboardGrants)
    .where(eq(dashboardGrants.clerkUserId, clerkUserId));
  return rows.map((r) => r.dashboardId);
}

/** A single (dashboard, user) membership, or null. The unique-index lookup used by the view route. */
export async function getGrant(
  dashboardId: number,
  clerkUserId: string,
): Promise<DashboardGrant | null> {
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(dashboardGrants)
    .where(
      and(
        eq(dashboardGrants.dashboardId, dashboardId),
        eq(dashboardGrants.clerkUserId, clerkUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Add (or re-role) a member on a dashboard. Upserts on the (dashboardId, clerkUserId) unique index. */
export async function createGrant(args: {
  dashboardId: number;
  clerkUserId: string;
  role: DashboardGrantRole;
}): Promise<void> {
  await requirePlanetscaleDb()
    .insert(dashboardGrants)
    .values({
      dashboardId: args.dashboardId,
      clerkUserId: args.clerkUserId,
      role: args.role,
      createdAtMs: Date.now(),
    })
    .onConflictDoUpdate({
      target: [dashboardGrants.dashboardId, dashboardGrants.clerkUserId],
      set: { role: args.role },
    });
}

/** All members of a dashboard, for the manage-members UI (caller decorates with email/username). */
export async function listGrantsForDashboard(
  dashboardId: number,
): Promise<DashboardGrant[]> {
  return requirePlanetscaleDb()
    .select()
    .from(dashboardGrants)
    .where(eq(dashboardGrants.dashboardId, dashboardId));
}

/** Remove one membership. Returns true if a row was deleted. */
export async function revokeGrant(
  dashboardId: number,
  clerkUserId: string,
): Promise<boolean> {
  const result = await requirePlanetscaleDb()
    .delete(dashboardGrants)
    .where(
      and(
        eq(dashboardGrants.dashboardId, dashboardId),
        eq(dashboardGrants.clerkUserId, clerkUserId),
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
    const allowed = await allowedSystemIds({ descriptor: dash.descriptor });
    for (const sid of allowed) scope.add(sid);
  }
  return scope;
}
