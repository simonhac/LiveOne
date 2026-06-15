/**
 * Write side of the P3 Areas tables: create composite Areas and write their typed `area_bindings`.
 *
 * A composite Area carries an integer addressing handle (`legacy_system_id`) the rest of the app keys
 * on — `getSystem(handle)` resolves to the synthesized virtual system (lib/systems-manager.ts), so a
 * composite needs no `systems` row. New composites are areas-only, with a handle allocated from a
 * dedicated high range. Bindings are the authoritative role→point mapping; the composite editor
 * converts the edited `{version:2, mappings}` blob straight to bindings here.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings, pointInfo } from "@/lib/db/planetscale/schema";
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
