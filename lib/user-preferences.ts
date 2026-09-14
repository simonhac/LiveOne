import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas as pgAreas,
  users as pgUsers,
} from "@/lib/db/planetscale/schema";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { dashboardHref } from "@/lib/dashboard/href";
import { Area, Dashboard } from "@/lib/ids";

/**
 * User preferences (the `users` config table) — Postgres only.
 *
 * The default landing page is a composition **dashboard** (`default_dashboard_id` → `/dashboard/{id}`).
 * The legacy per-device default (`default_system_id`) was retired in P6: a device is no longer a
 * default target — you star a dashboard, and every area already has one.
 *
 * The SECOND default (`default_area_id`, migration 0073) is unrelated to landing: it is where a
 * newly onboarded device is PLACED, and it exists because retiring the eagerly-minted area-of-one
 * removed the structural answer to that question (`lib/areas/onboarding.ts`). It self-populates
 * from a user's first area, which is enough for a new account and nothing at all for an existing
 * one — an owner who already has several areas never gets a default written for them, because
 * guessing which of their sites a new inverter belongs to would be worse than asking. So it is
 * settable here.
 */

export interface UserPreferences {
  clerkUserId: string;
  defaultDashboardId: string | null; // dashboards.id (uuid)
  /** `areas.id` (uuid) — where a newly onboarded device of this user's is placed. */
  defaultAreaId: string | null;
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
      defaultAreaId: existing[0].defaultAreaId
        ? Area.encode(existing[0].defaultAreaId)
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
    defaultAreaId: newUser.defaultAreaId
      ? Area.encode(newUser.defaultAreaId)
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

/**
 * Set (or clear, with `null`) the area a newly onboarded device of this user's is placed in.
 *
 * Owner-only, and re-checked here rather than trusted from the wire: the area is where the next
 * device this user connects will LAND, so pointing it at somebody else's site would place their
 * device in it. `status` is checked too — `resolveOnboardingArea` treats an archived default as
 * absent, so accepting one would be accepting something that silently does nothing.
 */
export async function setDefaultArea(
  clerkUserId: string,
  areaId: string | null,
): Promise<{ success: boolean; error?: string }> {
  await getOrCreateUserPreferences(clerkUserId);
  let uuid: string | null = null;
  if (areaId !== null) {
    uuid = Area.toUuidOrNull(areaId);
    if (!uuid) return { success: false, error: "not_found" };
    const [area] = await requirePlanetscaleDb()
      .select({ owner: pgAreas.ownerUserId, status: pgAreas.status })
      .from(pgAreas)
      .where(eq(pgAreas.id, uuid))
      .limit(1);
    // Unknown and not-yours collapse into one answer, as everywhere else: a well-formed `ar_`
    // string is not permission to learn whether it names anything.
    if (!area || area.owner !== clerkUserId)
      return { success: false, error: "not_found" };
    if (area.status !== "active")
      return { success: false, error: "That area is not active" };
  }
  await requirePlanetscaleDb()
    .update(pgUsers)
    .set({ defaultAreaId: uuid, updatedAt: new Date() })
    .where(eq(pgUsers.clerkUserId, clerkUserId));
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
 * no valid default. Always a composition dashboard — pretty `/dashboard/{user}/{slug}` when the dash
 * is slugged and owned by the user (defaults always are; `setDefaultDashboard` enforces ownership),
 * else `/dashboard/{db_…}`. Defensively auto-clears a pointer whose dashboard has vanished (the FK
 * is ON DELETE SET NULL, so this is belt-and-braces).
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
  return dashboardHref({
    id: dash.id,
    slug: dash.alias,
    ownerUsername:
      dash.alias && dash.ownerClerkUserId === clerkUserId
        ? await resolveOwnUsername(clerkUserId)
        : null,
  });
}

/** The user's own Clerk username, or null (no username set / Clerk unreachable → id-form links). */
async function resolveOwnUsername(clerkUserId: string): Promise<string | null> {
  try {
    const clerk = await clerkClient();
    return (await clerk.users.getUser(clerkUserId)).username ?? null;
  } catch {
    return null;
  }
}
