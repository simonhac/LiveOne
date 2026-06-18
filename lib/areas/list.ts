/**
 * Enumerate Areas for the multi-area dashboard composition UI (Phase 2b).
 *
 * `listReadableAreas` powers the "add a card from another area" picker and the client-side
 * areaId→systemId+label resolution map: it is the set of Areas a user may bind a card to, derived
 * from the systems they can already see (no escalation — you can only compose areas you can read).
 * `resolveAreasByIds` resolves a specific set of Area uuids to their addressing handle + label,
 * used by the read-only shared view (where the scope is already fixed by the token).
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";

export interface ReadableArea {
  /** Area uuid (what a card's `areaId` holds). */
  id: string;
  displayName: string;
  /** The integer addressing handle — the systemId a card binds its data queries to. */
  legacySystemId: number;
  /** The bound system's vendor type — lets the card picker grey out vendor-incompatible card types. */
  vendorType: string;
}

/**
 * The Areas a user may read = the Areas (areas-of-one and multi-device) of every system visible to
 * them (`getSystemsVisibleByUser`). The dashboard owner can compose a card from any of these, and the
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
  const vendorBySystemId = new Map(systems.map((s) => [s.id, s.vendorType]));

  // Areas a user can read: the area-of-one of every visible system, PLUS Areas they OWN — the
  // latter catches multi-device areas whose handle is not itself a real system.
  const accessCond =
    systemIds.length > 0
      ? or(
          eq(areas.ownerClerkUserId, userId),
          inArray(areas.legacySystemId, systemIds),
        )
      : eq(areas.ownerClerkUserId, userId);

  const rows = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      displayName: areas.displayName,
      legacySystemId: areas.legacySystemId,
    })
    .from(areas)
    .where(and(eq(areas.status, "active"), accessCond));

  return rows
    .filter(
      (r): r is typeof r & { legacySystemId: number } =>
        r.legacySystemId != null,
    )
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      legacySystemId: r.legacySystemId,
      // Real handle → its vendor type; a multi-device Area handle (no real system) → "area"
      // (drives the "site"/unified layout via getLayout).
      vendorType: vendorBySystemId.get(r.legacySystemId) ?? "area",
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
      legacySystemId: r.legacySystemId,
      vendorType:
        (await SystemsManager.getInstance().getViewableSystem(r.legacySystemId))
          ?.vendorType ?? "",
    })),
  );
}
