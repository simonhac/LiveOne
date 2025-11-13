import { db, dbUtils, isProduction } from "@/lib/db";
import { systems, userSystems, pollingStatus } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";
import { clerkClient } from "@clerk/nextjs/server";

// Export the type for a system from the database
export type System = InferSelectModel<typeof systems>;
export type PollingStatus = InferSelectModel<typeof pollingStatus>;

// Combined system with polling status
export type SystemWithPolling = System & {
  pollingStatus?: PollingStatus | null;
};

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
   * Clear the cached instance (useful for cron jobs that need fresh data)
   *
   * TEMPORARY: This is a workaround for the cache consistency issue where
   * the singleton persists across requests in Vercel/Next.js, causing stale
   * polling status data. We need a proper cache invalidation strategy.
   *
   * TODO: Implement proper cache management with TTL, invalidation on updates,
   * or request-scoped instances instead of global singletons.
   */
  static clearInstance(): void {
    SystemsManager.instance = null;
  }

  /**
   * Load all systems with polling status into cache (called once on instantiation)
   */
  private async loadSystems() {
    // Join systems with polling_status to get everything in one query
    const allSystemsWithPolling = await db
      .select()
      .from(systems)
      .leftJoin(pollingStatus, eq(systems.id, pollingStatus.systemId));

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
   * Get system by username and short name
   */
  async getSystemByUserNameShortName(
    username: string,
    shortName: string,
  ): Promise<SystemWithPolling | null> {
    await this.loadPromise;

    // Find all systems with matching shortname
    const matchingSystems = Array.from(this.systemsMap.values()).filter(
      (system) => system.shortName === shortName,
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
        shortName: s.shortName,
      }));
  }

  /**
   * Create a new system in the database and update the cache
   * @param systemData - The system data to insert
   * @returns The created system
   */
  async createSystem(systemData: {
    ownerClerkUserId: string;
    vendorType: string;
    vendorSiteId: string;
    status?: string;
    displayName: string;
    shortName?: string | null;
    model?: string | null;
    serial?: string | null;
    ratings?: string | null;
    solarSize?: string | null;
    batterySize?: string | null;
    location?: any;
    metadata?: any;
    timezoneOffsetMin?: number;
  }): Promise<System> {
    await this.loadPromise;

    // In dev environment, get explicit ID starting from 10000
    const systemId = !isProduction
      ? await dbUtils.getNextDevSystemId()
      : undefined;

    // Create the system in the database
    const [newSystem] = await db
      .insert(systems)
      .values({
        id: systemId, // Only set in dev mode, undefined in production (auto-increment)
        ownerClerkUserId: systemData.ownerClerkUserId,
        vendorType: systemData.vendorType,
        vendorSiteId: systemData.vendorSiteId,
        status: systemData.status || "active",
        displayName: systemData.displayName,
        shortName: systemData.shortName,
        model: systemData.model,
        serial: systemData.serial,
        ratings: systemData.ratings,
        solarSize: systemData.solarSize,
        batterySize: systemData.batterySize,
        location: systemData.location,
        metadata: systemData.metadata,
        timezoneOffsetMin: systemData.timezoneOffsetMin ?? 600, // Default to AEST
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    console.log(
      `[SystemsManager] Created system ${newSystem.id} (${systemData.vendorType}) for user ${systemData.ownerClerkUserId}`,
    );

    // Invalidate cache and refresh immediately
    SystemsManager.clearInstance();
    const freshManager = SystemsManager.getInstance();
    await freshManager.loadPromise;

    console.log(
      `[SystemsManager] Cache refreshed after creating system ${newSystem.id}`,
    );

    return newSystem;
  }
}
