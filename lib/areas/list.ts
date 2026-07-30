/**
 * Enumerate Areas for the multi-area dashboard composition UI (Phase 2b).
 *
 * `listReadableAreas` powers the "add a card from another area" picker and the client-side
 * areaId→systemId+label resolution map: it is the set of Areas a user may bind a card to, derived
 * from the devices they can already see (no escalation — you can only compose areas you can read).
 * `resolveAreasByIds` resolves a specific set of Area uuids to their addressing handle + label,
 * used by the read-only shared view (where the scope is already fixed by the token).
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, legacyHandles } from "@/lib/db/planetscale/schema";
import { hasChartCapability } from "@/lib/capabilities/server";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

export interface ReadableArea {
  /** Area uuid (what a card's `areaId` holds). */
  id: string;
  displayName: string;
  /** The integer addressing handle — the systemId a card binds its data queries to. */
  legacySystemId: number;
  /** CONFIG-only chart/sankey eligibility (`hasChartCapability`) — present only when the caller asked
   *  for it (`withChartCapability`); undefined otherwise. Lets a dashboard render thread this fact to
   *  `SiteChartsGroup` without waiting on `/api/data`'s live `latest` map. */
  chartCapable?: boolean;
}

/** Attach `chartCapable` to each row when `with` is true — concurrent, best-effort (a per-area failure
 *  degrades that area to `false`, same as the pre-existing "no data yet" render). */
async function withChartCapabilityIfRequested<
  T extends { legacySystemId: number },
>(rows: T[], want: boolean): Promise<(T & { chartCapable?: boolean })[]> {
  if (!want) return rows;
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      chartCapable: await hasChartCapability(r.legacySystemId).catch(
        () => false,
      ),
    })),
  );
}

/**
 * The Areas a user may read = Areas they own plus any Area whose handle is one of their visible systems.
 * The dashboard owner can compose a card from any of these, and the authoring check
 * (PUT /api/dashboard/[systemId]) rejects a card binding any Area outside this set.
 */
export async function listReadableAreas(
  userId: string,
  opts: { withChartCapability?: boolean } = {},
): Promise<ReadableArea[]> {
  const devices = await DeviceConfigRegistry.devicesVisibleByUser(userId, true);
  const systemIds = devices.map((s) => s.id);

  // Areas a user can read: explicit Areas they own, plus legacy explicit Areas still addressed by a
  // visible device id.
  const accessCond =
    systemIds.length > 0
      ? or(
          eq(areas.ownerUserId, userId),
          inArray(legacyHandles.handle, systemIds),
        )
      : eq(areas.ownerUserId, userId);

  const rows = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      displayName: areas.name,
      legacySystemId: legacyHandles.handle,
    })
    .from(areas)
    // config-v4 Phase 13 PR 5: the handle comes from `legacy_handles`, not the dropped
    // `areas.legacy_system_id`. LEFT, not inner, for TWO independent reasons: the projected
    // `legacySystemId` must stay `number | null` so the `.filter` below (and the exported
    // `ReadableArea` contract) is unchanged; AND `accessCond`'s FIRST disjunct is ownership, which must
    // still match an owned area that happens to carry no handle — an inner join would silently narrow
    // the readable set, which is the direction that REMOVES access.
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(and(eq(areas.status, "active"), accessCond));

  const present = rows
    .filter(
      (r): r is typeof r & { legacySystemId: number } =>
        r.legacySystemId != null,
    )
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      legacySystemId: r.legacySystemId,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return withChartCapabilityIfRequested(
    present,
    opts.withChartCapability ?? false,
  );
}

/**
 * Resolve a specific set of Area uuids → addressing handle + label. No access filtering: callers
 * (the shared view) have already fixed the scope via the share token; this only labels what the
 * descriptor references so each card can fetch its area's data and show whose area it is.
 */
export async function resolveAreasByIds(
  areaIds: string[],
  opts: { withChartCapability?: boolean } = {},
): Promise<ReadableArea[]> {
  const ids = [...new Set(areaIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      displayName: areas.name,
      legacySystemId: legacyHandles.handle,
    })
    .from(areas)
    // LEFT: `legacySystemId` stays nullable for the `.filter` below (see `listReadableAreas`).
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(inArray(areas.id, ids));
  const present = rows
    .filter(
      (r): r is typeof r & { legacySystemId: number } =>
        r.legacySystemId != null,
    )
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      legacySystemId: r.legacySystemId,
    }));
  return withChartCapabilityIfRequested(
    present,
    opts.withChartCapability ?? false,
  );
}
