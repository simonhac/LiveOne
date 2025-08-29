import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { userSystems, systems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import DashboardClient from '@/components/DashboardClient'
import { isUserAdmin } from '@/lib/auth-utils'

export default async function DashboardPage() {
  const { userId } = await auth()
  
  if (!userId) {
    redirect('/sign-in')
  }

  const isAdmin = await isUserAdmin()
  
  // Get the user's primary system
  const userSystemRecords = await db.select()
    .from(userSystems)
    .innerJoin(systems, eq(systems.id, userSystems.systemId))
    .where(eq(userSystems.clerkUserId, userId))
    .limit(1)

  if (userSystemRecords.length === 0) {
    // No systems found for this user
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-semibold text-white mb-2">No Systems Found</h2>
          <p className="text-gray-400">
            You don&apos;t have access to any systems. Please contact your system administrator.
          </p>
        </div>
      </div>
    )
  }

  const primarySystem = userSystemRecords[0].systems
  
  // Redirect to the system-specific dashboard
  redirect(`/dashboard/${primarySystem.systemNumber}`)
}