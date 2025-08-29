import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { systems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import DashboardClient from '@/components/DashboardClient'
import { isUserAdmin } from '@/lib/auth-utils'

interface PageProps {
  params: {
    systemId: string
  }
}

export default async function DashboardSystemPage({ params }: PageProps) {
  const { userId } = await auth()
  const { systemId } = await params
  
  if (!userId) {
    redirect('/sign-in')
  }

  const isAdmin = await isUserAdmin()
  
  // Check if system exists
  const system = await db.select()
    .from(systems)
    .where(eq(systems.systemNumber, systemId))
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
    // For now, we're using a simple check - in a real app, you'd have a user_systems table
    hasAccess = system.userId === userId
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