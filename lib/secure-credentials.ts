/**
 * Secure credential management using Clerk's private metadata
 * 
 * This module handles storing and retrieving credentials for various
 * solar system vendors (Select.Live, Enphase, etc.) securely in 
 * Clerk's private metadata, which is:
 * - Only accessible server-side
 * - Encrypted at rest
 * - Never exposed to the frontend
 */

import { clerkClient } from '@clerk/nextjs/server'
import { auth } from '@clerk/nextjs/server'
import type { EnphaseCredentials, EnphaseTokens } from '@/lib/types/enphase'

export type VendorType = 'select.live' | 'enphase'

export interface SelectLiveCredentials {
  email: string
  password: string
  created_at?: number  // Unix timestamp when credentials were stored
}

export type VendorCredentials = SelectLiveCredentials | EnphaseCredentials

/**
 * Store vendor credentials in Clerk private metadata
 */
export async function storeVendorCredentials(
  userId: string,
  vendor: VendorType,
  credentials: VendorCredentials
) {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    const userIdentifier = user.username || user.emailAddresses[0]?.emailAddress || 'unknown'
    
    console.log(`[${vendor}] Storing credentials for user: ${userId} (${userIdentifier})`)
    
    // Map vendor to storage key (maintains existing Clerk metadata format)
    const storageKey = vendor === 'select.live' ? 'selectLiveCredentials' : 'enphaseCredentials'
    
    // Add created_at timestamp to credentials
    const credentialsWithTimestamp = {
      ...credentials,
      created_at: Math.floor(Date.now() / 1000)  // Unix timestamp in seconds
    }
    
    await client.users.updateUser(userId, {
      privateMetadata: {
        ...user.privateMetadata,
        [storageKey]: credentialsWithTimestamp
      }
    })
    
    console.log(`[${vendor}] Credentials stored successfully for user: ${userId} (${userIdentifier})`)
    return { success: true }
  } catch (error) {
    console.error(`[${vendor}] Failed to store credentials for user ${userId}:`, error)
    return { success: false, error: `Failed to store ${vendor} credentials` }
  }
}

/**
 * Get vendor credentials from Clerk private metadata
 */
export async function getVendorCredentials(
  userId: string,
  vendor: VendorType
): Promise<VendorCredentials | null> {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    const userIdentifier = user.username || user.emailAddresses[0]?.emailAddress || 'unknown'
    
    console.log(`[${vendor}] Retrieving credentials for user: ${userId} (${userIdentifier})`)
    
    // Map vendor to storage key (maintains existing Clerk metadata format)
    const storageKey = vendor === 'select.live' ? 'selectLiveCredentials' : 'enphaseCredentials'
    const credentials = user.privateMetadata?.[storageKey]
    
    if (!credentials) {
      console.log(`[${vendor}] No credentials found for user: ${userId} (${userIdentifier})`)
      return null
    }
    
    console.log(`[${vendor}] Credentials retrieved for user: ${userId} (${userIdentifier})`)
    return credentials as VendorCredentials
  } catch (error) {
    console.error(`[${vendor}] Failed to retrieve credentials for user ${userId}:`, error)
    return null
  }
}

/**
 * Remove vendor credentials from Clerk private metadata
 */
export async function removeVendorCredentials(
  userId: string,
  vendor: VendorType
) {
  try {
    console.log(`[${vendor}] Removing credentials for user:`, userId)
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    
    // Map vendor to storage key (maintains existing Clerk metadata format)
    const storageKey = vendor === 'select.live' ? 'selectLiveCredentials' : 'enphaseCredentials'
    
    // Create new metadata without the vendor credentials
    const newMetadata = { ...user.privateMetadata }
    delete newMetadata[storageKey]
    
    await client.users.updateUser(userId, {
      privateMetadata: newMetadata
    })
    
    console.log(`[${vendor}] Credentials removed successfully`)
    return { success: true }
  } catch (error) {
    console.error(`[${vendor}] Failed to remove credentials:`, error)
    return { success: false, error: `Failed to remove ${vendor} credentials` }
  }
}

/**
 * Check if a user has vendor credentials
 */
export async function hasVendorCredentials(
  userId: string,
  vendor: VendorType
): Promise<boolean> {
  const credentials = await getVendorCredentials(userId, vendor)
  return credentials !== null
}

/**
 * Get all vendor credentials for a user
 */
export async function getAllVendorCredentials(
  userId: string
): Promise<{ selectLive?: SelectLiveCredentials, enphase?: EnphaseCredentials }> {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    
    return {
      selectLive: user.privateMetadata?.selectLiveCredentials as SelectLiveCredentials | undefined,
      enphase: user.privateMetadata?.enphaseCredentials as EnphaseCredentials | undefined
    }
  } catch (error) {
    console.error('Failed to retrieve all credentials:', error)
    return {}
  }
}

/**
 * Get the current user's credentials from auth context
 */
export async function getCurrentUserCredentials(
  vendor: VendorType
): Promise<VendorCredentials | null> {
  const { userId } = await auth()
  
  if (!userId) {
    return null
  }
  
  return getVendorCredentials(userId, vendor)
}

/**
 * Get vendor-specific user ID (email for Select.Live, user ID for Enphase)
 */
export async function getVendorUserId(
  userId: string,
  vendor: VendorType
): Promise<string | null> {
  try {
    const credentials = await getVendorCredentials(userId, vendor)
    
    if (!credentials) {
      return null
    }
    
    // Return the appropriate ID based on vendor type
    if (vendor === 'select.live') {
      return (credentials as SelectLiveCredentials).email
    } else if (vendor === 'enphase') {
      return (credentials as EnphaseCredentials).enphase_user_id || null
    }
    
    return null
  } catch (error) {
    console.error(`Failed to get ${vendor} user ID:`, error)
    return null
  }
}

