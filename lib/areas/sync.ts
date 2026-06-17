/**
 * Write side of the Areas tables: ensure a physical system's 1:1 identity Area.
 *
 * Identity Areas (`ensureIdentityArea`) are the runtime counterpart to the one-off migration backfill:
 * every physical system gets an Area keyed `legacy_system_id == systems.id`, so the System→Area seam
 * has a live path. Without it `getAreaForSystem`/`resolveLogicalSystem` return null and the system
 * silently drops out of the flow recompute, grid-region derivation, and share-scope.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaDevices } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

type Db = ReturnType<typeof requirePlanetscaleDb>;

/** Detect a Postgres unique_violation (SQLSTATE '23505') — e.g. a concurrent-create handle race. */
function isUniqueViolation(e: unknown): boolean {
  return (
    !!e && typeof e === "object" && (e as { code?: unknown }).code === "23505"
  );
}

/** The Area for an integer handle (by `legacy_system_id`, which is UNIQUE), or null. */
async function getAreaIdByLegacyHandle(
  systemId: number,
  db: Db,
): Promise<string | null> {
  const [row] = await db
    .select({ id: areas.id })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  return row?.id ?? null;
}

/** Minimal physical-system shape `ensureIdentityArea` needs — a structural subset of `System`. */
export type IdentitySystemInput = {
  id: number;
  ownerClerkUserId: string | null;
  displayName: string;
  timezoneOffsetMin: number;
  displayTimezone: string;
  status: string;
};

/**
 * Ensure the 1:1 identity Area for a physical system exists, returning its id. Idempotent and
 * race-safe: located by the `areas_legacy_system_unique` index on `legacy_system_id == system.id`, so
 * a concurrent create loses with a unique violation and we re-read the winner's id.
 *
 * Call at system create-time (`SystemsManager.createSystem`); `resolveLogicalSystem` also heals via
 * this for legacy/edge systems.
 */
export async function ensureIdentityArea(
  system: IdentitySystemInput,
  db: Db = requirePlanetscaleDb(),
): Promise<string> {
  const existingId = await getAreaIdByLegacyHandle(system.id, db);
  if (existingId) {
    // Heal membership for an Area created before area_devices existed (idempotent).
    await ensureIdentityMember(db, existingId, system.id);
    return existingId;
  }

  const areaId = uuidv7();
  try {
    await db.insert(areas).values({
      id: areaId,
      ownerClerkUserId: system.ownerClerkUserId,
      sourceSystemId: system.id,
      legacySystemId: system.id,
      displayName: system.displayName,
      alias: null,
      timezoneOffsetMin: system.timezoneOffsetMin,
      displayTimezone: system.displayTimezone,
      status: system.status,
    });
    await ensureIdentityMember(db, areaId, system.id);
    return areaId;
  } catch (e) {
    // Lost a create race (areas_legacy_system_unique) — re-read the winner's id.
    if (isUniqueViolation(e)) {
      const winner = await getAreaIdByLegacyHandle(system.id, db);
      if (winner) {
        await ensureIdentityMember(db, winner, system.id);
        return winner;
      }
    }
    throw e;
  }
}

/** An identity Area's single member is its source system. Idempotent (PK conflict → no-op). */
async function ensureIdentityMember(
  db: Db,
  areaId: string,
  systemId: number,
): Promise<void> {
  await db
    .insert(areaDevices)
    .values({ areaId, systemId, ordinal: 0 })
    .onConflictDoNothing();
}
