import { db } from "./db";
import { users, systems, userSystems } from "./db/schema";
import { eq, and } from "drizzle-orm";

export interface UserPreferences {
  clerkUserId: string;
  defaultSystemId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get or create user preferences record (just-in-time creation)
 */
export async function getOrCreateUserPreferences(
  clerkUserId: string,
): Promise<UserPreferences> {
  // Try to find existing record
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  if (existing.length > 0) {
    return {
      clerkUserId: existing[0].clerkUserId,
      defaultSystemId: existing[0].defaultSystemId,
      createdAt: existing[0].createdAt,
      updatedAt: existing[0].updatedAt,
    };
  }

  // Create new record (just-in-time creation)
  const [newUser] = await db
    .insert(users)
    .values({
      clerkUserId,
    })
    .returning();

  return {
    clerkUserId: newUser.clerkUserId,
    defaultSystemId: newUser.defaultSystemId,
    createdAt: newUser.createdAt,
    updatedAt: newUser.updatedAt,
  };
}

/**
 * Check if a user has access to a system (owned or shared)
 */
export async function userHasSystemAccess(
  clerkUserId: string,
  systemId: number,
): Promise<boolean> {
  // Check if user owns the system
  const [system] = await db
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);

  if (!system) {
    return false;
  }

  // User owns the system
  if (system.ownerClerkUserId === clerkUserId) {
    return true;
  }

  // Check if user has shared access
  const sharedAccess = await db
    .select()
    .from(userSystems)
    .where(
      and(
        eq(userSystems.clerkUserId, clerkUserId),
        eq(userSystems.systemId, systemId),
      ),
    )
    .limit(1);

  return sharedAccess.length > 0;
}

/**
 * Check if a system is valid for being set as a default (exists, active, user has access)
 */
async function isSystemValidForDefault(
  clerkUserId: string,
  systemId: number,
): Promise<{ valid: boolean; reason?: string }> {
  const [system] = await db
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
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
 * Set user's default system
 * Validates user has access and system is active before setting
 */
export async function setDefaultSystem(
  clerkUserId: string,
  systemId: number | null,
): Promise<{ success: boolean; error?: string }> {
  // If clearing default, just update
  if (systemId === null) {
    // Ensure user record exists first
    await getOrCreateUserPreferences(clerkUserId);

    await db
      .update(users)
      .set({ defaultSystemId: null, updatedAt: new Date() })
      .where(eq(users.clerkUserId, clerkUserId));
    return { success: true };
  }

  // Validate system is valid for setting as default
  const validation = await isSystemValidForDefault(clerkUserId, systemId);
  if (!validation.valid) {
    return { success: false, error: validation.reason };
  }

  // Ensure user record exists, then update
  await getOrCreateUserPreferences(clerkUserId);

  await db
    .update(users)
    .set({ defaultSystemId: systemId, updatedAt: new Date() })
    .where(eq(users.clerkUserId, clerkUserId));

  return { success: true };
}

/**
 * Get user's valid default system ID
 * Returns null if no default set, access revoked, or system is no longer active
 * Will auto-clear invalid defaults
 */
export async function getValidDefaultSystemId(
  clerkUserId: string,
): Promise<number | null> {
  const prefs = await getOrCreateUserPreferences(clerkUserId);

  if (!prefs.defaultSystemId) {
    return null;
  }

  // Validate system is still valid as a default
  const validation = await isSystemValidForDefault(
    clerkUserId,
    prefs.defaultSystemId,
  );

  if (!validation.valid) {
    // Access revoked or system inactive, clear the default
    await setDefaultSystem(clerkUserId, null);
    return null;
  }

  return prefs.defaultSystemId;
}

/**
 * Clear default system if it matches the given systemId
 * Call this when a system is marked as 'removed' or when access is revoked
 */
export async function clearDefaultIfMatches(
  clerkUserId: string,
  systemId: number,
): Promise<void> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  if (user && user.defaultSystemId === systemId) {
    await db
      .update(users)
      .set({ defaultSystemId: null, updatedAt: new Date() })
      .where(eq(users.clerkUserId, clerkUserId));
  }
}

/**
 * Clear default system for all users who have a specific system as their default
 * Call this when a system is deleted or marked as 'removed'
 */
export async function clearDefaultForAllUsers(systemId: number): Promise<void> {
  await db
    .update(users)
    .set({ defaultSystemId: null, updatedAt: new Date() })
    .where(eq(users.defaultSystemId, systemId));
}
