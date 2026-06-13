/**
 * Write side of the P3 Areas tables: turn a composite's metadata into typed `area_bindings` rows.
 *
 * Shared by the one-off backfill (scripts/migrate-composites-to-areas.ts) and the composite-editor
 * dual-write (when AREAS_TABLE is on, create/PATCH composite → keep bindings in lock-step with the
 * still-authoritative metadata shim). Idempotent per composite: ensures the composite Area exists
 * (located by legacy_system_id) and replaces its bindings transactionally.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  areaBindings,
  pointInfo,
  systems,
} from "@/lib/db/planetscale/schema";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  convertCompositeToBindings,
  type ConverterPointInfo,
} from "@/lib/areas/convert";

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

/** Locate the composite Area for a system (by legacy_system_id), or null if not yet created. */
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
 * Ensure a composite Area row exists for `composite`, returning its id. The Area mirrors the
 * composite shim row's identity fields; `legacy_system_id` is the 1:1 seam back to systems.id.
 */
export async function ensureCompositeArea(
  composite: typeof systems.$inferSelect,
  db = requirePlanetscaleDb(),
): Promise<string> {
  const existing = await getCompositeAreaId(composite.id, db);
  if (existing) return existing;
  const id = uuidv7();
  await db.insert(areas).values({
    id,
    ownerClerkUserId: composite.ownerClerkUserId,
    kind: "composite",
    sourceSystemId: null,
    legacySystemId: composite.id,
    displayName: composite.displayName,
    alias: composite.alias,
    timezoneOffsetMin: composite.timezoneOffsetMin,
    displayTimezone: composite.displayTimezone,
    status: composite.status,
  });
  return id;
}

/**
 * Replace a composite's `area_bindings` from its current `systems.metadata`, transactionally.
 * Returns the number of bindings written. Throws (via the converter) on an unrecognised metadata
 * shape — callers should let that abort the backfill / surface in the editor.
 */
export async function syncCompositeBindings(systemId: number): Promise<number> {
  const db = requirePlanetscaleDb();
  const [composite] = await db
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);
  if (!composite)
    throw new Error(`syncCompositeBindings: system ${systemId} not found`);
  if (composite.vendorType !== "composite") {
    throw new Error(
      `syncCompositeBindings: system ${systemId} is not a composite`,
    );
  }

  const points = await loadAllPointInfo(db);
  const drafts = convertCompositeToBindings(composite.metadata, points);

  const areaId = await ensureCompositeArea(composite, db);

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

  return drafts.length;
}
