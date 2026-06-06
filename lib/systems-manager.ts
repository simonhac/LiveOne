import { db, dbUtils, isProduction } from "@/lib/db/turso";
import { systems, userSystems, pollingStatus } from "@/lib/db/turso/schema";
import { eq, and, max } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";
import { clerkClient } from "@clerk/nextjs/server";
import {
  shadowReadConfig,
  toEpochSeconds,
  normalizeJson,
  SHADOW_SKIP,
} from "@/lib/db/config-shadow";
import { CONFIG_WRITES_TO_PG } from "@/lib/db/routing";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  systems as pgSystems,
  pollingStatus as pgPollingStatus,
} from "@/lib/db/planetscale/schema";

// Export the type for a system from the database
export type System = InferSelectModel<typeof systems>;
export type PollingStatus = InferSelectModel<typeof pollingStatus>;

// Combined system with polling status
export type SystemWithPolling = System & {
  pollingStatus?: PollingStatus | null;
};

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
 * Project a single systems⋈polling_status join row to the fields compared in shadow-diff,
 * normalizing the Turso↔PG schema divergences: second-precision timestamps (Turso
 * integer mode:"timestamp" vs PG microsecond timestamp) and text-json vs jsonb. An
 * unpolled system (polling_status absent) projects `pollingStatus: null` on both sides.
 */
function normalizeSystemRowForShadow(row: {
  systems: Record<string, any>;
  polling_status: Record<string, any> | null;
}): unknown {
  const s = row.systems;
  const p = row.polling_status;
  return {
    id: s.id,
    status: s.status,
    displayName: s.displayName,
    vendorType: s.vendorType,
    vendorSiteId: s.vendorSiteId,
    ownerClerkUserId: s.ownerClerkUserId ?? null,
    alias: s.alias ?? null,
    model: s.model ?? null,
    serial: s.serial ?? null,
    ratings: s.ratings ?? null,
    solarSize: s.solarSize ?? null,
    batterySize: s.batterySize ?? null,
    timezoneOffsetMin: s.timezoneOffsetMin,
    displayTimezone: s.displayTimezone,
    location: normalizeJson(s.location),
    metadata: normalizeJson(s.metadata),
    pollingStatus: p
      ? {
          lastPollTime: toEpochSeconds(p.lastPollTime),
          lastSuccessTime: toEpochSeconds(p.lastSuccessTime),
          lastErrorTime: toEpochSeconds(p.lastErrorTime),
          lastResponse: normalizeJson(p.lastResponse),
          consecutiveErrors: p.consecutiveErrors,
          totalPolls: p.totalPolls,
          successfulPolls: p.successfulPolls,
          updatedAt: toEpochSeconds(p.updatedAt),
        }
      : null,
  };
}

/**
 * Project the full systems⋈polling_status result set into a per-system map (keyed by
 * systemId as a string) so the shadow-diff compares each system independently and reports
 * field-level divergences. Used as `shadowReadConfig`'s `normalize` for loadSystems.
 */
function normalizeSystemsLoadForShadow(rows: unknown): unknown {
  const list = (rows ?? []) as Array<{
    systems: Record<string, any>;
    polling_status: Record<string, any> | null;
  }>;
  const byId: Record<string, unknown> = {};
  for (const row of list) {
    byId[String(row.systems.id)] = normalizeSystemRowForShadow(row);
  }
  return byId;
}

/**
 * Detect a Postgres unique_violation (SQLSTATE '23505'), e.g. the alias-unique collision.
 * `pg` puts the SQLSTATE on the error's `code` field; this is the PG analogue of Turso's
 * SQLITE_CONSTRAINT.
 */
function isPgUniqueViolation(e: unknown): boolean {
  return (
    !!e && typeof e === "object" && (e as { code?: unknown }).code === "23505"
  );
}

/**
 * Manages system data with caching to avoid repeated database queries
 * during a single request/operation.
 *
 * NOTE: Currently fetches all systems at once for simplicity.
 * This approach works well for small-to-medium deployments (< 1000 systems).
 * For larger deployments, consider:
 * - Implementing pagination or lazy loading
 * - Using a proper caching layer (Redis)
 * - Fetching only required systems per request
 */
export class SystemsManager {
  private static instance: SystemsManager | null = null;
  private static lastLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 60 * 1000; // 1 minute TTL
  private systemsMap: Map<number, SystemWithPolling> = new Map();
  private loadPromise: Promise<void>;

  private constructor() {
    // Load systems immediately on instantiation
    this.loadPromise = this.loadSystems();
  }

  /**
   * Get cache status information
   */
  static getCacheStatus(): {
    isLoaded: boolean;
    lastLoadedAt: number;
  } {
    return {
      isLoaded: SystemsManager.instance !== null,
      lastLoadedAt: SystemsManager.lastLoadedAt,
    };
  }

  /**
   * Get the singleton instance of SystemsManager
   * Automatically refreshes cache if TTL has expired
   */
  static getInstance(): SystemsManager {
    const now = Date.now();
    const cacheAge = now - SystemsManager.lastLoadedAt;

    // Clear and reload if cache is stale (older than TTL)
    if (SystemsManager.instance && cacheAge > SystemsManager.CACHE_TTL_MS) {
      console.log(
        `[SystemsManager] Cache expired (age: ${Math.round(cacheAge / 1000)}s), reloading...`,
      );
      SystemsManager.instance = null;
      SystemsManager.lastLoadedAt = 0;
    }

    if (!SystemsManager.instance) {
      SystemsManager.instance = new SystemsManager();
      SystemsManager.lastLoadedAt = now;
    }
    return SystemsManager.instance;
  }

  /**
   * Invalidate the cache (useful for cron jobs that need fresh data)
   *
   * TEMPORARY: This is a workaround for the cache consistency issue where
   * the singleton persists across requests in Vercel/Next.js, causing stale
   * polling status data. We need a proper cache invalidation strategy.
   *
   * TODO: Implement proper cache management with TTL, invalidation on updates,
   * or request-scoped instances instead of global singletons.
   */
  static invalidateCache(): void {
    SystemsManager.instance = null;
  }

  /**
   * @deprecated Use invalidateCache() instead
   */
  static clearInstance(): void {
    SystemsManager.invalidateCache();
  }

  /**
   * Load all systems with polling status into cache (called once on instantiation).
   *
   * PR-8 (1A): the systems⋈polling_status read is funneled through `shadowReadConfig`.
   * The SERVED rows are ALWAYS the Turso join; when `CONFIG_READS_FROM_PG` is on we
   * additionally run the same join against Postgres, project both to a per-system Map,
   * and log any divergence (best-effort; PG errors swallowed). See lib/db/config-shadow.ts.
   */
  private async loadSystems() {
    // Join systems with polling_status to get everything in one query.
    const allSystemsWithPolling = await shadowReadConfig(
      "SystemsManager.loadSystems",
      async () =>
        db
          .select()
          .from(systems)
          .leftJoin(pollingStatus, eq(systems.id, pollingStatus.systemId)),
      {
        pgRead: async () => {
          if (!planetscaleDb) return SHADOW_SKIP;
          return planetscaleDb
            .select()
            .from(pgSystems)
            .leftJoin(
              pgPollingStatus,
              eq(pgSystems.id, pgPollingStatus.systemId),
            );
        },
        normalize: normalizeSystemsLoadForShadow,
      },
    );

    // Create map for O(1) lookups
    for (const row of allSystemsWithPolling) {
      const systemWithPolling: SystemWithPolling = {
        ...row.systems,
        pollingStatus: row.polling_status,
      };
      this.systemsMap.set(row.systems.id, systemWithPolling);
    }

    const allSystemsArray = Array.from(this.systemsMap.values());
    const activeCount = allSystemsArray.filter(
      (s) => s.status === "active",
    ).length;
    console.log(
      `[SystemsManager] DB HIT: Loaded ${allSystemsArray.length} systems (${activeCount} active) from database`,
    );
  }

  /**
   * Get system details by ID (with polling status)
   */
  async getSystem(systemId: number): Promise<SystemWithPolling | null> {
    await this.loadPromise;
    return this.systemsMap.get(systemId) || null;
  }

  /**
   * Get system by vendor site ID
   */
  async getSystemByVendorSiteId(
    vendorSiteId: string,
  ): Promise<SystemWithPolling | null> {
    await this.loadPromise;
    for (const system of this.systemsMap.values()) {
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
    await this.loadPromise;

    // Find all systems with matching alias
    const matchingSystems = Array.from(this.systemsMap.values()).filter(
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
    await this.loadPromise;
    return Array.from(this.systemsMap.values()).filter(
      (s) => s.status === "active",
    );
  }

  /**
   * Get all systems (including inactive)
   */
  async getAllSystems(): Promise<SystemWithPolling[]> {
    await this.loadPromise;
    return Array.from(this.systemsMap.values());
  }

  /**
   * Get multiple systems by IDs
   */
  async getSystems(systemIds: number[]): Promise<SystemWithPolling[]> {
    await this.loadPromise;
    return systemIds
      .map((id) => this.systemsMap.get(id))
      .filter((system) => system !== undefined);
  }

  /**
   * Check if a system exists and is active
   */
  async systemIsActive(systemId: number): Promise<boolean> {
    await this.loadPromise;
    const system = this.systemsMap.get(systemId);
    return system ? system.status === "active" : false;
  }

  /**
   * Check if a system exists (any status)
   */
  async systemExists(systemId: number): Promise<boolean> {
    await this.loadPromise;
    return this.systemsMap.has(systemId);
  }

  /**
   * Get all systems visible to a user (for dropdown menus, etc.)
   * - Admins see all active systems
   * - Regular users see their own active systems and systems they have access to
   * @param userId - The clerk user ID
   * @param activeOnly - Whether to filter to only active systems (default: true)
   */
  async getSystemsVisibleByUser(userId: string, activeOnly: boolean = true) {
    await this.loadPromise;
    const isAdmin = await isUserAdmin();

    let visibleSystems: SystemWithPolling[] = [];
    const allSystemsArray = Array.from(this.systemsMap.values());

    if (isAdmin) {
      // Admins see all systems (optionally filtered by status)
      visibleSystems = allSystemsArray
        .filter((s) => !activeOnly || s.status === "active")
        .filter((s) => s.displayName && s.vendorSiteId); // Must have display name and vendor site ID
    } else {
      // Get systems the user owns
      const ownedSystems = allSystemsArray.filter(
        (s) => s.ownerClerkUserId === userId,
      );

      // Get systems the user has been granted access to
      const grantedAccess = await db
        .select()
        .from(userSystems)
        .where(eq(userSystems.clerkUserId, userId));

      const grantedSystemIds = new Set(grantedAccess.map((ua) => ua.systemId));

      // Combine owned and granted systems
      const userVisibleSystems = [
        ...ownedSystems,
        ...allSystemsArray.filter(
          (s) => grantedSystemIds.has(s.id) && s.ownerClerkUserId !== userId,
        ),
      ];

      // Filter by status and required fields
      visibleSystems = userVisibleSystems
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
   * Create a new system in the database and update the cache
   * @param systemData - The system data to insert
   * @returns The created system
   */
  async createSystem(systemData: CreateSystemData): Promise<System> {
    await this.loadPromise;

    // PR-8 (1B): config writes route on CONFIG_WRITES_TO_PG. OFF (default) = today's
    // Turso write, unchanged. ON = write to Postgres ONLY (decision B: config writes are
    // Postgres-only, no dual-write soak). The in-memory cache behaviour is unchanged.
    const newSystem = CONFIG_WRITES_TO_PG
      ? await this.insertSystemToPg(systemData)
      : await this.insertSystemToTurso(systemData);

    console.log(
      `[SystemsManager] Created system ${newSystem.id} (${systemData.vendorType}) for user ${systemData.ownerClerkUserId}`,
    );

    // Invalidate cache and refresh immediately
    SystemsManager.invalidateCache();
    const freshManager = SystemsManager.getInstance();
    await freshManager.loadPromise;

    console.log(
      `[SystemsManager] Cache refreshed after creating system ${newSystem.id}`,
    );

    return newSystem;
  }

  /**
   * Today's write path: insert the system into Turso (unchanged behaviour, used when
   * CONFIG_WRITES_TO_PG is OFF). Turso surfaces an alias-unique collision as a
   * SQLITE_CONSTRAINT error from the underlying client.
   */
  private async insertSystemToTurso(
    systemData: CreateSystemData,
  ): Promise<System> {
    // In dev environment, get explicit ID starting from 10000
    const systemId = !isProduction
      ? await dbUtils.getNextDevSystemId()
      : undefined;

    const [newSystem] = await db
      .insert(systems)
      .values({
        id: systemId, // Only set in dev mode, undefined in production (auto-increment)
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

    return newSystem;
  }

  /**
   * PR-8 (1B) write path: insert the system into Postgres ONLY (used when
   * CONFIG_WRITES_TO_PG is ON — nothing is written to Turso). The PG alias-unique
   * collision is a unique_violation, surfaced with SQLSTATE '23505' (not
   * SQLITE_CONSTRAINT); rethrown unchanged so callers keep their existing handling.
   */
  private async insertSystemToPg(
    systemData: CreateSystemData,
  ): Promise<System> {
    if (!planetscaleDb) {
      throw new Error(
        "[SystemsManager] CONFIG_WRITES_TO_PG is on but Postgres is not configured",
      );
    }

    // Mirror Turso's dev-id policy (explicit ids from 10000 in dev, serial in prod),
    // computed against PG's own systems table since the PG sequence is independent.
    let systemId: number | undefined = undefined;
    if (!isProduction) {
      const DEV_SYSTEM_ID_START = 10000;
      const [{ maxId }] = await planetscaleDb
        .select({ maxId: max(pgSystems.id) })
        .from(pgSystems);
      systemId =
        maxId && maxId >= DEV_SYSTEM_ID_START ? maxId + 1 : DEV_SYSTEM_ID_START;
    }

    try {
      const [newSystem] = await planetscaleDb
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

      // PG createdAt/updatedAt are Date-typed (same as Turso's timestamp mode); the row
      // is structurally the System shape the caller expects.
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
