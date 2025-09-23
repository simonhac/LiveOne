import { auth, clerkClient } from '@clerk/nextjs/server'
import { db } from './db'
import { userSystems } from './db/schema'
import { eq, or } from 'drizzle-orm'

export async function isUserAdmin(userId?: string | null) {
  // Get auth result to check both userId and sessionClaims
  const authResult = await auth()
  
  // Use provided userId or get from auth
  if (!userId) {
    userId = authResult.userId
  }
  
  if (!userId) {
    return false
  }
  
  // First check session claims (if you've configured them in Clerk Dashboard)
  // This avoids any network calls - best for performance
  if (authResult.sessionClaims && 'isPlatformAdmin' in authResult.sessionClaims) {
    return authResult.sessionClaims.isPlatformAdmin === true
  }
  
  try {
    // Fall back to checking Clerk public metadata via API
    // This makes a network call so it's slower (~100-150ms)
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    
    // Check public metadata for admin flag
    if (user.publicMetadata && typeof user.publicMetadata === 'object') {
      const metadata = user.publicMetadata as any
      if (metadata.isPlatformAdmin === true) {
        return true
      }
    }
  } catch (error) {
    console.error('Error checking admin status:', error)
  }
  
  return false
}

export async function getUserSystems(userId?: string | null) {
  // If userId is not provided, get it from auth
  if (!userId) {
    const authResult = await auth()
    userId = authResult.userId
  }
  
  if (!userId) {
    return []
  }
  
  return db.select()
    .from(userSystems)
    .where(eq(userSystems.clerkUserId, userId))
}