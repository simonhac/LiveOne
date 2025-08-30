'use client'

import { useUser } from '@clerk/nextjs'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function SetupPage() {
  const { user, isLoaded } = useUser()
  const [systemNumber, setSystemNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  useEffect(() => {
    if (isLoaded && !user) {
      router.push('/sign-in')
    }
  }, [isLoaded, user, router])

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemNumber,
        }),
      })

      const data = await response.json()

      if (response.ok && data.success) {
        router.push('/dashboard')
      } else {
        setError(data.error || 'Setup failed')
      }
    } catch (err) {
      setError('Setup failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!isLoaded || !user) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full">
        <h1 className="text-2xl font-bold mb-6">Setup Your System</h1>
        <p className="text-gray-600 mb-6">
          Welcome {user.firstName || user.emailAddresses[0].emailAddress}! 
          Please enter your Selectronic system number to complete setup.
        </p>
        
        <form onSubmit={handleSetup} className="space-y-4">
          <div>
            <label htmlFor="systemNumber" className="block text-sm font-medium text-gray-700 mb-2">
              System Number
            </label>
            <input
              type="text"
              id="systemNumber"
              value={systemNumber}
              onChange={(e) => setSystemNumber(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., 1586"
              required
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Setting up...' : 'Complete Setup'}
          </button>
        </form>

        <p className="mt-6 text-sm text-gray-500 text-center">
          You can find your system number in your Selectronic portal or documentation.
        </p>
      </div>
    </div>
  )
}