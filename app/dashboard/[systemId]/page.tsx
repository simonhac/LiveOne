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
  
  // Check if user has access to this system
  let hasAccess = false
  
  if (isAdmin) {
    // Admins have access to all systems
    hasAccess = systemExists
  } else if (system) {
    // Check if user owns this system
    hasAccess = system.ownerClerkUserId === userId
  }

  return (
    <DashboardClient 
      systemId={systemId}
      hasAccess={hasAccess}
      systemExists={systemExists}
      isAdmin={isAdmin}
    />
  )
}