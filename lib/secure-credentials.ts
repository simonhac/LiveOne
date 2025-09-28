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

export type VendorType = 'select.live' | 'selectronic' | 'enphase' | 'mondo'

// Generic credentials interface - vendors define their own specific shapes
export interface VendorCredentials {
  vendor?: VendorType
  liveoneSiteId?: string  // Optional site-specific ID
  created_at?: string | Date  // ISO8601 timestamp or Date when credentials were stored
  [key: string]: any  // Allow vendor-specific fields
}

// v1.1 metadata structure
export interface CredentialsMetadataV11 {
  version: string  // "1.1" or later
  credentials: Array<VendorCredentials & { vendor: VendorType }>
}

// Check if metadata is v1.1 format
function isV11Format(metadata: any): metadata is CredentialsMetadataV11 {
  return metadata?.version && metadata?.credentials && Array.isArray(metadata.credentials)
}


/**
 * Store vendor credentials in Clerk private metadata
 * Automatically uses v1.1 format for storage
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

    let metadata = user.privateMetadata

    // Initialize v1.1 format if needed
    if (!isV11Format(metadata)) {
      metadata = { version: '1.1', credentials: [] } as unknown as Record<string, unknown>
    }

    const v11Metadata = metadata as unknown as CredentialsMetadataV11

    // Normalize vendor name
    const normalizedVendor = vendor === 'select.live' ? 'selectronic' : vendor

    // Serialize any Date objects to ISO8601 strings for storage
    const serializedCredentials = { ...credentials }

    // Convert any Date objects to ISO8601 strings
    Object.keys(serializedCredentials).forEach(key => {
      if (serializedCredentials[key] instanceof Date) {
        serializedCredentials[key] = serializedCredentials[key].toISOString()
      }
    })

    // Add vendor and created_at to credentials
    const credentialsWithMetadata = {
      vendor: normalizedVendor,
      ...serializedCredentials,
      created_at: serializedCredentials.created_at || new Date().toISOString()
    }

    // Filter out existing credentials for this vendor/site combination
    let filteredCredentials = v11Metadata.credentials

    // Check for siteId using both old and new field names
    const siteId = (credentialsWithMetadata as any).liveoneSiteId || (credentialsWithMetadata as any).systemId
    if (siteId) {
      // Remove existing credentials for this vendor and site
      filteredCredentials = filteredCredentials.filter(c => {
        const credVendor = c.vendor || c.vendorType
        const credSiteId = (c as any).liveoneSiteId || (c as any).systemId
        return !(credVendor === normalizedVendor && credSiteId === siteId)
      })
    } else {
      // Remove existing credentials for this vendor without a site ID
      filteredCredentials = filteredCredentials.filter(c => {
        const credVendor = c.vendor || c.vendorType
        const credSiteId = (c as any).liveoneSiteId || (c as any).systemId
        return !(credVendor === normalizedVendor && !credSiteId)
      })
    }

    // Add the new credentials
    const updatedMetadata: CredentialsMetadataV11 = {
      version: '1.1',
      credentials: [...filteredCredentials, credentialsWithMetadata as any]
    }

    await client.users.updateUser(userId, {
      privateMetadata: updatedMetadata as unknown as Record<string, unknown>
    })

    // Credentials stored successfully
    return { success: true }
  } catch (error) {
    console.error(`[${vendor}] Failed to store credentials for user ${userId}:`, error)
    return { success: false, error: `Failed to store ${vendor} credentials` }
  }
}

/**
 * Get vendor credentials from Clerk private metadata
 * Supports matching by liveoneSiteId when provided
 * Automatically migrates v1.0 format to v1.1 on first access
 */
export async function getVendorCredentials(
  userId: string,
  vendor: VendorType,
  liveoneSiteId?: string
): Promise<VendorCredentials | null> {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    const userIdentifier = user.username || user.emailAddresses[0]?.emailAddress || 'unknown'

    const metadata = user.privateMetadata

    // All instances should be v1.1 now
    if (!isV11Format(metadata)) {
      return null
    }

    // Handle v1.1 format
    const v11Metadata = metadata as unknown as CredentialsMetadataV11

    // Normalize vendor name (select.live -> selectronic)
    const normalizedVendor = vendor === 'select.live' ? 'selectronic' : vendor

    // Filter credentials by vendor (check both vendor and vendorType fields)
    const vendorCreds = v11Metadata.credentials.filter(c => {
      const credVendor = c.vendor || c.vendorType
      return credVendor === normalizedVendor
    })

    if (vendorCreds.length === 0) {
      return null
    }

    // Find the matching credential
    let credential: VendorCredentials | null = null

    // If liveoneSiteId is provided, find exact match (check both field names)
    if (liveoneSiteId) {
      const match = vendorCreds.find(cred => {
        const credSiteId = (cred as any).liveoneSiteId || (cred as any).systemId
        return credSiteId === liveoneSiteId
      })
      if (match) {
        credential = match as VendorCredentials
      }
    }

    // If no match yet, return first credential that either has no site ID or matches
    if (!credential) {
      const defaultCred = vendorCreds.find(cred => {
        const credSiteId = (cred as any).liveoneSiteId || (cred as any).systemId
        return !credSiteId || credSiteId === liveoneSiteId
      })
      credential = defaultCred as VendorCredentials || vendorCreds[0] as VendorCredentials || null
    }

    // Convert string timestamps back to Date objects if needed
    if (credential) {
      Object.keys(credential).forEach(key => {
        const value = (credential as any)[key]
        // Check if it looks like an ISO8601 date string
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
          try {
            (credential as any)[key] = new Date(value)
          } catch {
            // Keep as string if conversion fails
          }
        }
      })
    }

    return credential

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
  vendor: VendorType,
  liveoneSiteId?: string
) {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    const metadata = user.privateMetadata

    if (!isV11Format(metadata)) {
      return { success: true } // Nothing to remove
    }

    const v11Metadata = metadata as unknown as CredentialsMetadataV11
    const normalizedVendor = vendor === 'select.live' ? 'selectronic' : vendor

    // Filter out credentials for this vendor/site combination
    let filteredCredentials = v11Metadata.credentials

    if (liveoneSiteId) {
      // Remove specific vendor/site combination (check both field names)
      filteredCredentials = filteredCredentials.filter(c => {
        const credVendor = c.vendor || c.vendorType
        const credSiteId = (c as any).liveoneSiteId || (c as any).systemId
        return !(credVendor === normalizedVendor && credSiteId === liveoneSiteId)
      })
    } else {
      // Remove all credentials for this vendor (check both field names)
      filteredCredentials = filteredCredentials.filter(c => {
        const credVendor = c.vendor || c.vendorType
        return credVendor !== normalizedVendor
      })
    }

    const updatedMetadata: CredentialsMetadataV11 = {
      version: '1.1',
      credentials: filteredCredentials
    }

    await client.users.updateUser(userId, {
      privateMetadata: updatedMetadata as unknown as Record<string, unknown>
    })

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
): Promise<{ [key in VendorType]?: VendorCredentials[] }> {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    const metadata = user.privateMetadata

    if (!isV11Format(metadata)) {
      return {}
    }

    const v11Metadata = metadata as unknown as CredentialsMetadataV11
    const result: { [key in VendorType]?: VendorCredentials[] } = {}

    // Group credentials by vendor
    for (const cred of v11Metadata.credentials) {
      const vendor = (cred.vendor === 'selectronic' ? 'select.live' : cred.vendor) as VendorType
      if (!result[vendor]) {
        result[vendor] = []
      }
      result[vendor]!.push(cred)
    }

    return result
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
 * Get vendor-specific user ID
 * Each vendor module should know how to extract its user ID from credentials
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

    // Return vendor-specific ID field if it exists
    // Vendors should use standard field names like 'email' or 'user_id'
    const creds = credentials as any
    return creds.email || creds.user_id || creds.enphase_user_id || null
  } catch (error) {
    console.error(`Failed to get ${vendor} user ID:`, error)
    return null
  }
}
