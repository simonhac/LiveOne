/**
 * Write side of the P3 Areas tables: ensure a physical system's 1:1 identity Area, create composite
 * Areas, and write their typed `area_bindings`.
 *
 * A composite Area carries an integer addressing handle (`legacy_system_id`) the rest of the app keys
 * on — `getSystem(handle)` resolves to the synthesized virtual system (lib/systems-manager.ts), so a
 * composite needs no `systems` row. New composites are areas-only, with a handle allocated from a
 * dedicated high range. Bindings are the authoritative role→point mapping; the composite editor
 * converts the edited `{version:2, mappings}` blob straight to bindings here.
 *
 * Identity Areas (`ensureIdentityArea`) are the runtime counterpart to the one-off migration backfill:
 * every physical system gets a `kind='identity'` Area keyed `legacy_system_id == systems.id`, so the
 * System→Area seam has a live path. Without it `getAreaForSystem`/`resolveLogicalSystem` return null
 * and the system silently drops out of the flow recompute, grid-region derivation, and share-scope.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  areaBindings,
  areaDevices,
  pointInfo,
} from "@/lib/db/planetscale/schema";
import { and, eq, gte, max } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  convertCompositeToBindings,
  type AreaBindingDraft,
  type ConverterPointInfo,
} from "@/lib/areas/convert";

type Db = ReturnType<typeof requirePlanetscaleDb>;

/**
 * Composite addressing handles live at 100000+, above the systems serial (prod) and the dev-id range
 * (10000+, see SystemsManager.insertSystemToPg), so a composite's `legacy_system_id` never collides
 * with a real `systems.id`.
 */
const COMPOSITE_HANDLE_START = 100000;

/** Transactionally replace an Area's bindings with `drafts`. Shared by the sync entry points. */
async function replaceAreaBindings(
  db: Db,
  areaId: string,
  drafts: AreaBindingDraft[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(areaBindings).where(eq(areaBindings.areaId, areaId));
    if (drafts.length > 0) {
      await tx.insert(areaBindings).values(
        drafts.map((d) => ({
          id: uuidv7(),
          areaId,
          role: d.role,
          metricType: d.metricType,
          pointSystemId: d.pointSystemId,
          pointId: d.pointId,
          ordinal: d.ordinal,
          transform: d.transform,
        })),
      );
    }
    // Keep area_devices membership in lockstep: a composite Area's members are the DISTINCT child
    // systems of its bindings (the same rule as the Phase B backfill), within the same transaction.
    await tx.delete(areaDevices).where(eq(areaDevices.areaId, areaId));
    const memberIds = [...new Set(drafts.map((d) => d.pointSystemId))];
    if (memberIds.length > 0) {
      await tx
        .insert(areaDevices)
        .values(
          memberIds.map((systemId, i) => ({ areaId, systemId, ordinal: i })),
        );
    }
  });
}

/** point_info → ConverterPointInfo. point_info is a small config table; loading it whole is cheap. */
async function loadAllPointInfo(
  db = requirePlanetscaleDb(),
): Promise<ConverterPointInfo[]> {
  const rows = await db
    .select({
      systemId: pointInfo.systemId,
      pointIndex: pointInfo.index,
      logicalPathStem: pointInfo.logicalPathStem,
      metricType: pointInfo.metricType,
      transform: pointInfo.transform,
    })
    .from(pointInfo);
  return rows;
}

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
 * Ensure the 1:1 `kind='identity'` Area for a physical system exists, returning its id. Idempotent and
 * race-safe: located by the `areas_legacy_system_unique` index on `legacy_system_id == system.id`, so a
 * concurrent create loses with a unique violation and we re-read the winner's id.
 *
 * Call at system create-time (`SystemsManager.createSystem`); `resolveLogicalSystem` also heals via
 * this for legacy/edge systems. Composites are NOT created here — they own a `kind='composite'` Area
 * from `createCompositeArea`; callers must not pass a composite handle.
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
      kind: "identity",
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

/** Locate the composite Area for a system handle (by legacy_system_id), or null if none. */
export async function getCompositeAreaId(
  systemId: number,
  db = requirePlanetscaleDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ id: areas.id })
    .from(areas)
    .where(and(eq(areas.legacySystemId, systemId), eq(areas.kind, "composite")))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Create a new composite Area with a fresh integer addressing handle (`legacy_system_id`) from the
 * dedicated high range. Returns `{ areaId, systemId }`. No `systems` row is created — the composite is
 * resolved via SystemsManager's areas-backed synthesis. The `areas_legacy_system_unique` index guards
 * against a concurrent-create handle collision (the loser gets a unique violation).
 */
export async function createCompositeArea(
  params: {
    ownerClerkUserId: string;
    displayName: string;
    alias?: string | null;
    timezoneOffsetMin?: number;
    displayTimezone?: string;
  },
  db: Db = requirePlanetscaleDb(),
): Promise<{ areaId: string; systemId: number }> {
  const [row] = await db
    .select({ maxHandle: max(areas.legacySystemId) })
    .from(areas)
    .where(gte(areas.legacySystemId, COMPOSITE_HANDLE_START));
  const maxHandle = row?.maxHandle ?? null;
  const systemId =
    maxHandle && maxHandle >= COMPOSITE_HANDLE_START
      ? maxHandle + 1
      : COMPOSITE_HANDLE_START;

  const areaId = uuidv7();
  await db.insert(areas).values({
    id: areaId,
    ownerClerkUserId: params.ownerClerkUserId,
    kind: "composite",
    sourceSystemId: null,
    legacySystemId: systemId,
    displayName: params.displayName,
    alias: params.alias ?? null,
    timezoneOffsetMin: params.timezoneOffsetMin ?? 600,
    displayTimezone: params.displayTimezone ?? "Australia/Melbourne",
  });
  return { areaId, systemId };
}

/**
 * Update a composite's identity fields on its `areas` row (the editable equivalent of
 * `SystemsManager.updateSystem` for an areas-backed composite). Located by `legacy_system_id`. The
 * caller is responsible for invalidating the SystemsManager cache afterwards.
 */
export async function updateCompositeArea(
  systemId: number,
  patch: Partial<{
    displayName: string;
    alias: string | null;
    status: string;
    timezoneOffsetMin: number;
    displayTimezone: string;
  }>,
  db = requirePlanetscaleDb(),
): Promise<void> {
  await db
    .update(areas)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(areas.legacySystemId, systemId), eq(areas.kind, "composite")),
    );
}

/**
 * Replace a composite's `area_bindings` from a `{version:2, mappings}` blob — the bindings-authoritative
 * write path (composite create + editor). The composite Area must already exist; throws otherwise.
 * Returns the number of bindings written.
 */
export async function syncCompositeBindingsFromMappings(
  systemId: number,
  metadata: unknown,
): Promise<number> {
  const db = requirePlanetscaleDb();
  const areaId = await getCompositeAreaId(systemId, db);
  if (!areaId) {
    throw new Error(
      `syncCompositeBindingsFromMappings: no composite Area for system ${systemId}`,
    );
  }
  const points = await loadAllPointInfo(db);
  const drafts = convertCompositeToBindings(metadata, points);
  await replaceAreaBindings(db, areaId, drafts);
  return drafts.length;
}
