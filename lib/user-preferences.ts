import { db } from "./db/turso";
import { users, systems, userSystems } from "./db/turso/schema";
import { eq, and } from "drizzle-orm";
import { CONFIG_WRITES_TO_PG } from "@/lib/db/routing";
import {
  shadowReadConfig,
  toEpochSeconds,
  SHADOW_SKIP,
} from "@/lib/db/config-shadow";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  users as pgUsers,
  systems as pgSystems,
  userSystems as pgUserSystems,
} from "@/lib/db/planetscale/schema";

/**
 * User preferences (users + user_systems config tables).
 *
 * PR-8 (1A — READ SHADOWING): the SELECT paths below funnel through
 * `shadowReadConfig`. The SERVED value is ALWAYS the Turso read — turning on
 * `CONFIG_READS_FROM_PG` only fires a best-effort Postgres read and LOGS any
 * normalized divergence (it can never change an access-control decision). See
 * lib/db/config-shadow.ts. Each pgRead returns `SHADOW_SKIP` when PG is
 * unconfigured (`planetscaleDb` is null), so the compare is skipped.
 *
 * PR-8 (1B — WRITE ROUTING): the user-prefs writes are gated on
 * `CONFIG_WRITES_TO_PG`. OFF (default): today's Turso write, byte-identical.
 * ON: the write goes to Postgres ONLY (decision B — no Turso dual-write).
 * PG unique violations surface as error code "23505" (not SQLITE_CONSTRAINT).
 *
 * Turso↔PG divergence note: `users.createdAt`/`updatedAt` are Turso
 * `integer(mode:"timestamp")` (second precision) vs PG `timestamp`
 * (microsecond) — normalized via `toEpochSeconds` before comparison.
 */

export interface UserPreferences {
  clerkUserId: string;
  defaultSystemId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Project a `users` row to the fields compared in shadow-diff, collapsing the
 * Turso (second) vs PG (microsecond) timestamp precision divergence.
 */
function normalizeUserForShadow(row: unknown): unknown {
  if (!row) return null;
  const u = row as Record<string, any>;
  return {
    clerkUserId: u.clerkUserId,
    defaultSystemId: u.defaultSystemId ?? null,
    createdAt: toEpochSeconds(u.createdAt),
    updatedAt: toEpochSeconds(u.updatedAt),
  };
}

/**
 * Get or create user preferences record (just-in-time creation).
 *
 * 1A: the existing-record SELECT is shadow-read against Postgres.
 * 1B: the just-in-time INSERT is routed to Postgres-only when CONFIG_WRITES_TO_PG.
 */
export async function getOrCreateUserPreferences(
  clerkUserId: string,
): Promise<UserPreferences> {
  // Try to find existing record (shadow-read).
  const existing = await shadowReadConfig(
    "getOrCreateUserPreferences",
    async () =>
      db
        .select()
        .from(users)
        .where(eq(users.clerkUserId, clerkUserId))
        .limit(1),
    {
      diffKey: clerkUserId,
      pgRead: async () => {
        if (!planetscaleDb) return SHADOW_SKIP;
        return planetscaleDb
          .select()
          .from(pgUsers)
          .where(eq(pgUsers.clerkUserId, clerkUserId))
          .limit(1);
      },
      // Both sides are `[row] | []`; compare the first row's projection.
      normalize: (v) => normalizeUserForShadow((v as any[])?.[0] ?? null),
    },
  );

  if (existing.length > 0) {
    return {
      clerkUserId: existing[0].clerkUserId,
      defaultSystemId: existing[0].defaultSystemId,
      createdAt: existing[0].createdAt,
      updatedAt: existing[0].updatedAt,
    };
  }

  // Create new record (just-in-time creation).
  if (CONFIG_WRITES_TO_PG) {
    if (!planetscaleDb) {
      throw new Error(
        "CONFIG_WRITES_TO_PG is on but PlanetScale is not configured",
      );
    }
    const [newUser] = await planetscaleDb
      .insert(pgUsers)
      .values({ clerkUserId })
      .returning();
    return {
      clerkUserId: newUser.clerkUserId,
      defaultSystemId: newUser.defaultSystemId,
      createdAt: newUser.createdAt,
      updatedAt: newUser.updatedAt,
    };
  }

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
 * Check if a user has access to a system (owned or shared).
 *
 * ACCESS CONTROL: the SERVED boolean is ALWAYS computed from Turso. The PG
 * shadow recomputes the same boolean from Postgres and only logs divergence.
 */
export async function userHasSystemAccess(
  clerkUserId: string,
  systemId: number,
): Promise<boolean> {
  return shadowReadConfig(
    "userHasSystemAccess",
    () => computeUserHasSystemAccessTurso(clerkUserId, systemId),
    {
      diffKey: `${clerkUserId}/${systemId}`,
      pgRead: async () => {
        if (!planetscaleDb) return SHADOW_SKIP;
        return computeUserHasSystemAccessPg(clerkUserId, systemId);
      },
      // Derived boolean — compare as-is.
      normalize: (v) => v,
    },
  );
}

async function computeUserHasSystemAccessTurso(
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

async function computeUserHasSystemAccessPg(
  clerkUserId: string,
  systemId: number,
): Promise<boolean> {
  if (!planetscaleDb) return false;

  const [system] = await planetscaleDb
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

  const sharedAccess = await planetscaleDb
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
 *
 * The SERVED `{ valid, reason }` is computed from Turso; the PG shadow recomputes
 * the same result and only logs divergence.
 */
async function isSystemValidForDefault(
  clerkUserId: string,
  systemId: number,
): Promise<{ valid: boolean; reason?: string }> {
  return shadowReadConfig(
    "isSystemValidForDefault",
    () => computeIsSystemValidForDefaultTurso(clerkUserId, systemId),
    {
      diffKey: `${clerkUserId}/${systemId}`,
      pgRead: async () => {
        if (!planetscaleDb) return SHADOW_SKIP;
        return computeIsSystemValidForDefaultPg(clerkUserId, systemId);
      },
      // Derived { valid, reason } object — compare as-is (key-order independent).
      normalize: (v) => v,
    },
  );
}

async function computeIsSystemValidForDefaultTurso(
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

  const hasAccess = await computeUserHasSystemAccessTurso(
    clerkUserId,
    systemId,
  );
  if (!hasAccess) {
    return { valid: false, reason: "No access to this system" };
  }

  return { valid: true };
}

async function computeIsSystemValidForDefaultPg(
  clerkUserId: string,
  systemId: number,
): Promise<{ valid: boolean; reason?: string }> {
  if (!planetscaleDb) return { valid: false, reason: "System not found" };

  const [system] = await planetscaleDb
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

  const hasAccess = await computeUserHasSystemAccessPg(clerkUserId, systemId);
  if (!hasAccess) {
    return { valid: false, reason: "No access to this system" };
  }

  return { valid: true };
}

/**
 * Set user's default system.
 * Validates user has access and system is active before setting.
 *
 * 1B: the users-table write is routed to Postgres-only when CONFIG_WRITES_TO_PG.
 */
export async function setDefaultSystem(
  clerkUserId: string,
  systemId: number | null,
): Promise<{ success: boolean; error?: string }> {
  // If clearing default, just update
  if (systemId === null) {
    // Ensure user record exists first
    await getOrCreateUserPreferences(clerkUserId);

    await writeDefaultSystemId(clerkUserId, null);
    return { success: true };
  }

  // Validate system is valid for setting as default
  const validation = await isSystemValidForDefault(clerkUserId, systemId);
  if (!validation.valid) {
    return { success: false, error: validation.reason };
  }

  // Ensure user record exists, then update
  await getOrCreateUserPreferences(clerkUserId);

  await writeDefaultSystemId(clerkUserId, systemId);

  return { success: true };
}

/**
 * Write the user's default_system_id (the shared body of setDefaultSystem and
 * its clear path). 1B: Postgres-only when CONFIG_WRITES_TO_PG, else Turso.
 */
async function writeDefaultSystemId(
  clerkUserId: string,
  systemId: number | null,
): Promise<void> {
  const now = new Date();
  if (CONFIG_WRITES_TO_PG) {
    if (!planetscaleDb) {
      throw new Error(
        "CONFIG_WRITES_TO_PG is on but PlanetScale is not configured",
      );
    }
    await planetscaleDb
      .update(pgUsers)
      .set({ defaultSystemId: systemId, updatedAt: now })
      .where(eq(pgUsers.clerkUserId, clerkUserId));
    return;
  }

  await db
    .update(users)
    .set({ defaultSystemId: systemId, updatedAt: now })
    .where(eq(users.clerkUserId, clerkUserId));
}

/**
 * Get user's valid default system ID.
 * Returns null if no default set, access revoked, or system is no longer active.
 * Will auto-clear invalid defaults.
 *
 * 1A: the validity check is shadow-read against Postgres. The auto-clear side
 * effect runs ONLY on the served (Turso) path — the PG shadow is a pure read.
 */
export async function getValidDefaultSystemId(
  clerkUserId: string,
): Promise<number | null> {
  const prefs = await getOrCreateUserPreferences(clerkUserId);

  if (!prefs.defaultSystemId) {
    return null;
  }

  const defaultSystemId = prefs.defaultSystemId;

  // Validate system is still valid as a default. isSystemValidForDefault is
  // itself shadow-read; we compose a single derived "valid default id or null"
  // shadow at this level so the auto-clear write never runs on the PG path.
  const validDefault = await shadowReadConfig(
    "getValidDefaultSystemId",
    async () => {
      const validation = await computeIsSystemValidForDefaultTurso(
        clerkUserId,
        defaultSystemId,
      );
      if (!validation.valid) {
        // Access revoked or system inactive, clear the default (served path only).
        await setDefaultSystem(clerkUserId, null);
        return null;
      }
      return defaultSystemId;
    },
    {
      diffKey: clerkUserId,
      pgRead: async () => {
        if (!planetscaleDb) return SHADOW_SKIP;
        const validation = await computeIsSystemValidForDefaultPg(
          clerkUserId,
          defaultSystemId,
        );
        // Pure read: do NOT auto-clear on the shadow path.
        return validation.valid ? defaultSystemId : null;
      },
      // Derived number-or-null — compare as-is.
      normalize: (v) => v,
    },
  );

  return validDefault;
}

/**
 * Clear default system if it matches the given systemId.
 * Call this when a system is marked as 'removed' or when access is revoked.
 *
 * 1A: the matching SELECT is shadow-read. 1B: the clearing UPDATE is routed to
 * Postgres-only when CONFIG_WRITES_TO_PG.
 */
export async function clearDefaultIfMatches(
  clerkUserId: string,
  systemId: number,
): Promise<void> {
  const [user] = await shadowReadConfig(
    "clearDefaultIfMatches",
    async () =>
      db
        .select()
        .from(users)
        .where(eq(users.clerkUserId, clerkUserId))
        .limit(1),
    {
      diffKey: clerkUserId,
      pgRead: async () => {
        if (!planetscaleDb) return SHADOW_SKIP;
        return planetscaleDb
          .select()
          .from(pgUsers)
          .where(eq(pgUsers.clerkUserId, clerkUserId))
          .limit(1);
      },
      normalize: (v) => normalizeUserForShadow((v as any[])?.[0] ?? null),
    },
  );

  if (user && user.defaultSystemId === systemId) {
    await writeDefaultSystemId(clerkUserId, null);
  }
}

/**
 * Clear default system for all users who have a specific system as their default.
 * Call this when a system is deleted or marked as 'removed'.
 *
 * 1B: routed to Postgres-only when CONFIG_WRITES_TO_PG.
 */
export async function clearDefaultForAllUsers(systemId: number): Promise<void> {
  const now = new Date();
  if (CONFIG_WRITES_TO_PG) {
    if (!planetscaleDb) {
      throw new Error(
        "CONFIG_WRITES_TO_PG is on but PlanetScale is not configured",
      );
    }
    await planetscaleDb
      .update(pgUsers)
      .set({ defaultSystemId: null, updatedAt: now })
      .where(eq(pgUsers.defaultSystemId, systemId));
    return;
  }

  await db
    .update(users)
    .set({ defaultSystemId: null, updatedAt: now })
    .where(eq(users.defaultSystemId, systemId));
}
