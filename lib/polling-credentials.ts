/**
 * Helper functions for fetching Select.Live credentials during polling
 * Used by background jobs and cron tasks
 */

import { db } from './db'
import { systems } from './db/schema'
import { eq } from 'drizzle-orm'
import { getSelectLiveCredentials, SelectLiveCredentials } from './secure-credentials'

export interface SystemWithCredentials {
  systemId: number
  vendorType: string
  vendorSiteId: string
  displayName: string
  ownerClerkUserId: string | null
  credentials: SelectLiveCredentials | null
}

/**
 * Get credentials for a system by looking up the owner's Clerk metadata
 * This is used by background polling jobs
 */
export async function getSystemCredentialsForPolling(
  systemId: number
): Promise<SystemWithCredentials | null> {
  try {
    // Get the system and its owner
    const [system] = await db.select()
      .from(systems)
      .where(eq(systems.id, systemId))
      .limit(1)
    
    if (!system) {
      console.error(`System ${systemId} not found`)
      return null
    }
    
    if (!system.ownerClerkUserId) {
      console.error(`System ${systemId} has no owner set`)
      return {
        systemId: system.id,
        vendorType: system.vendorType,
        vendorSiteId: system.vendorSiteId,
        displayName: system.displayName,
        ownerClerkUserId: null,
        credentials: null
      }
    }
    
    // Fetch credentials from the owner's Clerk metadata
    const credentials = await getSelectLiveCredentials(
      system.ownerClerkUserId
    )
    
    return {
      systemId: system.id,
      vendorType: system.vendorType,
      vendorSiteId: system.vendorSiteId,
      displayName: system.displayName,
      ownerClerkUserId: system.ownerClerkUserId,
      credentials
    }
  } catch (error) {
    console.error(`Failed to get credentials for system ${systemId}:`, error)
    return null
  }
}

/**
 * Get all systems with their credentials for batch polling
 * Used by the minutely cron job
 */
export async function getAllSystemsWithCredentials(): Promise<SystemWithCredentials[]> {
  try {
    // Get all systems
    const allSystems = await db.select().from(systems)
    
    // Fetch credentials for each system
    const systemsWithCreds = await Promise.all(
      allSystems.map(async (system) => {
        if (!system.ownerClerkUserId) {
          return {
            systemId: system.id,
            vendorType: system.vendorType,
            vendorSiteId: system.vendorSiteId,
            displayName: system.displayName,
            ownerClerkUserId: null,
            credentials: null
          }
        }
        
        const credentials = await getSelectLiveCredentials(
          system.ownerClerkUserId
        )
        
        return {
          systemId: system.id,
          vendorType: system.vendorType,
          vendorSiteId: system.vendorSiteId,
          displayName: system.displayName,
          ownerClerkUserId: system.ownerClerkUserId,
          credentials
        }
      })
    )
    
    return systemsWithCreds
  } catch (error) {
    console.error('Failed to get systems with credentials:', error)
    return []
  }
}

/**
 * Check if a system has valid credentials configured
 */
export async function systemHasCredentials(ourId: number): Promise<boolean> {
  const systemWithCreds = await getSystemCredentialsForPolling(ourId)
  return systemWithCreds?.credentials !== null
}