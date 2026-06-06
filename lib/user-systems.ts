/**
 * user_systems write routing (Turso → Postgres migration, PR-8 / 1B).
 *
 * Grant / revoke a user's access to a system. Every write is gated on
 * `CONFIG_WRITES_TO_PG` (default off):
 *
 *   • OFF (default): behave exactly as today — the write goes to Turso ONLY.
 *   • ON (config-authority cutover): the write goes to Postgres ONLY (no
 *     dual-write to Turso). If the flag is on but PlanetScale is unconfigured we
 *     throw, mirroring lib/share-tokens.ts — a config write must not silently
 *     no-op against the authoritative store.
 *
 * `user_systems` has a unique index on (clerk_user_id, system_id) on both sides.
 * A grant therefore upserts on that pair so a re-grant is idempotent and updates
 * the role rather than colliding. The Turso branch uses
 * `onConflictDoUpdate`; the PG branch is wrapped 23505-safe so a concurrent
 * insert that races the upsert can't surface as an error.
 *
 * See lib/polling-utils.ts for the routing style this mirrors.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/turso";
import { userSystems } from "@/lib/db/turso/schema";
import { CONFIG_WRITES_TO_PG } from "@/lib/db/routing";
import { planetscaleDb } from "@/lib/db/planetscale";
import { userSystems as pgUserSystems } from "@/lib/db/planetscale/schema";

/**
 * Throw the same shaped error as the other 1B managers when the write flag is on
 * but Postgres isn't configured — a config write must reach the authoritative store.
 */
function requirePg(): NonNullable<typeof planetscaleDb> {
  if (!planetscaleDb) {
    throw new Error(
      "CONFIG_WRITES_TO_PG is on but PlanetScale is not configured",
    );
  }
  return planetscaleDb;
}

/**
 * Grant `clerkUserId` access to `systemId` with `role`, upserting on the
 * (clerkUserId, systemId) unique pair so a re-grant updates the role instead of
 * colliding.
 *
 * WRITE ROUTING (1B): Postgres-only when CONFIG_WRITES_TO_PG is on, else today's
 * unchanged Turso upsert.
 *
 * 23505-SAFE (PG): the upsert targets the unique index, but a concurrent insert
 * that wins the race between our `insert` and the index check can still surface
 * SQLSTATE 23505 (unique_violation). We catch that and re-apply the role as an
 * UPDATE, so the post-condition (row exists with the requested role) holds either
 * way; any other error is rethrown.
 */
export async function grantUserSystem(
  clerkUserId: string,
  systemId: number,
  role: string,
): Promise<void> {
  const now = new Date();

  if (CONFIG_WRITES_TO_PG) {
    const pg = requirePg();
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
    return;
  }

  await db
    .insert(userSystems)
    .values({ clerkUserId, systemId, role, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [userSystems.clerkUserId, userSystems.systemId],
      set: { role, updatedAt: now },
    });
}

/**
 * Revoke `clerkUserId`'s access to `systemId` (delete the single membership row).
 *
 * WRITE ROUTING (1B): Postgres-only when CONFIG_WRITES_TO_PG is on, else today's
 * unchanged Turso delete. Deleting a non-existent row is a no-op on both sides.
 */
export async function revokeUserSystem(
  clerkUserId: string,
  systemId: number,
): Promise<void> {
  if (CONFIG_WRITES_TO_PG) {
    const pg = requirePg();
    await pg
      .delete(pgUserSystems)
      .where(
        and(
          eq(pgUserSystems.clerkUserId, clerkUserId),
          eq(pgUserSystems.systemId, systemId),
        ),
      );
    return;
  }

  await db
    .delete(userSystems)
    .where(
      and(
        eq(userSystems.clerkUserId, clerkUserId),
        eq(userSystems.systemId, systemId),
      ),
    );
}

/**
 * Revoke every user's access to `systemId` (delete all membership rows for the
 * system) — e.g. when a system is deleted.
 *
 * WRITE ROUTING (1B): Postgres-only when CONFIG_WRITES_TO_PG is on, else today's
 * unchanged Turso delete.
 */
export async function revokeAllForSystem(systemId: number): Promise<void> {
  if (CONFIG_WRITES_TO_PG) {
    const pg = requirePg();
    await pg.delete(pgUserSystems).where(eq(pgUserSystems.systemId, systemId));
    return;
  }

  await db.delete(userSystems).where(eq(userSystems.systemId, systemId));
}
