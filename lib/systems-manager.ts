import { db } from '@/lib/db';
import { systems, userSystems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { isUserAdmin } from '@/lib/auth-utils';
import { clerkClient } from '@clerk/nextjs/server';

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
  private systemsMap: Map<number, any> = new Map();
  private loadPromise: Promise<void>;

  private constructor() {
    // Load systems immediately on instantiation
    this.loadPromise = this.loadSystems();
  }

  /**
   * Get the singleton instance of SystemsManager
   */
  static getInstance(): SystemsManager {
    if (!SystemsManager.instance) {
      SystemsManager.instance = new SystemsManager();
    }
    return SystemsManager.instance;
  }
  
  /**
   * Load all systems into cache (called once on instantiation)
   */
  private async loadSystems() {
    const allSystems = await db
      .select()
      .from(systems);
    
    // Create map for O(1) lookups
    for (const system of allSystems) {
      this.systemsMap.set(system.id, system);
    }
    
    const activeCount = allSystems.filter(s => s.status === 'active').length;
    console.log(`[SystemsManager] DB HIT: Loaded ${allSystems.length} systems (${activeCount} active) from database`);
  }
  
  /**
   * Get system details by ID
   */
  async getSystem(systemId: number) {
    await this.loadPromise;
    return this.systemsMap.get(systemId) || null;
  }
  
  /**
   * Get system by vendor site ID
   */
  async getSystemByVendorSiteId(vendorSiteId: string) {
    await this.loadPromise;
    for (const system of this.systemsMap.values()) {
      if (system.vendorSiteId === vendorSiteId) {
        return system;
      }
    }
    return null;
  }
  
  /**
   * Get all active systems only
   */
  async getActiveSystems() {
    await this.loadPromise;
    return Array.from(this.systemsMap.values()).filter(s => s.status === 'active');
  }
  
  /**
   * Get all systems (including inactive)
   */
  async getAllSystems() {
    await this.loadPromise;
    return Array.from(this.systemsMap.values());
  }
  
  /**
   * Get multiple systems by IDs
   */
  async getSystems(systemIds: number[]) {
    await this.loadPromise;
    return systemIds
      .map(id => this.systemsMap.get(id))
      .filter(system => system !== undefined);
  }
  
  /**
   * Check if a system exists and is active
   */
  async systemIsActive(systemId: number): Promise<boolean> {
    await this.loadPromise;
    const system = this.systemsMap.get(systemId);
    return system ? system.status === 'active' : false;
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
    
    let visibleSystems: any[] = [];
    const allSystemsArray = Array.from(this.systemsMap.values());
    
    if (isAdmin) {
      // Admins see all systems (optionally filtered by status)
      visibleSystems = allSystemsArray
        .filter(s => !activeOnly || s.status === 'active')
        .filter(s => s.displayName && s.vendorSiteId); // Must have display name and vendor site ID
    } else {
      // Get systems the user owns
      const ownedSystems = allSystemsArray.filter(s => s.ownerClerkUserId === userId);
      
      // Get systems the user has been granted access to
      const grantedAccess = await db
        .select()
        .from(userSystems)
        .where(eq(userSystems.clerkUserId, userId));
      
      const grantedSystemIds = new Set(grantedAccess.map(ua => ua.systemId));
      
      // Combine owned and granted systems
      const userVisibleSystems = [
        ...ownedSystems,
        ...allSystemsArray.filter(s => grantedSystemIds.has(s.id) && s.ownerClerkUserId !== userId)
      ];
      
      // Filter by status and required fields
      visibleSystems = userVisibleSystems
        .filter(s => !activeOnly || s.status === 'active')
        .filter(s => s.displayName && s.vendorSiteId);
    }
    
    // Sort by display name and return simplified objects
    return visibleSystems
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map(s => ({
        id: s.id,
        displayName: s.displayName,
        vendorSiteId: s.vendorSiteId,
        vendorType: s.vendorType,
        status: s.status
      }));
  }
}