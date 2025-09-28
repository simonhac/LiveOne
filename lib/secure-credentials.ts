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
import type { EnphaseCredentials } from '@/lib/types/enphase'
import { getNowFormattedAEST, unixToFormattedAEST } from '@/lib/date-utils'

export type VendorType = 'select.live' | 'selectronic' | 'enphase' | 'mondo'

export interface BaseCredentials {
  vendor?: VendorType  // Optional in v1, required in v2
  email?: string
  password?: string
  liveoneSiteId?: string  // Optional site-specific ID
  created_at?: string | Date  // ISO8601 timestamp or Date when credentials were stored
}

export interface SelectLiveCredentials extends BaseCredentials {
  email: string
  password: string
}

export interface MondoCredentials extends BaseCredentials {
  email: string
  password: string
}

export type VendorCredentials = SelectLiveCredentials | EnphaseCredentials | MondoCredentials

// v1.1 metadata structure (new unified format)
export interface CredentialsMetadataV11 {
  version: string  // "1.1" or later
  credentials: Array<VendorCredentials & { vendor: VendorType }>
}

// Check if metadata is v1.1 format (new unified format)
function isV11Format(metadata: any): metadata is CredentialsMetadataV11 {
  return metadata?.version && metadata?.credentials && Array.isArray(metadata.credentials)
}

/**
 * Get storage key for vendor credentials
 */
function getStorageKey(vendor: VendorType): string {
  switch (vendor) {
    case 'select.live':
      return 'selectLiveCredentials'
    case 'enphase':
      return 'enphaseCredentials'
    case 'mondo':
      return 'mondoCredentials'
    default:
      return `${vendor}Credentials`
  }
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

    // Migrate to v1.1 if needed
    if (!isV11Format(metadata)) {
      const migrated = await migrateToV11(userId, metadata)
      metadata = (migrated || { version: '1.1', credentials: [] }) as unknown as Record<string, unknown>
    }

    const v11Metadata = metadata as unknown as CredentialsMetadataV11

    // Normalize vendor name
    const normalizedVendor = vendor === 'select.live' ? 'selectronic' : vendor

    // Serialize any Date objects to ISO8601 strings for storage
    const serializedCredentials = { ...credentials }

    // For Enphase, convert Date objects to proper formats for storage
    if (vendor === 'enphase') {
      const enphaseCredentials = serializedCredentials as any

      // Convert expires_at Date to ISO8601 string
      if (enphaseCredentials.expires_at instanceof Date) {
        enphaseCredentials.expires_at = unixToFormattedAEST(enphaseCredentials.expires_at.getTime(), true)
      }

      // Convert created_at Date to ISO8601 string
      if (enphaseCredentials.created_at instanceof Date) {
        enphaseCredentials.created_at = unixToFormattedAEST(enphaseCredentials.created_at.getTime(), true)
      }
    }

    // Add vendor and created_at to credentials
    const credentialsWithMetadata = {
      vendor: normalizedVendor,
      ...serializedCredentials,
      created_at: serializedCredentials.created_at || getNowFormattedAEST()
    }

    // Filter out existing credentials for this vendor/site combination
    let filteredCredentials = v11Metadata.credentials

    const siteId = (credentialsWithMetadata as any).liveoneSiteId
    if (siteId) {
      // Remove existing credentials for this vendor and site
      filteredCredentials = filteredCredentials.filter(c =>
        !(c.vendor === normalizedVendor && (c as any).liveoneSiteId === siteId)
      )
    } else {
      // Remove existing credentials for this vendor without a site ID
      filteredCredentials = filteredCredentials.filter(c =>
        !(c.vendor === normalizedVendor && !(c as any).liveoneSiteId)
      )
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
 * Migrate v1.0 credentials to v1.1 format
 */
async function migrateToV11(userId: string, privateMetadata: any): Promise<CredentialsMetadataV11 | null> {
  try {
    const client = await clerkClient()
    const credentials: Array<VendorCredentials & { vendor: VendorType }> = []

    // Migrate select.live/selectronic credentials
    if (privateMetadata.selectLiveCredentials) {
      const creds = privateMetadata.selectLiveCredentials
      const credsList = Array.isArray(creds) ? creds : [creds]
      for (const cred of credsList) {
        // Normalize created_at if it exists and is a number (unlikely but defensive)
        let createdAt = cred.created_at
        if (createdAt && typeof createdAt === 'number') {
          createdAt = unixToFormattedAEST(createdAt, false) // Assume seconds if numeric
        } else if (!createdAt) {
          createdAt = getNowFormattedAEST()
        }

        credentials.push({
          vendor: 'selectronic' as VendorType,
          ...cred,
          created_at: createdAt
        })
      }
    }

    // Migrate mondo credentials
    if (privateMetadata.mondoCredentials) {
      const creds = privateMetadata.mondoCredentials
      const credsList = Array.isArray(creds) ? creds : [creds]
      for (const cred of credsList) {
        // Normalize created_at if it exists and is a number (unlikely but defensive)
        let createdAt = cred.created_at
        if (createdAt && typeof createdAt === 'number') {
          createdAt = unixToFormattedAEST(createdAt, false) // Assume seconds if numeric
        } else if (!createdAt) {
          createdAt = getNowFormattedAEST()
        }

        credentials.push({
          vendor: 'mondo' as VendorType,
          ...cred,
          created_at: createdAt
        })
      }
    }

    // Migrate enphase credentials
    if (privateMetadata.enphaseCredentials) {
      const creds = privateMetadata.enphaseCredentials
      const credsList = Array.isArray(creds) ? creds : [creds]
      for (const cred of credsList) {
        // Normalize timestamps from Unix to ISO8601
        let normalizedCred = { ...cred }

        // Convert created_at from Unix seconds to ISO8601
        if (cred.created_at && typeof cred.created_at === 'number') {
          normalizedCred.created_at = unixToFormattedAEST(cred.created_at, false) // false = seconds
        } else if (!cred.created_at) {
          normalizedCred.created_at = getNowFormattedAEST()
        }

        // Convert expires_at from Unix milliseconds to ISO8601
        if (cred.expires_at && typeof cred.expires_at === 'number') {
          normalizedCred.expires_at = unixToFormattedAEST(cred.expires_at, true) // true = milliseconds
        }

        credentials.push({
          vendor: 'enphase' as VendorType,
          ...normalizedCred
        })
      }
    }

    // Only migrate if we found credentials
    if (credentials.length === 0) {
      return null
    }

    const v11Metadata: CredentialsMetadataV11 = {
      version: '1.1',
      credentials
    }

    // Save the migrated format
    await client.users.updateUser(userId, {
      privateMetadata: v11Metadata as unknown as Record<string, unknown>
    })

    console.log(`[Credentials] Migrated user ${userId} to v1.1 format with ${credentials.length} credentials`)
    return v11Metadata

  } catch (error) {
    console.error(`[Credentials] Failed to migrate to v1.1 for user ${userId}:`, error)
    return null
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

    let metadata = user.privateMetadata

    // Check if we need to migrate from v1.0 to v1.1
    if (!isV11Format(metadata)) {
      // Try to migrate
      const migrated = await migrateToV11(userId, metadata)
      if (migrated) {
        metadata = migrated as unknown as Record<string, unknown>
      } else {
        // Fall back to v1.0 format handling
        const storageKey = getStorageKey(vendor === 'selectronic' ? 'select.live' : vendor)
        const stored = metadata?.[storageKey]

        if (!stored) {
          return null
        }

        // Handle both single credential and array of credentials
        const credentialsList = Array.isArray(stored) ? stored : [stored]

        // If liveoneSiteId is provided, find exact match
        if (liveoneSiteId) {
          const match = credentialsList.find((cred: any) =>
            cred.liveoneSiteId === liveoneSiteId
          )
          if (match) {
            return match as VendorCredentials
          }
        }

        // Return first credential that either has no liveoneSiteId or matches
        const defaultCred = credentialsList.find((cred: any) =>
          !cred.liveoneSiteId || cred.liveoneSiteId === liveoneSiteId
        )

        return defaultCred as VendorCredentials || credentialsList[0] as VendorCredentials || null
      }
    }

    // Handle v1.1 format
    const v11Metadata = metadata as unknown as CredentialsMetadataV11

    // Normalize vendor name (select.live -> selectronic)
    const normalizedVendor = vendor === 'select.live' ? 'selectronic' : vendor

    // Filter credentials by vendor
    const vendorCreds = v11Metadata.credentials.filter(c => c.vendor === normalizedVendor)

    if (vendorCreds.length === 0) {
      return null
    }

    // Find the matching credential
    let credential: VendorCredentials | null = null

    // If liveoneSiteId is provided, find exact match
    if (liveoneSiteId) {
      const match = vendorCreds.find(cred => (cred as any).liveoneSiteId === liveoneSiteId)
      if (match) {
        credential = match as VendorCredentials
      }
    }

    // If no match yet, return first credential that either has no liveoneSiteId or matches
    if (!credential) {
      const defaultCred = vendorCreds.find(cred =>
        !(cred as any).liveoneSiteId || (cred as any).liveoneSiteId === liveoneSiteId
      )
      credential = defaultCred as VendorCredentials || vendorCreds[0] as VendorCredentials || null
    }

    // Normalize timestamps to Date objects for Enphase credentials
    if (credential && vendor === 'enphase') {
      const enphaseCredential = credential as any

      // Convert expires_at to Date object
      if (enphaseCredential.expires_at) {
        if (typeof enphaseCredential.expires_at === 'string') {
          // ISO8601 string from v1.1
          enphaseCredential.expires_at = new Date(enphaseCredential.expires_at)
        } else if (typeof enphaseCredential.expires_at === 'number') {
          // Milliseconds from v1.0
          enphaseCredential.expires_at = new Date(enphaseCredential.expires_at)
        }
      }

      // Convert created_at to Date object
      if (enphaseCredential.created_at) {
        if (typeof enphaseCredential.created_at === 'string') {
          // ISO8601 string from v1.1
          enphaseCredential.created_at = new Date(enphaseCredential.created_at)
        } else if (typeof enphaseCredential.created_at === 'number') {
          // Unix seconds from v1.0
          enphaseCredential.created_at = new Date(enphaseCredential.created_at * 1000)
        }
      }
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
  vendor: VendorType
) {
  try {
    // Removing credentials
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
    
    // Credentials removed successfully
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

