/**
 * Point Manager - Backend-only manager for monitoring points
 * DO NOT import this on the frontend - use PointInfo directly instead
 *
 * This is the single source of truth for all point operations:
 * - Reading point definitions (getActivePointsForDevice, getSeriesForDevice)
 * - Writing point definitions (createPoint, updatePoint, ensurePointInfo)
 * - Inserting point readings (insertPointReading, insertPointReadingsRaw, insertPointReadingsAgg5m)
 */

import { and, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices as pgDevices,
  points as pgPoints,
} from "@/lib/db/planetscale/schema";
import { isFiveMinuteNativeVendor } from "@/lib/vendors/native-intervals";
import { PointInfo } from "@/lib/point/point-info";
import {
  SeriesInfo,
  createSeriesInfos,
  getSeriesPath,
} from "@/lib/point/series-info";
import { SystemIdentifier } from "@/lib/identifiers";
import { mintPoint } from "@/lib/point/mint-point";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import micromatch from "micromatch";
import { updateLatestPointValue } from "../kv-cache-manager";
import { getAreaBindingRefs } from "@/lib/areas/bindings";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { DeviceRegistry } from "@/lib/registry";
import {
  updateSystemSummary,
  updateSubscriberSummaries,
} from "../system-summary-store";
import { publishObservationBatch } from "../observations/publisher";

// ============================================================================
// Types
// ============================================================================

/**
 * The served point_info row shape. Postgres stores native `createdAt`/`updatedAt`
 * timestamps; this served shape exposes the epoch-ms `createdAtMs`/`updatedAtMs`
 * fields that `PointInfo.from()` and the rest of the codebase consume (unchanged
 * from the long-standing legacy row shape).
 */
export interface PointInfoRow {
  systemId: number;
  index: number;
  /** Stable public identity (uuid) — the `point_uid` column (NOT NULL). Carried on the
   * observation payload (v2) so the receiver resolves via the DAO seam. `rid` stays below the seam. */
  pointUid: string;
  physicalPathTail: string;
  logicalPathStem: string | null;
  metricType: string;
  metricUnit: string;
  defaultName: string;
  displayName: string;
  subsystem: string | null;
  transform: string | null;
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number | null;
}

export interface PointInfoMap {
  [key: string]: PointInfoRow;
}

export interface PointMetadata {
  physicalPathTail: string; // "/" separated suffix, e.g., "solar_w", "B1/kwh"
  logicalPathStem: string | null; // "." separated, e.g., "source.solar"
  metricType: string;
  metricUnit: string;
  defaultName: string;
  subsystem?: string | null;
  transform: string | null;
}

/**
 * Session info for tracking when data was received
 */
export interface SessionInfo {
  id: string; // UUIDv7 (text); historical = stringified int
  started: Date;
  label?: string | null;
}

// ============================================================================
// point_info PG row → served shape
// ============================================================================

/**
 * The SINGLE projection every served-point read goes through — config-v4 Phase 12 slice 1b.
 *
 * ## `index` is now `points.rid`, and that is the whole point of this slice
 *
 * `points` has neither `point_info.system_id` nor `point_info.id` (the per-device sequential
 * "index"). The handle comes back via the `devices` join; the index is re-sourced from
 * `points.rid`.
 *
 * That re-sourcing is deliberately done HERE, at the one seam, rather than by re-grammaring
 * `PointInfo.getReference()` and then chasing its consumers. `index` and the reference derived from
 * it are used as an in-memory correlation key in four places that the migration brief did not name
 * — `app/api/history/route.ts:377,394`, `lib/history/readings-pg.ts:120,192,220`,
 * `lib/history/build-series.ts:116`, `lib/aggregation/flow-series-pg.ts:135` — where one side of the
 * comparison is built from `.index` and the other from `.getReference()`. Today those are the same
 * integer, so they agree by accident. Re-grammaring only the reference would have split them into
 * TWO keyspaces, and the failure is SILENT: `coversRoleSet` (`history/route.ts:394`) simply goes
 * false and the Sankey is omitted with reason `"incomplete-series-set"` — no error, no log. Worse,
 * the energy overlay is already reference-keyed on both sides, so the two legs could not merely
 * miss each other but COLLIDE — one point's old `index` can equal another point's `rid` on the same
 * device, which yields plausible-but-wrong numbers.
 *
 * Sourcing both from one integer makes that divergence UNREPRESENTABLE instead of merely tested
 * for. Two addresses that must agree is the most expensive pattern in this phase; this collapses
 * them to one.
 *
 * ## Consequences, stated deliberately
 *
 * `point_info.id` was per-device sequential (1..19 on dev); `points.rid` is global (1..134). They
 * are equal only for points minted since slice M — 17 of 134 rows on dev, so **117 change value**.
 * Nothing persists a point reference (`PointReference.parse` has no production caller, no DB column
 * or dashboard descriptor stores one, and the KV `pointReference` is already a `pt_` TypeID), so
 * the change cannot invalidate stored data. Two wire fields carry the new integer —
 * `/api/device/[id]/points`'s `reference` and `/api/history`'s `path` fallback — both display/keying
 * only; see the PR body.
 *
 * ⚠️ WRITERS ARE NOT CONVERTED BY THIS SLICE. `point_info` is still written (as the write-behind
 * copy it became in slice M) so the `verify-slice-m-*` parity oracles keep working until PR 2 drops
 * the table. But `updatePoint`'s WHERE had to move from `point_info.id` to `point_info.rid`, because
 * its `pointIndex` argument now arrives as a rid from these reads. See there.
 */
function servedPointColumns() {
  return {
    systemId: pgDevices.rid,
    index: pgPoints.rid,
    pointUid: pgPoints.id,
    physicalPathTail: pgPoints.physicalPath,
    logicalPathStem: pgPoints.logicalPath,
    metricType: pgPoints.metricType,
    metricUnit: pgPoints.unit,
    defaultName: pgPoints.defaultName,
    displayName: pgPoints.name,
    subsystem: pgPoints.subsystem,
    transform: pgPoints.transform,
    active: pgPoints.active,
    createdAt: pgPoints.createdAt,
    updatedAt: pgPoints.updatedAt,
  } as const;
}

/** A row as projected by {@link servedPointColumns}. */
type ServedPointDbRow = {
  systemId: number;
  index: number;
  pointUid: string;
  physicalPathTail: string;
  logicalPathStem: string | null;
  metricType: string;
  metricUnit: string;
  defaultName: string;
  displayName: string;
  subsystem: string | null;
  transform: string | null;
  active: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
};

/**
 * `points ⋈ devices`, the only source of a served point since slice 1b.
 *
 * The projection is built per-call rather than held in a module-level const on purpose: a const would
 * dereference the drizzle table objects at IMPORT time, which couples every consumer's test to having
 * a complete `schema` mock. Two suites mock it as `{ pointInfo: {} }`, and a module-level projection
 * turned that into a suite-level crash rather than a query assertion.
 */
function servedPointQuery() {
  return requirePlanetscaleDb()
    .select(servedPointColumns())
    .from(pgPoints)
    .innerJoin(pgDevices, eq(pgDevices.id, pgPoints.deviceId));
}

/**
 * Map a projected row to the served row shape.
 *
 * PG has native `createdAt`/`updatedAt` (Date); the served shape exposes epoch-ms integer columns
 * `createdAtMs`/`updatedAtMs` (number). A missing `createdAt` collapses to 0, a missing `updatedAt`
 * to null.
 */
function pgPointInfoToServed(pgRow: ServedPointDbRow): PointInfoRow {
  return {
    systemId: pgRow.systemId,
    index: pgRow.index,
    pointUid: pgRow.pointUid,
    physicalPathTail: pgRow.physicalPathTail,
    logicalPathStem: pgRow.logicalPathStem,
    metricType: pgRow.metricType,
    metricUnit: pgRow.metricUnit,
    defaultName: pgRow.defaultName,
    displayName: pgRow.displayName,
    subsystem: pgRow.subsystem,
    transform: pgRow.transform,
    active: pgRow.active,
    createdAtMs: pgRow.createdAt ? pgRow.createdAt.getTime() : 0,
    updatedAtMs: pgRow.updatedAt ? pgRow.updatedAt.getTime() : null,
  };
}

/** Map an array of projected rows to the served shape. */
function pgPointInfoRowsToServed(pgRows: ServedPointDbRow[]): PointInfoRow[] {
  return pgRows.map(pgPointInfoToServed);
}

/**
 * Manages monitoring points for devices (backend only)
 */
export class PointManager {
  private static instance: PointManager;
  private static lastLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 60 * 1000; // 1 minute TTL
  private seriesCache = new Map<number, SeriesInfo[]>();

  private constructor() {}

  /**
   * Get cache status information
   */
  static getCacheStatus(): {
    isLoaded: boolean;
    lastLoadedAt: number;
  } {
    return {
      isLoaded:
        PointManager.instance !== null && PointManager.instance !== undefined,
      lastLoadedAt: PointManager.lastLoadedAt,
    };
  }

  /**
   * Get the singleton instance
   * Automatically refreshes cache if TTL has expired
   */
  static getInstance(): PointManager {
    const now = Date.now();
    const cacheAge = now - PointManager.lastLoadedAt;

    // Clear and reload if cache is stale (older than TTL)
    if (PointManager.instance && cacheAge > PointManager.CACHE_TTL_MS) {
      console.log(
        `[PointManager] Cache expired (age: ${Math.round(cacheAge / 1000)}s), clearing...`,
      );
      PointManager.instance = new PointManager();
      PointManager.lastLoadedAt = now;
    }

    if (!PointManager.instance) {
      PointManager.instance = new PointManager();
      PointManager.lastLoadedAt = now;
    }
    return PointManager.instance;
  }

  /**
   * Load a device's own points directly from `points` (joined to `devices` for the handle).
   * PRIVATE: External callers should use getActivePointsForDevice instead.
   */
  private async _loadOwnPoints(systemId: number): Promise<PointInfo[]> {
    const pgRows = await servedPointQuery().where(eq(pgDevices.rid, systemId));
    const rows = pgPointInfoRowsToServed(pgRows);

    return rows.map((row) => PointInfo.from(row));
  }

  /**
   * Get all series for a device (includes all active points, even without type hierarchy)
   * Results are cached per device
   * Works for any viewable handle (a real device or a multi-device area)
   *
   * @param handle - The integer addressing handle (a real device or a multi-device area)
   */
  private async getAllSeriesForDevice(handle: number): Promise<SeriesInfo[]> {
    // Check cache first
    const cached = this.seriesCache.get(handle);
    if (cached) {
      return cached;
    }

    // Get all points for this device (areas-backed → bound refs; real device → own point_info)
    const allPoints = await this._resolvePointsForHandle(handle);
    const systemIdentifier = SystemIdentifier.fromId(handle);

    const seriesInfos: SeriesInfo[] = [];

    for (const point of allPoints) {
      // Only skip inactive points
      if (!point.active) continue;

      // Determine aggregation fields based on metric type
      let aggregationFields: string[];
      if (point.metricType === "energy") {
        // Energy: only delta (+ quality for data source tracking)
        aggregationFields = ["delta", "quality"];
      } else if (point.metricType === "soc") {
        // SOC: last for 5m, avg/min/max/last for 1d (+ quality)
        aggregationFields = ["last", "avg", "min", "max", "quality"];
      } else {
        // Power and other: avg/min/max/last (+ quality)
        aggregationFields = ["avg", "min", "max", "last", "quality"];
      }

      // Create SeriesInfo for each aggregation
      seriesInfos.push(
        ...createSeriesInfos(systemIdentifier, point, aggregationFields),
      );
    }

    // Cache the result
    this.seriesCache.set(handle, seriesInfos);

    return seriesInfos;
  }

  /**
   * Resolve the viewable points for a device handle — the single "resolve viewable" path.
   *
   * An Area is a grouping of 1..N member devices. A **real device** (an area-of-one's source, addressed
   * by its own `systems.id`) loads its own `point_info`. A **multi-device area** (an areas-backed handle
   * with no real `systems` row) resolves under the membership + override model: its typed `area_bindings`
   * SELECT the points (the override), and a curated multi-device area HAS bindings, so its bound child
   * refs ARE the set (unchanged). An area with NO bindings DEFAULTS to the union of its member devices'
   * own points (a plain "several devices in one area"). Dispatched on the structural area-handle signal
   * (no real `systems` row), not a vendorType string.
   *
   * Parity: an area-of-one's union-of-one is byte-identical to loading the device's own points, and
   * every existing multi-device area has bindings, so the union-default branch is dormant for current
   * data.
   *
   * 🔒 **The dispatch is DEVICE-FIRST and that is load-bearing, not stylistic.** A handle can name BOTH
   * a device and an area (handle 13 is a real Sigenergy device AND a 3-member Area). Phase 13 PR 2
   * replaced the `DeviceConfigRegistry.isAreaHandle` probe that used to express this with the same
   * predicate spelled out inline — `deviceByHandle` first, `areaByHandle` only if there is no device —
   * because `isAreaHandle` WAS exactly `!device && area`. The union leg is therefore reached only by a
   * handle with no device of its own, and handle 13 keeps resolving the device's own 12 points. Flipping
   * this to area-first would widen handle 13 to the area's bindings — trap D-l, a scope change on a
   * shared dashboard in the direction that GRANTS access. Both readers are per-request memoized, so
   * asking two questions costs no extra round trip.
   *
   * PRIVATE: external callers should use getActivePointsForDevice instead.
   */
  private async _resolvePointsForHandle(handle: number): Promise<PointInfo[]> {
    // A real device loads its own point_info. A multi-device area (an area handle with no device of its
    // own) resolves area-natively: its typed `area_bindings` SELECT the points (the override); an area
    // with no bindings DEFAULTS to the union of its member devices' own points.
    const device = await DeviceConfigRegistry.deviceByHandle(handle);
    // device-first — LOCKED (see above). `area` stays null for a colliding handle.
    const area = device
      ? null
      : await DeviceConfigRegistry.areaByHandle(handle);
    if (!area) {
      // A device, or a handle that names neither — the latter simply owns no points.
      return this._loadOwnPoints(handle);
    }

    const boundUids = (await getAreaBindingRefs(handle)).map((r) => r.pointUid);

    if (boundUids.length > 0) {
      // Bindings present (override) → the bound child points ARE the set. Each binding carries the
      // point's uuid (`area_bindings.point_uid`, NOT NULL since 0047), so this is one indexed
      // `point_uid IN (…)` rather than the OR-of-(system_id, id) pairs it replaces.
      const pgRows = await servedPointQuery().where(
        inArray(pgPoints.id, boundUids),
      );
      return pgPointInfoRowsToServed(pgRows).map((row) => PointInfo.from(row));
    }

    // No bindings → default to the union of the area's member devices' own points.
    // Membership is uuid-keyed since slice H; `point_info.system_id` is not, so convert. The `!` is
    // safe by `area_members.device_id`'s FK into `devices` — see DeviceRegistry.ridsForDevices.
    const memberIds = await getAreaMemberDeviceIds(area.id);
    const memberRids = await DeviceRegistry.ridsForDevices(memberIds);
    const memberSystemIds = memberIds.map((id) => memberRids.get(id)!);
    const unioned: PointInfo[] = [];
    for (const sid of memberSystemIds) {
      unioned.push(...(await this._loadOwnPoints(sid)));
    }
    return unioned;
  }

  /**
   * Get series for a device (works for any viewable handle — a real device or a multi-device area)
   *
   * Uses cache and applies filtering by pattern/interval/typedOnly
   *
   * @param handle - The integer addressing handle (a real device or a multi-device area)
   * @param filter - Optional array of glob patterns to match against series paths (without device prefix)
   * @param interval - Optional interval to filter by ("5m" or "1d")
   * @param typedOnly - If true, only includes points with type hierarchy (excludes fallback paths). Default: false
   * @returns Series matching the criteria
   */
  async getSeriesForDevice(
    handle: number,
    filter?: string[],
    interval?: "5m" | "1d",
    typedOnly: boolean = false,
  ): Promise<SeriesInfo[]> {
    // Get all series for this device (uses cache)
    let seriesInfos = await this.getAllSeriesForDevice(handle);

    // Filter by interval if provided
    if (interval) {
      seriesInfos = seriesInfos.filter((series) =>
        series.intervals.includes(interval),
      );
    }

    // Filter by typedOnly if requested (points with logicalPathStem)
    if (typedOnly) {
      seriesInfos = seriesInfos.filter(
        (series) => series.point.logicalPathStem !== null,
      );
    }

    // Filter by patterns if provided
    if (filter && filter.length > 0) {
      seriesInfos = seriesInfos.filter((series) => {
        const seriesPath = getSeriesPath(series);

        // getSeriesPath() returns SeriesPath object, convert to string
        // Format: "systemId/pointPath.aggregationField" (e.g., "1/source.solar/power.avg")
        const pathStr = seriesPath.toString();

        // Remove device identifier prefix to match against point path patterns
        // Pattern format: "source.solar/power.avg" (without device prefix)
        const pathWithoutDevice = pathStr.substring(pathStr.indexOf("/") + 1);

        return micromatch.isMatch(pathWithoutDevice, filter);
      });
    }

    return seriesInfos;
  }

  /**
   * Get all active points for a device (handles any viewable handle — a real device or a multi-device area)
   * This is the primary public API for getting point information
   *
   * @param systemId - The device ID
   * @param typedOnly - If true, only includes points with type hierarchy. Default: false
   * @returns Array of unique PointInfo objects
   */
  async getActivePointsForDevice(
    systemId: number,
    typedOnly: boolean = false,
    includeInactive: boolean = false,
  ): Promise<PointInfo[]> {
    // The handle must name SOMETHING — a real device or an Area. Phase 13 PR 2: this used to resolve a
    // synthesized `DeviceConfigView` and read only `.id` off it; the existence check is all that was
    // load-bearing, so it is spelled out against the two real readers instead. Device-first, matching
    // the dispatch in `_resolvePointsForHandle` (trap D-l).
    const exists =
      (await DeviceConfigRegistry.deviceByHandle(systemId)) != null ||
      (await DeviceConfigRegistry.areaByHandle(systemId)) != null;
    if (!exists) {
      throw new Error(`System not found: ${systemId}`);
    }

    // Load points (areas-backed → bound refs; real device → own point_info)
    const allPoints = await this._resolvePointsForHandle(systemId);

    // Filter by active status (unless includeInactive) and optionally by typedOnly
    return allPoints.filter((point) => {
      if (!includeInactive && !point.active) return false;
      if (typedOnly && point.logicalPathStem === null) return false;
      return true;
    });
  }

  /**
   * Invalidate the entire cache (both singleton instance and series cache)
   * This forces a complete reload on next access
   */
  static invalidateCache(): void {
    if (PointManager.instance) {
      PointManager.instance.seriesCache.clear();
    }
    PointManager.instance = undefined as any;
    PointManager.lastLoadedAt = 0;
  }

  /**
   * Invalidate the series cache for a specific device
   * Call this after any write operations to point_info
   */
  invalidateSeriesCache(systemId: number): void {
    this.seriesCache.delete(systemId);
  }

  /**
   * Update a point's information
   * Automatically invalidates the series cache for the affected device
   *
   * config-v4 Phase 12 terminal window: this writes `points` DIRECTLY. It used to update `point_info`
   * and mirror into `points` in one transaction — the mirror existed because an earlier shape wrote only
   * `point_info` here, so every edit drifted `points.name`/`active`/`logical_path`/`transform` (measured
   * on prod 2026-07-28 while re-stemming the Sigenergy site: `point_info.logical_path_stem` said
   * `load.rest-of-house`, `points.logical_path` still said `load`). With `point_info` dropped there is one
   * home, so the drift class is structurally gone rather than mirrored shut, and no transaction is needed.
   *
   * ⚠️ The predicate is driven POSITIVELY on both legs — `points.rid` AND the owning device — rather than
   * on `rid` alone. `rid` is globally unique, so the device leg is not needed for correctness today, but
   * dropping it would silently widen the statement to "any device's point with this rid" the moment a
   * caller passes a mismatched pair.
   */
  async updatePoint(
    systemId: number,
    pointIndex: number, // the global `points.rid`; called `index` in TS code (see mint-point)
    updates: Partial<{
      displayName: string;
      active: boolean;
      logicalPathStem: string | null;
      transform: string | null;
    }>,
  ): Promise<void> {
    const db = requirePlanetscaleDb();
    await db
      .update(pgPoints)
      .set({
        // `point_info`'s column names mapped onto `points`': display_name → name,
        // logical_path_stem → logical_path. Spread-and-rename rather than a blind `...updates` so a new
        // updatable field is a compile error here instead of a silently-ignored key.
        ...(updates.displayName !== undefined
          ? { name: updates.displayName }
          : {}),
        ...(updates.active !== undefined ? { active: updates.active } : {}),
        ...(updates.logicalPathStem !== undefined
          ? { logicalPath: updates.logicalPathStem }
          : {}),
        ...(updates.transform !== undefined
          ? { transform: updates.transform }
          : {}),
        updatedAt: new Date(), // PG native timestamp
      })
      .where(
        and(
          eq(pgPoints.rid, pointIndex),
          inArray(
            pgPoints.deviceId,
            db
              .select({ id: pgDevices.id })
              .from(pgDevices)
              .where(eq(pgDevices.rid, systemId)),
          ),
        ),
      );

    // Invalidate cache for this device
    this.invalidateSeriesCache(systemId);
  }

  // ============================================================================
  // Point Info Map Operations (for batch reading insertions)
  // ============================================================================

  /**
   * Load all point_info entries for a device and create a lookup map
   * Uses physicalPathTail as the key
   */
  async loadPointInfoMap(systemId: number): Promise<PointInfoMap> {
    const pgRows = await servedPointQuery().where(eq(pgDevices.rid, systemId));
    const points = pgPointInfoRowsToServed(pgRows);

    const pointMap: PointInfoMap = {};
    for (const point of points) {
      // Use physicalPathTail as the key
      pointMap[point.physicalPathTail] = point;
    }

    return pointMap;
  }

  /**
   * Get a single point by its physicalPathTail
   * Returns null if the point doesn't exist
   */
  async getPointByPhysicalPathTail(
    systemId: number,
    physicalPathTail: string,
  ): Promise<PointInfoRow | null> {
    const [pgRow] = await servedPointQuery()
      .where(
        and(
          eq(pgDevices.rid, systemId),
          eq(pgPoints.physicalPath, physicalPathTail),
        ),
      )
      .limit(1);

    return pgRow ? pgPointInfoToServed(pgRow) : null;
  }

  /**
   * Get or create a point_info entry
   * Automatically invalidates cache when a new point is created
   */
  async ensurePointInfo(
    systemId: number,
    pointMap: PointInfoMap,
    metadata: PointMetadata,
  ): Promise<PointInfoRow> {
    // Use physicalPathTail as the key - must match loadPointInfoMap
    const key = metadata.physicalPathTail;

    // Return existing if found
    if (pointMap[key]) {
      return pointMap[key];
    }

    console.log(
      `[PointManager] Creating point_info for ${metadata.defaultName} (${metadata.metricType}) at ${metadata.physicalPathTail}`,
    );

    // config-v4 slice M: `points` is PRIMARY. `mintPoint` allocates identity from `points.rid`'s own
    // sequence DEFAULT and writes `point_info` behind it with index == rid — so the old max(index)+1
    // scan (which read the same store it wrote) and its race are both gone, and the C7 invariant
    // "no `point_info` row without a `points` row" is structural rather than mirrored after the fact.
    const pgRow = await mintPoint(systemId, {
      physicalPathTail: metadata.physicalPathTail,
      logicalPathStem: metadata.logicalPathStem,
      metricType: metadata.metricType,
      metricUnit: metadata.metricUnit,
      defaultName: metadata.defaultName,
      displayName: metadata.defaultName, // Initially same as defaultName
      subsystem: metadata.subsystem || null,
      transform: metadata.transform,
    });

    // Map the PG-shaped row back to the legacy row shape this method returns
    // (epoch-ms columns) so downstream callers/pointMap are unchanged.
    const newPoint: PointInfoRow = {
      systemId: pgRow.systemId,
      index: pgRow.index,
      pointUid: pgRow.pointUid,
      physicalPathTail: pgRow.physicalPathTail,
      logicalPathStem: pgRow.logicalPathStem,
      metricType: pgRow.metricType,
      metricUnit: pgRow.metricUnit,
      defaultName: pgRow.defaultName,
      displayName: pgRow.displayName,
      subsystem: pgRow.subsystem,
      transform: pgRow.transform,
      active: pgRow.active,
      createdAtMs: pgRow.createdAt ? pgRow.createdAt.getTime() : 0,
      updatedAtMs: pgRow.updatedAt ? pgRow.updatedAt.getTime() : null,
    };

    // Add to cache
    pointMap[key] = newPoint;

    // Invalidate series cache since we created a new point
    this.invalidateSeriesCache(systemId);

    return newPoint;
  }

  // ============================================================================
  // Reading Write Operations
  // ============================================================================

  /**
   * Batch insert readings for multiple monitoring points
   * Automatically ensures point_info entries exist and converts values based on metadata
   *
   * @param systemId - The device ID
   * @param session - Session info containing id and started timestamp
   * @param readings - Array of readings to insert (receivedTimeMs comes from session.started)
   */
  async insertPointReadingsRaw(
    systemId: number,
    session: SessionInfo,
    readings: Array<{
      pointMetadata: PointMetadata;
      rawValue: any; // Raw value from vendor (will be converted based on metadata)
      measurementTime: number;
      dataQuality?: string;
      error?: string | null;
    }>,
    collector?: import("@/lib/observations/poll-collector").PollCollector,
  ): Promise<void> {
    if (readings.length === 0) return;

    // Load existing points for this device
    const pointMap = await this.loadPointInfoMap(systemId);

    // Get receivedTimeMs from session start time
    const receivedTimeMs = session.started.getTime();

    // Process each reading
    const valuesToInsert = [];
    for (const reading of readings) {
      // Ensure the point exists
      const point = await this.ensurePointInfo(
        systemId,
        pointMap,
        reading.pointMetadata,
      );

      // Convert raw value based on metadata
      const { value, valueStr } = this.convertValueByMetadata(
        reading.rawValue,
        reading.pointMetadata,
      );

      valuesToInsert.push({
        systemId,
        pointId: point.index,
        sessionId: session.id,
        sessionLabel: session.label ?? null,
        measurementTimeMs: reading.measurementTime,
        receivedTimeMs,
        value,
        valueStr,
        error: reading.error || null,
        dataQuality: reading.dataQuality || ("good" as const),
      });
    }

    // Publish observations to queue (before database insert)
    const device = await DeviceConfigRegistry.deviceByHandle(systemId);
    if (device) {
      const inputs = valuesToInsert.map((v) => ({
        sessionId: session.id,
        point: Object.values(pointMap).find((p) => p.index === v.pointId)!,
        value: v.value,
        measurementTimeMs: v.measurementTimeMs,
        receivedTimeMs: v.receivedTimeMs,
        interval: "raw" as const,
      }));
      if (collector) {
        collector.add(inputs);
      } else {
        await publishObservationBatch(device, inputs);
      }
    }

    // Update KV cache with latest values. The raw point_readings and their 5m/1d
    // aggregates are materialised in Postgres by the queue receiver (from the
    // observations published above) — collection no longer writes the serving
    // store directly.
    await this.updateLatestReadingsCache(systemId, valuesToInsert);
  }

  /**
   * Batch insert pre-aggregated 5-minute readings directly to point_readings_agg_5m
   * Use this when the vendor already provides 5-minute aggregated data (e.g., Enphase)
   * Bypasses the point_readings table to avoid redundant storage
   *
   * Value placement by metric type:
   * 1a. Energy with transform='d' (cumulative counter, e.g., total kWh since install):
   *     - last = value (counter value at interval end)
   *     - avg/min/max/delta = null
   *     - Delta will be calculated later from difference between intervals
   *
   * 1b. Energy without transform='d' (interval energy, e.g., kWh produced in 5 minutes):
   *     - delta = value (total energy in this interval)
   *     - avg/min/max/last = null
   *     - This is summed directly into daily aggregates
   *
   * 2. Everything else (power, SOC, etc.):
   *    - avg = min = max = last = value (single measurement per interval)
   *    - delta = null
   *
   * @param systemId - The device ID
   * @param session - Session info (null for historical backfills without a session)
   * @param readings - Array of readings to insert
   */
  async insertPointReadingsAgg5m(
    systemId: number,
    session: SessionInfo | null,
    readings: Array<{
      pointMetadata: PointMetadata;
      rawValue: any; // Raw value from vendor (will be converted based on metadata)
      intervalEndMs: number; // 5-minute interval end time in milliseconds
      error?: string | null;
      dataQuality?: string | null; // 'good', 'forecast', 'actual', 'billable', etc.
    }>,
    collector?: import("@/lib/observations/poll-collector").PollCollector,
  ): Promise<void> {
    if (readings.length === 0) return;

    // Load existing points for this device
    const pointMap = await this.loadPointInfoMap(systemId);

    // Process each reading
    const aggregatesToInsert = [];
    for (const reading of readings) {
      // Ensure the point exists
      const point = await this.ensurePointInfo(
        systemId,
        pointMap,
        reading.pointMetadata,
      );

      // Convert raw value based on metadata
      const { value: numericValue, valueStr: stringValue } =
        this.convertValueByMetadata(reading.rawValue, reading.pointMetadata);

      // For pre-aggregated data with a single value per interval:
      // - Energy metrics with transform='d': value goes into last (cumulative counter), avg/min/max/delta = null
      // - Energy metrics with transform!='d': value goes into delta (total energy), avg/min/max/last = null
      // - Text metrics: valueStr is stored, all numeric fields are null
      // - Other metrics: avg = min = max = last = value, delta = null
      // If both values are null, this is an error reading
      const isError = numericValue === null && stringValue === null;
      const isEnergyCounter =
        point.metricType === "energy" && point.transform === "d";
      const isEnergyDelta =
        point.metricType === "energy" && point.transform !== "d";

      aggregatesToInsert.push({
        systemId,
        pointId: point.index,
        sessionId: session?.id ?? null,
        intervalEnd: reading.intervalEndMs,
        avg: isError || isEnergyCounter || isEnergyDelta ? null : numericValue,
        min: isError || isEnergyCounter || isEnergyDelta ? null : numericValue,
        max: isError || isEnergyCounter || isEnergyDelta ? null : numericValue,
        last:
          !isError && isEnergyCounter
            ? numericValue
            : isError || isEnergyDelta
              ? null
              : numericValue,
        delta: !isError && isEnergyDelta ? numericValue : null,
        valueStr: stringValue,
        sampleCount: isError ? 0 : 1,
        errorCount: isError ? 1 : 0,
        dataQuality: reading.dataQuality ?? null,
      });
    }

    // Publish observations to queue (before database insert)
    // Only publish if we have a session (skip historical backfills)
    const device = await DeviceConfigRegistry.deviceByHandle(systemId);

    // 5m-native vendors (Amber, Enphase) have NO raw point_readings, so their 5m
    // is authoritative and must be published to the queue (→ Postgres via the
    // receiver). Raw vendors' 5m is recomputed in Postgres from their raw
    // point_readings, so there is nothing to publish (or write) here.
    const isNative =
      device != null && isFiveMinuteNativeVendor(device.vendorType);

    if (device && session && aggregatesToInsert.length > 0 && isNative) {
      const inputs = aggregatesToInsert.map((a) => ({
        sessionId: session.id,
        point: Object.values(pointMap).find((p) => p.index === a.pointId)!,
        // Use the most meaningful value: delta for energy, otherwise avg/last, or string value
        value: a.delta ?? a.avg ?? a.last ?? a.valueStr,
        measurementTimeMs: a.intervalEnd,
        receivedTimeMs: Date.now(),
        interval: "5m" as const,
        // Carry the full aggregate tuple so the Postgres mirror is full-fidelity
        agg: {
          avg: a.avg,
          min: a.min,
          max: a.max,
          last: a.last,
          delta: a.delta,
          valueStr: a.valueStr,
          sampleCount: a.sampleCount,
          errorCount: a.errorCount,
          dataQuality: a.dataQuality,
        },
      }));
      if (collector) {
        collector.add(inputs);
      } else {
        await publishObservationBatch(device, inputs);
      }
    } else if (device && session && aggregatesToInsert.length > 0) {
      console.log(
        `[PointManager] raw-vendor 5m for system ${systemId} (${device!.vendorType}) is recomputed in Postgres from raw; nothing to publish (${aggregatesToInsert.length} intervals)`,
      );
    }

    // Note: We intentionally do NOT update the KV cache here.
    // Cache updates should only happen from real-time data in point_readings table
    // via insertPointReadingsRaw(). Pre-aggregated data is typically historical/backfill
    // and should not overwrite the actual latest values in the cache.
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Convert raw value to appropriate storage format based on metadata
   * Returns numeric value in `value` for most types, string value in `valueStr` for text/json types
   */
  private convertValueByMetadata(
    rawValue: any,
    metadata: PointMetadata,
  ): { value: number | null; valueStr: string | null } {
    if (rawValue == null) {
      return { value: null, valueStr: null };
    }

    // Handle text fields - store as string
    if (metadata.metricUnit === "text") {
      return { value: null, valueStr: String(rawValue) };
    }

    // Handle json fields (e.g., location) - store as JSON string
    if (metadata.metricUnit === "json") {
      const jsonStr =
        typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
      return { value: null, valueStr: jsonStr };
    }

    // Handle timestamp fields (epochMs)
    if (metadata.metricUnit === "epochMs") {
      // If it's already a number (Unix timestamp in seconds), convert to ms
      if (typeof rawValue === "number") {
        return { value: rawValue * 1000, valueStr: null };
      }
      // If it's a string (ISO format), parse and convert to ms
      if (typeof rawValue === "string") {
        return { value: new Date(rawValue).getTime(), valueStr: null };
      }
      // If it's a Date object
      if (rawValue instanceof Date) {
        return { value: rawValue.getTime(), valueStr: null };
      }
    }

    // All other fields are numeric
    return { value: Number(rawValue), valueStr: null };
  }

  /**
   * Update KV cache with latest point values
   * This is called after inserting new readings to keep the cache fresh
   */
  private async updateLatestReadingsCache(
    systemId: number,
    valuesToInsert: Array<{
      pointId: number;
      value: number | null;
      valueStr?: string | null;
      measurementTimeMs: number;
      receivedTimeMs: number;
      sessionId?: string | null;
      sessionLabel?: string | null;
    }>,
  ): Promise<void> {
    try {
      const points = await this.getActivePointsForDevice(systemId, false);

      // Get device name for sourceSystemName in KV cache
      const device = await DeviceConfigRegistry.deviceByHandle(systemId);
      const sourceSystemName = device?.displayName;

      // Build summary values and cache updates together
      const summaryValues: Array<{ logicalPath: string; value: number }> = [];
      let maxMeasurementTimeMs = 0;

      const cacheUpdates = valuesToInsert.map((val) => {
        const point = points.find((p: PointInfo) => p.index === val.pointId);
        const logicalPath = point?.getLogicalPath();
        // Combine numeric and string values for cache (KV accepts both)
        const cacheValue = val.value ?? val.valueStr ?? null;
        // Only cache active points with a proper logicalPath and a value
        if (point && cacheValue !== null && logicalPath && point.active) {
          // Collect for system summary (only numeric values)
          if (typeof cacheValue === "number") {
            summaryValues.push({
              logicalPath,
              value: cacheValue,
            });
          }
          if (val.measurementTimeMs > maxMeasurementTimeMs) {
            maxMeasurementTimeMs = val.measurementTimeMs;
          }

          return updateLatestPointValue(
            systemId,
            point.pointUid, // uuid — the subscription-map key AND the stored `pt_` pointReference
            logicalPath,
            cacheValue,
            val.measurementTimeMs,
            val.receivedTimeMs,
            point.metricUnit,
            point.name, // displayName if set, otherwise defaultName
            sourceSystemName,
            val.sessionId ?? undefined,
            val.sessionLabel ?? undefined,
          );
        }
        return Promise.resolve();
      });
      await Promise.all(cacheUpdates);

      // Update system summary (fire-and-forget, don't block)
      if (summaryValues.length > 0) {
        updateSystemSummary(systemId, summaryValues, maxMeasurementTimeMs)
          .then(() => {
            // After updating source summary, update subscriber summaries
            return updateSubscriberSummaries(systemId);
          })
          .catch((err) =>
            console.error("Failed to update system summary:", err),
          );
      }
    } catch (error) {
      console.error("Failed to update KV cache:", error);
      // Don't throw - cache update failures shouldn't break reading insertion
    }
  }
}
