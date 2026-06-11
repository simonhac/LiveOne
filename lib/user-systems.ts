/**
 * user_systems writes (Postgres).
 *
 * Grant / revoke a user's access to a system. `user_systems` has a unique index on
 * (clerk_user_id, system_id). A grant upserts on that pair so a re-grant is idempotent
 * and updates the role rather than colliding; the upsert is wrapped 23505-safe so a
 * concurrent insert that races it can't surface as an error.
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { userSystems as pgUserSystems } from "@/lib/db/planetscale/schema";

/**
 * Grant `clerkUserId` access to `systemId` with `role`, upserting on the
 * (clerkUserId, systemId) unique pair so a re-grant updates the role instead of
 * colliding.
 *
 * 23505-SAFE: the upsert targets the unique index, but a concurrent insert that wins
 * the race between our `insert` and the index check can still surface SQLSTATE 23505
 * (unique_violation). We catch that and re-apply the role as an UPDATE, so the
 * post-condition (row exists with the requested role) holds either way; any other
 * error is rethrown.
 */
export async function grantUserSystem(
  clerkUserId: string,
  systemId: number,
  role: string,
): Promise<void> {
  const now = new Date();
  const pg = requirePlanetscaleDb();
  try {
    await pg
      .insert(pgUserSystems)
      .values({ clerkUserId, systemId, role, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [pgUserSystems.clerkUserId, pgUserSystems.systemId],
        set: { role, updatedAt: now },
      });
  } catch (err: any) {
    // Concurrent insert raced us onto the unique pair → fold into an update.
    if (err?.code === "23505") {
      await pg
        .update(pgUserSystems)
        .set({ role, updatedAt: now })
        .where(
          and(
            eq(pgUserSystems.clerkUserId, clerkUserId),
            eq(pgUserSystems.systemId, systemId),
          ),
        );
      return;
    }
    throw err;
  }
}

/**
 * Revoke `clerkUserId`'s access to `systemId` (delete the single membership row).
 * Deleting a non-existent row is a no-op.
 */
export async function revokeUserSystem(
  clerkUserId: string,
  systemId: number,
): Promise<void> {
  await requirePlanetscaleDb()
    .delete(pgUserSystems)
    .where(
      and(
        eq(pgUserSystems.clerkUserId, clerkUserId),
        eq(pgUserSystems.systemId, systemId),
      ),
    );
}

/**
 * Revoke every user's access to `systemId` (delete all membership rows for the
 * system) — e.g. when a system is deleted.
 */
export async function revokeAllForSystem(systemId: number): Promise<void> {
  await requirePlanetscaleDb()
    .delete(pgUserSystems)
    .where(eq(pgUserSystems.systemId, systemId));
}
