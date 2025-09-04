import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { systems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import DashboardClient from '@/components/DashboardClient'
import { isUserAdmin } from '@/lib/auth-utils'

interface PageProps {
  params: Promise<{
    systemId: string
  }>
}

export default async function DashboardSystemPage({ params }: PageProps) {
  const { userId } = await auth()
  const { systemId } = await params
  
  if (!userId) {
    redirect('/sign-in')
  }

  const isAdmin = await isUserAdmin()
  
  // Check if system exists (systemId is our internal ID)
  const system = await db.select()
    .from(systems)
    .where(eq(systems.id, parseInt(systemId)))
    .limit(1)
    .then(rows => rows[0])

  const systemExists = !!system
  
  // Debug logging for admin access
  // if (isAdmin) {
  //   console.log('[Dashboard] Admin access check:', {
  //     userId,
  //     systemId,
  //     systemExists,
  //     systemOwner: system?.ownerClerkUserId,
  //     isAdmin
  //   })
  // }
  
  // Check if user has access to this system
  let hasAccess = false
  
  if (isAdmin) {
    // Admins have access to all systems that exist
    hasAccess = systemExists
  } else if (system) {
    // Check if user owns this system
    hasAccess = system.ownerClerkUserId === userId
  }

  // Fetch available systems for the user
  let availableSystems = []
  
  if (isAdmin) {
    // Admins can see all systems - limit to 10 for the dropdown
    const allSystems = await db.select()
      .from(systems)
      .limit(10)
    availableSystems = allSystems.filter(s => s.displayName && s.vendorSiteId).map(s => ({
      id: s.id,
      displayName: s.displayName!,
      vendorSiteId: s.vendorSiteId!,
    }))
  } else {
    // Regular users only see their own systems
    const userSystems = await db.select()
      .from(systems)
      .where(eq(systems.ownerClerkUserId, userId))
    availableSystems = userSystems.filter(s => s.displayName && s.vendorSiteId).map(s => ({
      id: s.id,
      displayName: s.displayName!,
      vendorSiteId: s.vendorSiteId!,
    }))
  }

  return (
    <DashboardClient 
      systemId={systemId}
      hasAccess={hasAccess}
      systemExists={systemExists}
      isAdmin={isAdmin}
      availableSystems={availableSystems}
      userId={userId}
    />
  )
}