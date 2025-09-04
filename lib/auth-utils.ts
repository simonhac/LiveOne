import { auth, clerkClient } from '@clerk/nextjs/server'
import { db } from './db'
import { userSystems } from './db/schema'
import { eq, or } from 'drizzle-orm'

export async function isUserAdmin() {
  const { userId } = await auth()
  
  if (!userId) {
    return false
  }
  
  try {
    // Check Clerk private metadata for platform admin status
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    
    // Only log safe information - NEVER log privateMetadata as it contains credentials
    // console.log('[Auth] Admin check for user:', userId, {
    //   isPlatformAdmin: (user.privateMetadata as any)?.isPlatformAdmin === true
    // })
    
    if (user.privateMetadata && typeof user.privateMetadata === 'object') {
      const metadata = user.privateMetadata as any
      if (metadata.isPlatformAdmin === true) {
        return true
      }
    }
  } catch (error) {
    console.error('Error checking admin status:', error)
  }
  
  return false
}

export async function getUserSystems() {
  const { userId } = await auth()
  
  if (!userId) {
    return []
  }
  
  return db.select()
    .from(userSystems)
    .where(eq(userSystems.clerkUserId, userId))
}