/**
 * Enumerate Areas for the multi-area dashboard composition UI (Phase 2b).
 *
 * `listReadableAreas` powers the "add a card from another area" picker and the client-side
 * areaId→systemId+label resolution map: it is the set of Areas a user may bind a card to, derived
 * from the systems they can already see (no escalation — you can only compose areas you can read).
 * `resolveAreasByIds` resolves a specific set of Area uuids to their addressing handle + label,
 * used by the read-only shared view (where the scope is already fixed by the token).
 */
import { and, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";

export interface ReadableArea {
  /** Area uuid (what a card's `areaId` holds). */
  id: string;
  displayName: string;
  kind: "identity" | "composite";
  /** The integer addressing handle — the systemId a card binds its data queries to. */
  legacySystemId: number;
  /** The bound system's vendor type — lets the card picker grey out vendor-incompatible card types. */
  vendorType: string;
}

/**
 * The Areas a user may read = the identity/composite Areas of every system visible to them
 * (`getSystemsVisibleByUser`). The dashboard owner can compose a card from any of these, and the
 * authoring check (PUT /api/dashboard/[systemId]) rejects a card binding any Area outside this set.
 */
export async function listReadableAreas(
  userId: string,
): Promise<ReadableArea[]> {
  const systems = await SystemsManager.getInstance().getSystemsVisibleByUser(
    userId,
    true,
  );
  const systemIds = systems.map((s) => s.id);
  if (systemIds.length === 0) return [];
  const vendorBySystemId = new Map(systems.map((s) => [s.id, s.vendorType]));

  const rows = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      displayName: areas.displayName,
      kind: areas.kind,
      legacySystemId: areas.legacySystemId,
    })
    .from(areas)
    .where(
      and(inArray(areas.legacySystemId, systemIds), eq(areas.status, "active")),
    );

  return rows
    .filter(
      (r): r is typeof r & { legacySystemId: number } =>
        r.legacySystemId != null,
    )
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      kind: r.kind as "identity" | "composite",
      legacySystemId: r.legacySystemId,
      vendorType: vendorBySystemId.get(r.legacySystemId) ?? "",
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Resolve a specific set of Area uuids → addressing handle + label. No access filtering: callers
 * (the shared view) have already fixed the scope via the share token; this only labels what the
 * descriptor references so each card can fetch its area's data and show whose area it is.
 */
export async function resolveAreasByIds(
  areaIds: string[],
): Promise<ReadableArea[]> {
  const ids = [...new Set(areaIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      displayName: areas.displayName,
      kind: areas.kind,
      legacySystemId: areas.legacySystemId,
    })
    .from(areas)
    .where(inArray(areas.id, ids));
  const present = rows.filter(
    (r): r is typeof r & { legacySystemId: number } => r.legacySystemId != null,
  );
  return Promise.all(
    present.map(async (r) => ({
      id: r.id,
      displayName: r.displayName,
      kind: r.kind as "identity" | "composite",
      legacySystemId: r.legacySystemId,
      vendorType:
        (await SystemsManager.getInstance().getSystem(r.legacySystemId))
          ?.vendorType ?? "",
    })),
  );
}
