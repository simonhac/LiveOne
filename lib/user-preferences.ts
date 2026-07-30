import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { users as pgUsers } from "@/lib/db/planetscale/schema";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { Dashboard } from "@/lib/ids";

/**
 * User preferences (the `users` config table) — Postgres only.
 *
 * The default landing page is a composition **dashboard** (`default_dashboard_id` → `/dashboard/id/{id}`).
 * The legacy per-device default (`default_system_id`) was retired in P6: a device is no longer a
 * default target — you star a dashboard, and every area already has one.
 */

export interface UserPreferences {
  clerkUserId: string;
  defaultDashboardId: string | null; // dashboards.id (uuid)
  createdAt: Date;
  updatedAt: Date;
}

/** Get or create the user's preferences row (just-in-time creation). */
export async function getOrCreateUserPreferences(
  clerkUserId: string,
): Promise<UserPreferences> {
  const pg = requirePlanetscaleDb();

  const existing = await pg
    .select()
    .from(pgUsers)
    .where(eq(pgUsers.clerkUserId, clerkUserId))
    .limit(1);

  if (existing.length > 0) {
    return {
      clerkUserId: existing[0].clerkUserId,
      defaultDashboardId: existing[0].defaultDashboardId
        ? Dashboard.encode(existing[0].defaultDashboardId)
        : null,
      createdAt: existing[0].createdAt,
      updatedAt: existing[0].updatedAt,
    };
  }

  // Create new record (idempotent: a concurrent request may have created it).
  await pg
    .insert(pgUsers)
    .values({ clerkUserId })
    .onConflictDoNothing({ target: pgUsers.clerkUserId });
  const [newUser] = await pg
    .select()
    .from(pgUsers)
    .where(eq(pgUsers.clerkUserId, clerkUserId))
    .limit(1);
  return {
    clerkUserId: newUser.clerkUserId,
    defaultDashboardId: newUser.defaultDashboardId
      ? Dashboard.encode(newUser.defaultDashboardId)
      : null,
    createdAt: newUser.createdAt,
    updatedAt: newUser.updatedAt,
  };
}

/**
 * Write `default_dashboard_id` — the single source of truth for the landing page. `dashboardId` is the
 * opaque `db_…` id (decoded to the uuid PK for storage).
 */
async function writeDefaultDashboard(
  clerkUserId: string,
  dashboardId: string | null,
): Promise<void> {
  await requirePlanetscaleDb()
    .update(pgUsers)
    .set({
      defaultDashboardId: dashboardId
        ? Dashboard.toUuidOrNull(dashboardId)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(pgUsers.clerkUserId, clerkUserId));
}

/**
 * Set the user's default landing dashboard by its id. Owner-only. Lands the `/dashboard` redirect on
 * `/dashboard/id/{id}`.
 */
export async function setDefaultDashboardById(
  clerkUserId: string,
  dashboardId: string,
): Promise<{ success: boolean; error?: string }> {
  await getOrCreateUserPreferences(clerkUserId);
  const dash = await getDashboard(dashboardId);
  if (!dash) return { success: false, error: "not_found" };
  if (dash.ownerClerkUserId !== clerkUserId) {
    return { success: false, error: "Not your dashboard" };
  }
  await writeDefaultDashboard(clerkUserId, dashboardId);
  return { success: true };
}

/** Clear the user's default landing dashboard. Idempotent. */
export async function clearDefaultDashboard(
  clerkUserId: string,
): Promise<{ success: boolean; error?: string }> {
  await getOrCreateUserPreferences(clerkUserId);
  await writeDefaultDashboard(clerkUserId, null);
  return { success: true };
}

/**
 * The path the `/dashboard` landing should redirect to for this user's default, or null when there's
 * no valid default. Always a composition dashboard → `/dashboard/id/{id}`. Defensively auto-clears a
 * pointer whose dashboard has vanished (the FK is ON DELETE SET NULL, so this is belt-and-braces).
 */
export async function resolveDefaultDashboardRoute(
  clerkUserId: string,
): Promise<string | null> {
  const prefs = await getOrCreateUserPreferences(clerkUserId);
  if (prefs.defaultDashboardId == null) return null;
  const dash = await getDashboard(prefs.defaultDashboardId);
  if (!dash) {
    await writeDefaultDashboard(clerkUserId, null);
    return null;
  }
  // config-v4: dash.id is already the opaque `db_…` id (the DAO owns the uuid↔TypeID translation).
  return `/dashboard/id/${dash.id}`;
}
