import { eq, and, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  users as pgUsers,
  systems as pgSystems,
  userSystems as pgUserSystems,
  dashboards,
} from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import {
  getDashboardById,
  getOrCreateDefaultDashboardId,
} from "@/lib/dashboard/store";
import { getDashboard } from "@/lib/dashboard/dashboards";

/**
 * User preferences (users + user_systems config tables) — Postgres only.
 */

export interface UserPreferences {
  clerkUserId: string;
  defaultSystemId: number | null;
  defaultDashboardId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get or create user preferences record (just-in-time creation).
 */
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
      defaultSystemId: existing[0].defaultSystemId,
      defaultDashboardId: existing[0].defaultDashboardId,
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
    defaultSystemId: newUser.defaultSystemId,
    defaultDashboardId: newUser.defaultDashboardId,
    createdAt: newUser.createdAt,
    updatedAt: newUser.updatedAt,
  };
}

/**
 * Check if a user has access to a system (owned or shared).
 */
export async function userHasSystemAccess(
  clerkUserId: string,
  systemId: number,
): Promise<boolean> {
  const pg = requirePlanetscaleDb();

  const [system] = await pg
    .select()
    .from(pgSystems)
    .where(eq(pgSystems.id, systemId))
    .limit(1);

  if (!system) {
    return false;
  }

  if (system.ownerClerkUserId === clerkUserId) {
    return true;
  }

  const sharedAccess = await pg
    .select()
    .from(pgUserSystems)
    .where(
      and(
        eq(pgUserSystems.clerkUserId, clerkUserId),
        eq(pgUserSystems.systemId, systemId),
      ),
    )
    .limit(1);

  return sharedAccess.length > 0;
}

/**
 * Check if a system is valid for being set as a default (exists, active, user has access).
 */
async function isSystemValidForDefault(
  clerkUserId: string,
  systemId: number,
): Promise<{ valid: boolean; reason?: string }> {
  const pg = requirePlanetscaleDb();

  const [system] = await pg
    .select()
    .from(pgSystems)
    .where(eq(pgSystems.id, systemId))
    .limit(1);

  if (!system) {
    return { valid: false, reason: "System not found" };
  }

  if (system.status !== "active") {
    return { valid: false, reason: "System is not active" };
  }

  const hasAccess = await userHasSystemAccess(clerkUserId, systemId);
  if (!hasAccess) {
    return { valid: false, reason: "No access to this system" };
  }

  return { valid: true };
}

/**
 * Set the user's default landing dashboard by SYSTEM id (single-area UX: one dashboard per system).
 * Resolves/creates that system's dashboard via getOrCreateDefaultDashboardId, validating access +
 * active status first, then writes BOTH default_dashboard_id (forward-correct) and default_system_id
 * (legacy fallback, kept in sync). Pass null to clear both.
 */
export async function setDefaultDashboard(
  clerkUserId: string,
  systemId: number | null,
): Promise<{ success: boolean; error?: string }> {
  await getOrCreateUserPreferences(clerkUserId);

  if (systemId === null) {
    await writeDefaults(clerkUserId, { dashboardId: null, systemId: null });
    return { success: true };
  }

  const validation = await isSystemValidForDefault(clerkUserId, systemId);
  if (!validation.valid) {
    return { success: false, error: validation.reason };
  }

  // vendorType is required by getOrCreateDefaultDashboardId; SystemsManager resolves composites to
  // their synthesized "composite" system.
  const system = await SystemsManager.getInstance().getSystem(systemId);
  if (!system) {
    return { success: false, error: "System not found" };
  }

  const dashboardId = await getOrCreateDefaultDashboardId(
    clerkUserId,
    systemId,
    system.vendorType,
  );
  await writeDefaults(clerkUserId, { dashboardId, systemId });
  return { success: true };
}

/**
 * Set the user's default landing dashboard to a COMPOSITION-first dashboard (Phase 2b-2) by its id.
 * Owner-only. Writes default_dashboard_id with a null default_system_id (composition dashboards have
 * no home system), so the landing redirects to `/dashboard/id/{id}` rather than a system.
 */
export async function setDefaultDashboardById(
  clerkUserId: string,
  dashboardId: number,
): Promise<{ success: boolean; error?: string }> {
  await getOrCreateUserPreferences(clerkUserId);
  const dash = await getDashboard(dashboardId);
  if (!dash) return { success: false, error: "not_found" };
  if (dash.ownerClerkUserId !== clerkUserId) {
    return { success: false, error: "Not your dashboard" };
  }
  // Must be a composition dashboard (which always has a display_name). Refuse a legacy per-system
  // dashboard here — its default is set via setDefaultSystem so default_system_id stays in sync;
  // writing default_system_id=null for it would drift the two columns.
  if (dash.displayName == null) {
    return { success: false, error: "Not a composition dashboard" };
  }
  await writeDefaults(clerkUserId, { dashboardId, systemId: null });
  return { success: true };
}

/**
 * Set both default columns in one UPDATE so default_dashboard_id (source of truth) and the legacy
 * default_system_id fallback never drift. The shared body of the set + clear + lazy-migrate paths.
 */
async function writeDefaults(
  clerkUserId: string,
  {
    dashboardId,
    systemId,
  }: { dashboardId: number | null; systemId: number | null },
): Promise<void> {
  await requirePlanetscaleDb()
    .update(pgUsers)
    .set({
      defaultDashboardId: dashboardId,
      defaultSystemId: systemId,
      updatedAt: new Date(),
    })
    .where(eq(pgUsers.clerkUserId, clerkUserId));
}

/**
 * Resolve the user's valid default landing target as { dashboardId, systemId }, or null. Source of
 * truth is default_dashboard_id; falls back to (and lazily migrates) the legacy default_system_id.
 * Validates the resolved system is still active + accessible, auto-clearing an invalid default.
 */
export async function getValidDefaultDashboardId(
  clerkUserId: string,
): Promise<{ dashboardId: number; systemId: number } | null> {
  const prefs = await getOrCreateUserPreferences(clerkUserId);

  // Path A — forward-correct column is set.
  if (prefs.defaultDashboardId != null) {
    const dash = await getDashboardById(prefs.defaultDashboardId);
    if (!dash) {
      await writeDefaults(clerkUserId, { dashboardId: null, systemId: null });
      return null;
    }
    // A composition-first default (Phase 2b-2, null system_id) has no legacy systemId to redirect to;
    // the new id/alias landing resolves it directly. This legacy resolver yields null for it.
    if (dash.systemId == null) return null;
    const validation = await isSystemValidForDefault(
      clerkUserId,
      dash.systemId,
    );
    if (!validation.valid) {
      await writeDefaults(clerkUserId, { dashboardId: null, systemId: null });
      return null;
    }
    return { dashboardId: dash.id, systemId: dash.systemId };
  }

  // Path B — lazy migration from legacy default_system_id.
  if (prefs.defaultSystemId != null) {
    const systemId = prefs.defaultSystemId;
    const validation = await isSystemValidForDefault(clerkUserId, systemId);
    if (!validation.valid) {
      await writeDefaults(clerkUserId, { dashboardId: null, systemId: null });
      return null;
    }
    const system = await SystemsManager.getInstance().getSystem(systemId);
    if (!system) {
      await writeDefaults(clerkUserId, { dashboardId: null, systemId: null });
      return null;
    }
    const dashboardId = await getOrCreateDefaultDashboardId(
      clerkUserId,
      systemId,
      system.vendorType,
    );
    await writeDefaults(clerkUserId, { dashboardId, systemId });
    return { dashboardId, systemId };
  }

  return null;
}

/**
 * The path the `/dashboard` landing should redirect to for this user's default, or null when there's
 * no valid default. A composition-first default (Phase 2b-2, null system_id) → `/dashboard/id/{id}`;
 * otherwise the legacy per-system default → `/dashboard/{systemId}` (validated + lazily migrated +
 * auto-cleared by getValidDefaultDashboardId).
 */
export async function resolveDefaultDashboardRoute(
  clerkUserId: string,
): Promise<string | null> {
  const prefs = await getOrCreateUserPreferences(clerkUserId);
  if (prefs.defaultDashboardId != null) {
    const dash = await getDashboardById(prefs.defaultDashboardId);
    if (dash && dash.systemId == null) return `/dashboard/id/${dash.id}`;
  }
  const sys = await getValidDefaultDashboardId(clerkUserId);
  return sys ? `/dashboard/${sys.systemId}` : null;
}

/**
 * Set user's default system. Thin wrapper over setDefaultDashboard (single-area UX: a default system
 * IS its dashboard today). Kept so existing callers (preferences API, settings dialog) are unchanged.
 */
export async function setDefaultSystem(
  clerkUserId: string,
  systemId: number | null,
): Promise<{ success: boolean; error?: string }> {
  return setDefaultDashboard(clerkUserId, systemId);
}

/**
 * Get user's valid default system ID. Thin wrapper over getValidDefaultDashboardId (returns just the
 * system id for the home-page redirect, which still routes to /dashboard/{systemId}).
 */
export async function getValidDefaultSystemId(
  clerkUserId: string,
): Promise<number | null> {
  return (await getValidDefaultDashboardId(clerkUserId))?.systemId ?? null;
}

/** The dashboard ids belonging to a system — the rows a system-removal must clear a default off. */
async function dashboardIdsForSystem(systemId: number): Promise<number[]> {
  const rows = await requirePlanetscaleDb()
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(eq(dashboards.systemId, systemId));
  return rows.map((r) => r.id);
}

/**
 * Clear default system if it matches the given systemId, covering BOTH the legacy default_system_id
 * and the forward default_dashboard_id (any of this system's dashboards). Call when a system is marked
 * 'removed' or access is revoked.
 */
export async function clearDefaultIfMatches(
  clerkUserId: string,
  systemId: number,
): Promise<void> {
  const [user] = await requirePlanetscaleDb()
    .select()
    .from(pgUsers)
    .where(eq(pgUsers.clerkUserId, clerkUserId))
    .limit(1);
  if (!user) return;

  const dashIds = await dashboardIdsForSystem(systemId);
  const matchesDashboard =
    user.defaultDashboardId != null &&
    dashIds.includes(user.defaultDashboardId);
  if (user.defaultSystemId === systemId || matchesDashboard) {
    await writeDefaults(clerkUserId, { dashboardId: null, systemId: null });
  }
}

/**
 * Clear default landing for all users defaulting to a specific system — both the legacy
 * default_system_id and any default_dashboard_id pointing at one of this system's dashboards.
 * Call when a system is deleted or marked 'removed'. (System removal does NOT delete dashboard rows,
 * so the FK ON DELETE SET NULL does not fire — this explicit clear is the mechanism.)
 */
export async function clearDefaultForAllUsers(systemId: number): Promise<void> {
  const now = new Date();
  const db = requirePlanetscaleDb();

  const dashIds = await dashboardIdsForSystem(systemId);
  if (dashIds.length > 0) {
    await db
      .update(pgUsers)
      .set({ defaultDashboardId: null, updatedAt: now })
      .where(inArray(pgUsers.defaultDashboardId, dashIds));
  }
  await db
    .update(pgUsers)
    .set({ defaultSystemId: null, updatedAt: now })
    .where(eq(pgUsers.defaultSystemId, systemId));
}
