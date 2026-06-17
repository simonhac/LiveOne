import { cache } from "react";
import { eq, max, isNotNull } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";
import { isProduction } from "@/lib/env";
import { clerkClient } from "@clerk/nextjs/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  systems as pgSystems,
  pollingStatus as pgPollingStatus,
  userSystems as pgUserSystems,
  areas as pgAreas,
} from "@/lib/db/planetscale/schema";

// Export the type for a system from the database
export type System = InferSelectModel<typeof pgSystems>;
export type PollingStatus = InferSelectModel<typeof pgPollingStatus>;

export type Area = InferSelectModel<typeof pgAreas>;

// Combined system with polling status
export type SystemWithPolling = System & {
  pollingStatus?: PollingStatus | null;
};

/**
 * An "area view" — a SystemWithPolling shape synthesized from a multi-device Area whose integer
 * addressing handle (`legacy_system_id`) has NO real `systems` row. It is the SERVER-ONLY resolution
 * of that handle for the dashboard data path (points/flow/auth resolve via `area_bindings` + members);
 * it is deliberately kept OUT of `systemsMap`, so an area view never appears in the systems/devices/
 * admin lists or polling. Owns no points and never polls, so device/polling fields are null.
 */
function synthesizeAreaView(area: Area): SystemWithPolling | null {
  if (area.legacySystemId == null) return null;
  return {
    id: area.legacySystemId,
    ownerClerkUserId: area.ownerClerkUserId,
    vendorType: "area",
    vendorSiteId: `area:${area.legacySystemId}`,
    status: area.status,
    displayName: area.displayName,
    alias: area.alias,
    model: null,
    serial: null,
    ratings: null,
    solarSize: null,
    batterySize: null,
    location: area.location,
    metadata: null,
    timezoneOffsetMin: area.timezoneOffsetMin,
    displayTimezone: area.displayTimezone,
    createdAt: area.createdAt,
    updatedAt: area.updatedAt,
    pollingStatus: null,
  };
}

// Input shape for creating a system (shared by createSystem and its routed inserts).
type CreateSystemData = {
  ownerClerkUserId: string;
  vendorType: string;
  vendorSiteId: string;
  status?: string;
  displayName: string;
  alias?: string | null;
  model?: string | null;
  serial?: string | null;
  ratings?: string | null;
  solarSize?: string | null;
  batterySize?: string | null;
  location?: any;
  metadata?: any;
  timezoneOffsetMin?: number;
  displayTimezone?: string;
};

/**
 * Detect a Postgres unique_violation (SQLSTATE '23505'), e.g. the alias-unique collision.
 * `pg` puts the SQLSTATE on the error's `code` field.
 */
function isPgUniqueViolation(e: unknown): boolean {
  return (
    !!e && typeof e === "object" && (e as { code?: unknown }).code === "23505"
  );
}

/**
 * The fully-resolved systems config: real `systems` rows (systemsMap) plus the area views — Area
 * handles with no real row, kept SEPARATE so they never leak into the systems/devices/admin lists.
 */
type SystemsState = {
  systemsMap: Map<number, SystemWithPolling>;
  areaViewsMap: Map<number, SystemWithPolling>;
};

/**
 * Load the full systems config once per request, memoized by React's `cache()`.
 *
 * `cache()` is scoped to a single server request (Server Components AND Route Handlers): every
 * accessor below shares one load within a request, and nothing is shared across requests — config
 * is therefore always fresh, with no TTL, no invalidation, and no stale-across-warm-lambdas problem.
 * Outside a request (Jest, scripts) `cache()` simply runs each call unmemoized — correct, just not
 * deduped; correctness never depends on the memoization.
 *
 * Reads the systems⋈polling_status join from Postgres (the only store), then synthesizes the area
 * views into a separate map.
 *
 * NOTE: fetches all systems at once for simplicity — fine for small-to-medium deployments
 * (< 1000 systems). For larger ones, switch to targeted per-id queries.
 */
const loadSystemsState = cache(async (): Promise<SystemsState> => {
  const systemsMap = new Map<number, SystemWithPolling>();
  const areaViewsMap = new Map<number, SystemWithPolling>();

  // Join systems with polling_status to get everything in one query.
  const allSystemsWithPolling = await requirePlanetscaleDb()
    .select()
    .from(pgSystems)
    .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId));

  for (const row of allSystemsWithPolling) {
    systemsMap.set(row.systems.id, {
      ...row.systems,
      pollingStatus: row.polling_status,
    });
  }

  // Area views: one per Area whose addressing handle (legacy_system_id) has NO real `systems` row
  // (a multi-device Area). Loaded into a SEPARATE map — they resolve for the dashboard data path
  // but never appear in the systems/devices/admin lists or polling.
  const handleAreas = await requirePlanetscaleDb()
    .select()
    .from(pgAreas)
    .where(isNotNull(pgAreas.legacySystemId));
  for (const area of handleAreas) {
    if (area.legacySystemId == null) continue;
    if (systemsMap.has(area.legacySystemId)) continue; // real row wins (identity Areas)
    const view = synthesizeAreaView(area);
    if (view) areaViewsMap.set(area.legacySystemId, view);
  }

  return { systemsMap, areaViewsMap };
});

/**
 * Reads system config. A stateless facade over the per-request `cache()`-memoized
 * `loadSystemsState()` — `getInstance()` does no DB work and holds no data, so the config is loaded
 * (at most) once per request and is always fresh. Mutations write straight through; the next request
 * loads the change automatically (no invalidation needed).
 */
export class SystemsManager {
  private static instance: SystemsManager | null = null;

  private constructor() {}

  /**
   * Get the (stateless) SystemsManager facade. Cheap: no DB work, no cross-request cache.
   */
  static getInstance(): SystemsManager {
    return (SystemsManager.instance ??= new SystemsManager());
  }

  /**
   * Get system details by ID (with polling status)
   */
  async getSystem(systemId: number): Promise<SystemWithPolling | null> {
    const { systemsMap } = await loadSystemsState();
    return systemsMap.get(systemId) || null;
  }

  /**
   * Resolve a handle for the DASHBOARD DATA PATH: a real system, OR an area view (a multi-device Area
   * with no `systems` row). Use this — not getSystem — wherever an Area's whole-area data/auth/flow is
   * served, so the area handle resolves. getSystem stays real-only (devices/admin/polling).
   */
  async getViewableSystem(systemId: number): Promise<SystemWithPolling | null> {
    const { systemsMap, areaViewsMap } = await loadSystemsState();
    return systemsMap.get(systemId) ?? areaViewsMap.get(systemId) ?? null;
  }

  /** Whether `systemId` is an area view (a multi-device Area handle with no real `systems` row). */
  async isAreaHandle(systemId: number): Promise<boolean> {
    const { areaViewsMap } = await loadSystemsState();
    return areaViewsMap.has(systemId);
  }

  /** Active area-view handles (multi-device Area handles) — included in the daily flow recompute. */
  async getActiveAreaHandles(): Promise<number[]> {
    const { areaViewsMap } = await loadSystemsState();
    return Array.from(areaViewsMap.values())
      .filter((v) => v.status === "active")
      .map((v) => v.id);
  }

  /**
   * Get system by vendor site ID
   */
  async getSystemByVendorSiteId(
    vendorSiteId: string,
  ): Promise<SystemWithPolling | null> {
    const { systemsMap } = await loadSystemsState();
    for (const system of systemsMap.values()) {
      if (system.vendorSiteId === vendorSiteId) {
        return system;
      }
    }
    return null;
  }

  /**
   * Get system by username and alias
   */
  async getSystemByUsernameAndAlias(
    username: string,
    alias: string,
  ): Promise<SystemWithPolling | null> {
    const { systemsMap } = await loadSystemsState();

    // Find all systems with matching alias
    const matchingSystems = Array.from(systemsMap.values()).filter(
      (system) => system.alias === alias,
    );

    if (matchingSystems.length === 0) {
      return null;
    }

    // Query Clerk to find which system owner has this username
    const client = await clerkClient();

    for (const system of matchingSystems) {
      if (!system.ownerClerkUserId) continue;

      try {
        const user = await client.users.getUser(system.ownerClerkUserId);
        if (user.username === username) {
          return system;
        }
      } catch (error) {
        // User not found or error - skip this system
        console.error(`Error fetching user ${system.ownerClerkUserId}:`, error);
        continue;
      }
    }

    return null;
  }

  /**
   * Get all active systems only
   */
  async getActiveSystems(): Promise<SystemWithPolling[]> {
    const { systemsMap } = await loadSystemsState();
    return Array.from(systemsMap.values()).filter((s) => s.status === "active");
  }

  /**
   * Get all systems (including inactive)
   */
  async getAllSystems(): Promise<SystemWithPolling[]> {
    const { systemsMap } = await loadSystemsState();
    return Array.from(systemsMap.values());
  }

  /**
   * Get multiple systems by IDs
   */
  async getSystems(systemIds: number[]): Promise<SystemWithPolling[]> {
    const { systemsMap } = await loadSystemsState();
    return systemIds
      .map((id) => systemsMap.get(id))
      .filter((system) => system !== undefined);
  }

  /**
   * Check if a system exists and is active
   */
  async systemIsActive(systemId: number): Promise<boolean> {
    const { systemsMap } = await loadSystemsState();
    const system = systemsMap.get(systemId);
    return system ? system.status === "active" : false;
  }

  /**
   * Check if a system exists (any status)
   */
  async systemExists(systemId: number): Promise<boolean> {
    const { systemsMap } = await loadSystemsState();
    return systemsMap.has(systemId);
  }

  /**
   * Get all systems visible to a user (for dropdown menus, etc.)
   * - Admins see all active systems
   * - Regular users see their own active systems and systems they have access to
   * @param userId - The clerk user ID
   * @param activeOnly - Whether to filter to only active systems (default: true)
   */
  async getSystemsVisibleByUser(userId: string, activeOnly: boolean = true) {
    const { systemsMap } = await loadSystemsState();
    const isAdmin = await isUserAdmin();

    let visibleSystems: SystemWithPolling[] = [];
    const allSystemsArray = Array.from(systemsMap.values());

    if (isAdmin) {
      // Admins see all systems (optionally filtered by status)
      visibleSystems = allSystemsArray
        .filter((s) => !activeOnly || s.status === "active")
        .filter((s) => s.displayName && s.vendorSiteId); // Must have display name and vendor site ID
    } else {
      // Systems the user has been granted access to
      const grantedAccess = await requirePlanetscaleDb()
        .select()
        .from(pgUserSystems)
        .where(eq(pgUserSystems.clerkUserId, userId));
      const grantedSystemIds = new Set(grantedAccess.map((ua) => ua.systemId));

      // A user sees: systems they own + systems shared with them + PUBLIC (ownerless)
      // systems, which are readable by everyone. Dedupe by id.
      const visibleById = new Map<number, SystemWithPolling>();
      for (const s of allSystemsArray) {
        const isOwner = s.ownerClerkUserId === userId;
        const isGranted = grantedSystemIds.has(s.id);
        const isPublic = s.ownerClerkUserId == null;
        if (isOwner || isGranted || isPublic) visibleById.set(s.id, s);
      }

      // Filter by status and required fields
      visibleSystems = Array.from(visibleById.values())
        .filter((s) => !activeOnly || s.status === "active")
        .filter((s) => s.displayName && s.vendorSiteId);
    }

    // Sort by display name and return simplified objects
    return visibleSystems
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((s) => ({
        id: s.id,
        displayName: s.displayName,
        vendorSiteId: s.vendorSiteId,
        vendorType: s.vendorType,
        status: s.status,
        ownerClerkUserId: s.ownerClerkUserId,
        alias: s.alias,
      }));
  }

  /**
   * The user's "primary" visible system — owned-first, else the first visible (by display name), or
   * null if they can see none. Single source of truth for the `/dashboard` landing redirect and the
   * "Go to Systems" (`/device`) redirect, which previously each copy-pasted this owned-first logic.
   */
  async getPrimaryVisibleSystem(userId: string) {
    const visible = await this.getSystemsVisibleByUser(userId, true);
    if (visible.length === 0) return null;
    const owned = visible.filter((s) => s.ownerClerkUserId === userId);
    return owned.length > 0 ? owned[0] : visible[0];
  }

  /**
   * Create a new system in the database.
   * @param systemData - The system data to insert
   * @returns The created system
   */
  async createSystem(systemData: CreateSystemData): Promise<System> {
    const newSystem = await this.insertSystemToPg(systemData);

    console.log(
      `[SystemsManager] Created system ${newSystem.id} (${systemData.vendorType}) for user ${systemData.ownerClerkUserId}`,
    );

    // Areas are LAZY: a new system gets no identity Area at create-time. One is minted on demand the
    // moment it's actually needed — when the system forms a complete flow role set (the daily
    // `resolveLogicalSystem` heal) or when its location is set (`/api/systems/[id]/location`). This
    // stops bare monitoring-only systems (e.g. public grid-region feeds) accruing pointless Area rows.
    // Serving works without an Area: a real device resolves its OWN point_info, not via an Area.

    // No cache to invalidate: config is loaded per-request, so the next request sees the new system.
    return newSystem;
  }

  /**
   * Update an existing system.
   *
   * Updates Postgres only (config writes are Postgres-only). The patch maps 1:1 —
   * PG jsonb/timestamp columns accept plain objects/Dates directly, so no per-field
   * mapping is needed. `updatedAt` is always stamped to now regardless of the patch.
   */
  async updateSystem(systemId: number, patch: Partial<System>): Promise<void> {
    // Never let the caller override the id or the freshly-stamped updatedAt.
    const { id: _ignoredId, updatedAt: _ignoredUpdatedAt, ...rest } = patch;
    const values = { ...rest, updatedAt: new Date() };

    await requirePlanetscaleDb()
      .update(pgSystems)
      .set(values as Partial<InferSelectModel<typeof pgSystems>>)
      .where(eq(pgSystems.id, systemId));
  }

  /**
   * Delete a system.
   *
   * Deletes from Postgres only.
   */
  async deleteSystem(systemId: number): Promise<void> {
    await requirePlanetscaleDb()
      .delete(pgSystems)
      .where(eq(pgSystems.id, systemId));
  }

  /**
   * Insert the system into Postgres. The alias-unique collision is a unique_violation,
   * surfaced with SQLSTATE '23505'; rethrown unchanged so callers keep their handling.
   */
  private async insertSystemToPg(
    systemData: CreateSystemData,
  ): Promise<System> {
    const pg = requirePlanetscaleDb();

    // Dev-id policy: explicit ids from 10000 in dev, serial in prod.
    let systemId: number | undefined = undefined;
    if (!isProduction()) {
      const DEV_SYSTEM_ID_START = 10000;
      const [{ maxId }] = await pg
        .select({ maxId: max(pgSystems.id) })
        .from(pgSystems);
      systemId =
        maxId && maxId >= DEV_SYSTEM_ID_START ? maxId + 1 : DEV_SYSTEM_ID_START;
    }

    try {
      const [newSystem] = await pg
        .insert(pgSystems)
        .values({
          ...(systemId !== undefined ? { id: systemId } : {}),
          ownerClerkUserId: systemData.ownerClerkUserId,
          vendorType: systemData.vendorType,
          vendorSiteId: systemData.vendorSiteId,
          status: systemData.status || "active",
          displayName: systemData.displayName,
          alias: systemData.alias,
          model: systemData.model,
          serial: systemData.serial,
          ratings: systemData.ratings,
          solarSize: systemData.solarSize,
          batterySize: systemData.batterySize,
          location: systemData.location,
          metadata: systemData.metadata,
          timezoneOffsetMin: systemData.timezoneOffsetMin ?? 600, // Default to AEST
          displayTimezone: systemData.displayTimezone ?? "Australia/Melbourne", // Default timezone
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      // PG createdAt/updatedAt are Date-typed; the row is structurally the System
      // shape the caller expects.
      return newSystem as unknown as System;
    } catch (e) {
      if (isPgUniqueViolation(e)) {
        console.warn(
          `[SystemsManager] Postgres alias-unique collision (23505) creating system for user ${systemData.ownerClerkUserId}`,
        );
      }
      throw e;
    }
  }
}
