import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

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
  private loaded = false;
  
  /**
   * Load all active systems into cache
   */
  private async loadSystems() {
    if (this.loaded) return;
    
    const allSystems = await db
      .select()
      .from(systems)
      .where(eq(systems.status, 'active'));
    
    // Create map for O(1) lookups
    for (const system of allSystems) {
      this.systemsMap.set(system.id, system);
    }
    
    this.loaded = true;
    console.log(`[SystemsManager] Loaded ${allSystems.length} active systems`);
  }
  
  /**
   * Get system details by ID
   */
  async getSystem(systemId: number) {
    await this.loadSystems();
    return this.systemsMap.get(systemId) || null;
  }
  
  /**
   * Get all active systems
   */
  async getAllSystems() {
    await this.loadSystems();
    return Array.from(this.systemsMap.values());
  }
  
  /**
   * Get multiple systems by IDs
   */
  async getSystems(systemIds: number[]) {
    await this.loadSystems();
    return systemIds
      .map(id => this.systemsMap.get(id))
      .filter(system => system !== undefined);
  }
  
  /**
   * Check if a system exists and is active
   */
  async systemExists(systemId: number): Promise<boolean> {
    await this.loadSystems();
    return this.systemsMap.has(systemId);
  }
}