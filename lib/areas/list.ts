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
  /**
   * `'active'` unless the caller passed `includeArchived`. Present always — a list that can contain
   * archived rows and does not say which is worse than one that cannot contain them at all.
   */
  status: string;
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
 * The Areas a user may read = Areas they own, plus any Area whose handle is one of their visible
 * systems, plus any Area a dashboard they've been GRANTED puts in scope — or, with `opts.isAdmin`,
 * every active Area.
 * The dashboard owner can compose a card from any of these, and the authoring check
 * (PUT /api/dashboard/[systemId]) rejects a card binding any Area outside this set.
 *
 * The granted leg is not redundant with `devicesVisibleByUser`'s own grant handling. That function
 * unions the granted scope too, but then narrows it to rows in `devices` — so it can only ever
 * surface a handle that IS a device rid. An Area minted in its own right (a composite/"Unified" area,
 * or anything from the ≥1,000,000 area-handle allocator) has NO device row behind its handle, so it
 * was dropped there and ownership became its only read path. `grantedDeviceScopeForUser` already
 * carries those Area handles verbatim — `resolveScope` pushes each dashboard Area's handle — so
 * unioning the RAW set here is what lets a grant reach them. No escalation: a grant already implies
 * read access to that dashboard's points (`resolveDashboardReadPoints`); this only makes the Area row
 * as readable as the data it fronts.
 */
export async function listReadableAreas(
  userId: string,
  opts: {
    withChartCapability?: boolean;
    isAdmin?: boolean;
    /**
     * Include `status='archived'` rows. OFF by default, because every UI caller means "areas I can
     * use" and an archived one is exactly what should not appear in a picker.
     *
     * It exists for the operator path. An archived area was, until this flag, unreachable by every
     * `area` verb — `resolveArea` in the CLI resolves a ref against this list, so even passing the
     * literal `ar_…` id failed with "no area matches". That made archiving a one-way door into a
     * state you could not inspect, purge or delete, which is not a safe place to leave a row.
     */
    includeArchived?: boolean;
  } = {},
): Promise<ReadableArea[]> {
  // An ADMIN asking for the fleet needs neither leg — see `devicesVisibleByUser`'s docstring for why
  // this is opt-in rather than a blanket widening, and for the asymmetry it closes (admin could
  // PATCH an area this function would not name). `undefined` means "no predicate": every active area.
  let accessCond: ReturnType<typeof or> | ReturnType<typeof eq> | undefined;
  if (!opts.isAdmin) {
    const devices = await DeviceConfigRegistry.devicesVisibleByUser(
      userId,
      true,
    );
    // Dynamic import of `lib/dashboard/grants` breaks a module cycle (grants → access → point-manager
    // → device-config → here), the same reason `devicesVisibleByUser` does it.
    const { grantedDeviceScopeForUser } = await import(
      "@/lib/dashboard/grants"
    );
    const systemIds = [
      ...new Set([
        ...devices.map((s) => s.id),
        ...(await grantedDeviceScopeForUser(userId)),
      ]),
    ];

    // Areas a user can read: explicit Areas they own, plus legacy explicit Areas still addressed by a
    // visible device id or put in scope by a granted dashboard.
    accessCond =
      systemIds.length > 0
        ? or(
            eq(areas.ownerUserId, userId),
            inArray(legacyHandles.handle, systemIds),
          )
        : eq(areas.ownerUserId, userId);
  }

  const rows = await requirePlanetscaleDb()
    .select({
      id: areas.id,
      displayName: areas.name,
      legacySystemId: legacyHandles.handle,
      status: areas.status,
    })
    .from(areas)
    // config-v4 Phase 13 PR 5: the handle comes from `legacy_handles`, not the dropped
    // `areas.legacy_system_id`. LEFT, not inner, for TWO independent reasons: the projected
    // `legacySystemId` must stay `number | null` so the `.filter` below (and the exported
    // `ReadableArea` contract) is unchanged; AND `accessCond`'s FIRST disjunct is ownership, which must
    // still match an owned area that happens to carry no handle — an inner join would silently narrow
    // the readable set, which is the direction that REMOVES access.
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    // 🛑 `status = 'active'` survives the ADMIN leg, and always has: admin widens WHOSE areas are
    // listed, it does not resurrect archived ones. `includeArchived` is the separate, explicit
    // opt-out — a different question from "whose", asked by a different caller (the operator CLI),
    // and deliberately not something being an admin grants you by accident.
    .where(
      and(
        opts.includeArchived ? undefined : eq(areas.status, "active"),
        accessCond,
      ),
    );

  const present = rows
    .filter(
      (r): r is typeof r & { legacySystemId: number } =>
        r.legacySystemId != null,
    )
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      legacySystemId: r.legacySystemId,
      status: r.status,
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
      status: areas.status,
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
      status: r.status,
    }));
  return withChartCapabilityIfRequested(
    present,
    opts.withChartCapability ?? false,
  );
}
