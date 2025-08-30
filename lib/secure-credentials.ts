/**
 * Secure credential management using Clerk's private metadata
 * 
 * This module handles storing and retrieving Select.Live credentials
 * securely in Clerk's private metadata, which is:
 * - Only accessible server-side
 * - Encrypted at rest
 * - Never exposed to the frontend
 */

import { clerkClient } from '@clerk/nextjs/server'
import { auth } from '@clerk/nextjs/server'

export interface SelectLiveCredentials {
  email: string
  password: string
}

/**
 * Store Select.Live credentials in Clerk's private metadata
 * These credentials are encrypted and only accessible server-side
 * Note: A user can only have one set of Select.Live credentials
 */
export async function storeSelectLiveCredentials(
  userId: string,
  credentials: SelectLiveCredentials
) {
  try {
    // Get current user's metadata
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    
    // Update user's private metadata with single credential set
    await client.users.updateUser(userId, {
      privateMetadata: {
        ...user.privateMetadata,
        selectLiveCredentials: {
          email: credentials.email,
          password: credentials.password
        }
      }
    })
    
    return { success: true }
  } catch (error) {
    console.error('Failed to store credentials:', error)
    return { success: false, error: 'Failed to store credentials' }
  }
}

/**
 * Retrieve Select.Live credentials from Clerk's private metadata
 * Only accessible server-side
 */
export async function getSelectLiveCredentials(
  userId: string
): Promise<SelectLiveCredentials | null> {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    const credentials = user.privateMetadata?.selectLiveCredentials
    
    if (!credentials) {
      return null
    }
    
    return credentials as SelectLiveCredentials
  } catch (error) {
    console.error('Failed to retrieve credentials:', error)
    return null
  }
}

/**
 * Remove Select.Live credentials
 */
export async function removeSelectLiveCredentials(
  userId: string
) {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    
    // Remove selectLiveCredentials from metadata
    const { selectLiveCredentials, ...restMetadata } = user.privateMetadata || {}
    
    // Update user's private metadata
    await client.users.updateUser(userId, {
      privateMetadata: restMetadata
    })
    
    return { success: true }
  } catch (error) {
    console.error('Failed to remove credentials:', error)
    return { success: false, error: 'Failed to remove credentials' }
  }
}

/**
 * Check if a user has stored credentials
 */
export async function hasSelectLiveCredentials(
  userId: string
): Promise<boolean> {
  const credentials = await getSelectLiveCredentials(userId)
  return credentials !== null
}

/**
 * Get the current user's Select.Live credentials from auth context
 */
export async function getCurrentUserCredentials(): Promise<SelectLiveCredentials | null> {
  const { userId } = await auth()
  
  if (!userId) {
    return null
  }
  
  return getSelectLiveCredentials(userId)
}

/**
 * Update only the password for existing credentials
 */
export async function updateSelectLivePassword(
  userId: string,
  newPassword: string
) {
  try {
    const existingCredentials = await getSelectLiveCredentials(userId)
    
    if (!existingCredentials) {
      return { success: false, error: 'No existing credentials found' }
    }
    
    return storeSelectLiveCredentials(userId, {
      ...existingCredentials,
      password: newPassword
    })
  } catch (error) {
    console.error('Failed to update password:', error)
    return { success: false, error: 'Failed to update password' }
  }
}