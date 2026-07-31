/**
 * Per-dashboard grants (P4): membership keyed by grantee clerk user id + role.
 *
 * A grant is the "invite a specific person" counterpart to the public `?access=` share token. Like a
 * token, a grant is READ-scoped to exactly what the dashboard shows — Dashboard → its Area(s) →
 * `area_bindings` → points (lib/dashboard/access.ts) — never general device access. role ∈
 * admin|viewer (config-v4 narrowed away `owner`); today invites are viewer (read-only) and `role`
 * is plumbed for a future editable variant.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
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
