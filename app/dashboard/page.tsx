import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { SystemsManager } from '@/lib/systems-manager'
import DashboardClient from '@/components/DashboardClient'
import { isUserAdmin } from '@/lib/auth-utils'

export default async function DashboardPage() {
  const { userId } = await auth()

  if (!userId) {
    redirect('/sign-in')
  }

  const isAdmin = await isUserAdmin()
  const systemsManager = SystemsManager.getInstance()

  // Get all systems visible to the user (owned + granted access)
  const visibleSystems = await systemsManager.getSystemsVisibleByUser(userId, true)

  if (visibleSystems.length === 0) {
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

  const primarySystem = visibleSystems[0]
  
  // Redirect to the system-specific dashboard using internal system ID
  redirect(`/dashboard/${primarySystem.id}`)
}