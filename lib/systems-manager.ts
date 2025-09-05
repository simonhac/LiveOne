import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';

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
  private systemsMap: Map<number, any> = new Map();
  private loadPromise: Promise<void>;
  
  constructor() {
    // Load systems immediately on instantiation
    this.loadPromise = this.loadSystems();
  }
  
  /**
   * Load all systems into cache (called once on instantiation)
   */
  private async loadSystems() {
    console.log('[SystemsManager] DB HIT: Loading all systems from database');
    const allSystems = await db
      .select()
      .from(systems);
    
    // Create map for O(1) lookups
    for (const system of allSystems) {
      this.systemsMap.set(system.id, system);
    }
    
    const activeCount = allSystems.filter(s => s.status === 'active').length;
    console.log(`[SystemsManager] Loaded ${allSystems.length} systems (${activeCount} active)`);
  }
  
  /**
   * Get system details by ID
   */
  async getSystem(systemId: number) {
    await this.loadPromise;
    return this.systemsMap.get(systemId) || null;
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
}