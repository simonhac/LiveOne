import { eq, and } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  users as pgUsers,
  systems as pgSystems,
  userSystems as pgUserSystems,
} from "@/lib/db/planetscale/schema";

/**
 * User preferences (users + user_systems config tables) — Postgres only.
 */

export interface UserPreferences {
  clerkUserId: string;
  defaultSystemId: number | null;
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
 * Set user's default system.
 * Validates user has access and system is active before setting.
 */
export async function setDefaultSystem(
  clerkUserId: string,
  systemId: number | null,
): Promise<{ success: boolean; error?: string }> {
  if (systemId === null) {
    await getOrCreateUserPreferences(clerkUserId);
    await writeDefaultSystemId(clerkUserId, null);
    return { success: true };
  }

  const validation = await isSystemValidForDefault(clerkUserId, systemId);
  if (!validation.valid) {
    return { success: false, error: validation.reason };
  }

  await getOrCreateUserPreferences(clerkUserId);
  await writeDefaultSystemId(clerkUserId, systemId);

  return { success: true };
}

/**
 * Write the user's default_system_id (the shared body of setDefaultSystem and its clear path).
 */
async function writeDefaultSystemId(
  clerkUserId: string,
  systemId: number | null,
): Promise<void> {
  const now = new Date();
  await requirePlanetscaleDb()
    .update(pgUsers)
    .set({ defaultSystemId: systemId, updatedAt: now })
    .where(eq(pgUsers.clerkUserId, clerkUserId));
}

/**
 * Get user's valid default system ID.
 * Returns null if no default set, access revoked, or system is no longer active.
 * Will auto-clear invalid defaults.
 */
export async function getValidDefaultSystemId(
  clerkUserId: string,
): Promise<number | null> {
  const prefs = await getOrCreateUserPreferences(clerkUserId);

  if (!prefs.defaultSystemId) {
    return null;
  }

  const defaultSystemId = prefs.defaultSystemId;

  const validation = await isSystemValidForDefault(
    clerkUserId,
    defaultSystemId,
  );
  if (!validation.valid) {
    // Access revoked or system inactive — clear the default.
    await setDefaultSystem(clerkUserId, null);
    return null;
  }
  return defaultSystemId;
}

/**
 * Clear default system if it matches the given systemId.
 * Call this when a system is marked as 'removed' or when access is revoked.
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

  if (user && user.defaultSystemId === systemId) {
    await writeDefaultSystemId(clerkUserId, null);
  }
}

/**
 * Clear default system for all users who have a specific system as their default.
 * Call this when a system is deleted or marked as 'removed'.
 */
export async function clearDefaultForAllUsers(systemId: number): Promise<void> {
  const now = new Date();
  await requirePlanetscaleDb()
    .update(pgUsers)
    .set({ defaultSystemId: null, updatedAt: now })
    .where(eq(pgUsers.defaultSystemId, systemId));
}
