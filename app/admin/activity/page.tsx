import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { isUserAdmin } from '@/lib/auth-utils'

export default async function ActivityPage() {
  const { userId } = await auth()
  
  if (!userId) {
    redirect('/sign-in')
  }
  
  const isAdmin = await isUserAdmin()
  
  if (!isAdmin) {
    redirect('/dashboard')
  }
  
  return (
    <div className="flex-1 px-4 py-8 md:px-8">
      <h1 className="text-2xl font-bold text-white mb-8">Activity Logs</h1>
      
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-12 text-center">
        <div className="max-w-md mx-auto">
          <svg
            className="w-16 h-16 mx-auto mb-4 text-gray-600"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            <path d="M9 12h6M9 16h6" />
          </svg>
          
          <h2 className="text-xl font-semibold text-gray-300 mb-2">
            Activity Logs
          </h2>
          
          <p className="text-gray-500 mb-4">
            This feature is not yet implemented.
          </p>
          
          <p className="text-sm text-gray-600">
            Activity logs will show system events, user actions, and data collection history.
          </p>
        </div>
      </div>
    </div>
  )
}