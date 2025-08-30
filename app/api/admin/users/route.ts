import { NextRequest, NextResponse } from 'next/server'
import { auth, clerkClient } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { userSystems, systems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { isUserAdmin } from '@/lib/auth-utils'

export async function GET(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    // Check if user is admin
    const isAdmin = await isUserAdmin()
    
    if (!isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    
    // Get all user-system relationships
    const allUserSystems = await db
      .select()
      .from(userSystems)
      .innerJoin(systems, eq(userSystems.systemId, systems.id))
    
    // Get unique user IDs
    const uniqueUserIds = [...new Set(allUserSystems.map(us => us.user_systems.clerkUserId))]
    
    // Fetch user details from Clerk
    const usersData = []
    
    for (const clerkUserId of uniqueUserIds) {
      try {
        const client = await clerkClient()
        const clerkUser = await client.users.getUser(clerkUserId)
        
        // Get all systems this user has access to
        const userSystemAccess = allUserSystems
          .filter(us => us.user_systems.clerkUserId === clerkUserId)
          .map(us => ({
            systemId: us.systems.id,
            vendorType: us.systems.vendorType,
            vendorSiteId: us.systems.vendorSiteId,
            displayName: us.systems.displayName,
            role: us.user_systems.role as 'owner' | 'admin' | 'viewer',
          }))
        
        // Extract data from private metadata
        let selectLiveEmail: string | undefined
        let isPlatformAdmin = false
        if (clerkUser.privateMetadata && typeof clerkUser.privateMetadata === 'object') {
          const metadata = clerkUser.privateMetadata as any
          if (metadata.selectLiveCredentials) {
            // Users now have a single set of credentials
            selectLiveEmail = metadata.selectLiveCredentials.email
          }
          isPlatformAdmin = metadata.isPlatformAdmin === true
        }
        
        usersData.push({
          clerkUserId,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
          username: clerkUser.username,
          createdAt: clerkUser.createdAt,
          lastSignIn: clerkUser.lastSignInAt,
          systems: userSystemAccess,
          selectLiveEmail,
          isPlatformAdmin,
        })
      } catch (err) {
        console.error(`Failed to fetch Clerk user ${clerkUserId}:`, err)
        // Include user even if Clerk fetch fails
        const userSystemAccess = allUserSystems
          .filter(us => us.user_systems.clerkUserId === clerkUserId)
          .map(us => ({
            systemId: us.systems.id,
            vendorType: us.systems.vendorType,
            vendorSiteId: us.systems.vendorSiteId,
            displayName: us.systems.displayName,
            role: us.user_systems.role as 'owner' | 'admin' | 'viewer',
          }))
        
        usersData.push({
          clerkUserId,
          email: undefined,
          firstName: undefined,
          lastName: undefined,
          createdAt: new Date().toISOString(),
          lastSignIn: undefined,
          systems: userSystemAccess,
        })
      }
    }
    
    // Sort users by creation date (newest first)
    usersData.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    
    return NextResponse.json({
      success: true,
      users: usersData,
      totalUsers: usersData.length,
      timestamp: new Date().toISOString(),
    })
    
  } catch (error) {
    console.error('Error fetching users data:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch users data',
    }, { status: 500 })
  }
}