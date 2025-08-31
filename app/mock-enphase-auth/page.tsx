import { Zap } from 'lucide-react'

export default async function MockEnphaseAuth({
  searchParams
}: {
  searchParams: Promise<{ state?: string }>
}) {
  const params = await searchParams
  const state = params.state || ''
  
  // Generate the approve and deny URLs
  const approveUrl = `/api/auth/enphase/callback?code=mock_auth_code_${Date.now()}&state=${state}`
  const denyUrl = `/api/auth/enphase/callback?error=access_denied&state=${state}`
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-lg shadow-2xl max-w-md w-full p-8 border border-gray-700">
        <div className="flex items-center justify-center mb-6">
          <div className="bg-gradient-to-br from-green-500 to-blue-500 p-3 rounded-full">
            <Zap className="w-8 h-8 text-white" />
          </div>
        </div>
        
        <h1 className="text-2xl font-bold text-white text-center mb-2">
          Mock Enphase Authorization
        </h1>
        
        <div className="bg-yellow-900/50 border border-yellow-700 rounded-lg p-4 mb-6">
          <p className="text-yellow-300 text-sm text-center">
            🧪 This is a mock authorization page for testing
          </p>
        </div>
        
        <div className="bg-gray-900 rounded-lg p-4 mb-6">
          <h2 className="text-white font-semibold mb-2">LiveOne Solar Monitor</h2>
          <p className="text-gray-400 text-sm mb-4">
            This application is requesting access to:
          </p>
          <ul className="space-y-2 text-sm">
            <li className="flex items-center text-gray-300">
              <span className="text-green-400 mr-2">✓</span>
              View your solar production data
            </li>
            <li className="flex items-center text-gray-300">
              <span className="text-green-400 mr-2">✓</span>
              Access system telemetry
            </li>
            <li className="flex items-center text-gray-300">
              <span className="text-green-400 mr-2">✓</span>
              Monitor energy consumption
            </li>
          </ul>
        </div>
        
        <div className="flex gap-4">
          <a
            href={denyUrl}
            className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors text-center"
          >
            Deny
          </a>
          <a
            href={approveUrl}
            className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-center font-semibold"
          >
            Approve
          </a>
        </div>
      </div>
    </div>
  )
}