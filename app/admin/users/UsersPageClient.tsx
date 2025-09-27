'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, Mail, AlertCircle, Globe, Crown } from 'lucide-react'

interface SystemAccess {
  systemId: number
  systemNumber: string
  displayName: string
  status?: 'active' | 'disabled' | 'removed'
  role: 'owner' | 'viewer'
}

interface UserData {
  clerkUserId: string
  email?: string
  firstName?: string
  lastName?: string
  username?: string
  lastSignIn?: string
  systems: SystemAccess[]
  isPlatformAdmin?: boolean
}

export default function UsersPageClient() {
  const [users, setUsers] = useState<UserData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchUsers = async () => {
    try {
      const response = await fetch('/api/admin/users')
      
      if (!response.ok) {
        throw new Error('Failed to fetch users')
      }
      
      const data = await response.json()
      
      if (data.success) {
        setUsers(data.users || [])
        setError(null)
      } else {
        setError(data.error || 'Failed to load users')
      }
    } catch (err) {
      console.error('Error fetching users:', err)
      setError('Failed to connect to server')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUsers()
  }, [])

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'owner':
        return <Shield className="w-4 h-4 text-purple-400" />
      case 'viewer':
        return <Eye className="w-4 h-4 text-gray-400" />
      default:
        return <User className="w-4 h-4 text-gray-400" />
    }
  }

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'owner':
        return 'bg-purple-900/50 text-purple-300 border-purple-700'
      case 'viewer':
        return 'bg-gray-900/50 text-gray-300 border-gray-700'
      default:
        return 'bg-gray-900/50 text-gray-300 border-gray-700'
    }
  }

  const formatDateTime = (date: Date) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const day = date.getDate().toString().padStart(2, '0')
    const month = months[date.getMonth()]
    const year = date.getFullYear()
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    return {
      date: `${day} ${month} ${year}`,
      time: `${hours}:${minutes}`
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading users...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full max-h-full">
      <div className="flex-1 px-0 md:px-6 py-8 overflow-hidden">
        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            {error}
          </div>
        )}
        
        {/* Users Table */}
        <div className="bg-gray-800 border border-gray-700 md:rounded overflow-hidden flex-1 flex flex-col">
          <div className="px-2 md:px-6 py-4 border-b border-gray-700">
            <h2 className="text-lg font-semibold text-white">Registered Users</h2>
          </div>
        
        <div className="overflow-auto flex-1">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                  User
                </th>
                <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Systems
                </th>
                <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Last Sign In
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {users.map((user) => (
                <tr 
                  key={user.clerkUserId}
                  className="hover:bg-gray-700/50 transition-colors"
                >
                  <td className="px-2 md:px-6 py-4 whitespace-nowrap align-top">
                    <div className="flex items-start">
                      <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center mr-3 flex-shrink-0 mt-0.5">
                        <User className="w-4 h-4 text-gray-400" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-white">
                            {user.firstName && user.lastName 
                              ? `${user.firstName} ${user.lastName}`
                              : user.username || 'Unknown User'}
                          </p>
                          {user.isPlatformAdmin && (
                            <div className="relative group inline-block">
                              <Shield className="w-4 h-4 text-blue-400 cursor-help" />
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10 border border-gray-700">
                                Platform Admin
                              </div>
                            </div>
                          )}
                        </div>
                        {user.email ? (
                          <a 
                            href={`mailto:${user.email}`}
                            className="text-xs text-gray-400 hover:text-blue-400 transition-colors"
                          >
                            {user.email}
                          </a>
                        ) : (
                          <p className="text-xs text-gray-400">No email</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 md:px-6 py-4 align-top">
                    <div className="space-y-1">
                      {user.systems.length > 0 ? (
                        // Sort systems: non-removed first, then removed
                        user.systems
                          .sort((a, b) => {
                            // Sort by status first (non-removed before removed)
                            if (a.status === 'removed' && b.status !== 'removed') return 1
                            if (a.status !== 'removed' && b.status === 'removed') return -1
                            // Then sort by name
                            return a.displayName.localeCompare(b.displayName)
                          })
                          .map((system) => (
                            <div key={system.systemId} className="flex items-center gap-1.5">
                              <Link
                                href={`/dashboard/${system.systemId}`}
                                className={`text-sm transition-colors whitespace-nowrap ${
                                  system.status === 'removed' 
                                    ? 'text-gray-500 line-through italic hover:text-gray-400' 
                                    : 'text-gray-300 hover:text-blue-400'
                                }`}
                              >
                                {system.displayName}
                              </Link>
                              {system.role === 'owner' ? (
                                <div className="relative group">
                                  <Crown className={`w-3 h-3 cursor-help ${
                                    system.status === 'removed' ? 'text-purple-700' : 'text-purple-400'
                                  }`} />
                                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10 border border-gray-700">
                                    Owner
                                  </div>
                                </div>
                              ) : system.role === 'viewer' ? (
                                <div className="relative group">
                                  <Eye className={`w-3 h-3 cursor-help ${
                                    system.status === 'removed' ? 'text-gray-600' : 'text-gray-400'
                                  }`} />
                                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10 border border-gray-700">
                                    Viewer
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ))
                      ) : (
                        <span className="text-sm text-gray-500">No system access</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 md:px-6 py-4 whitespace-nowrap align-top">
                    {user.lastSignIn ? (
                      <div className="text-xs text-gray-400">
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDateTime(new Date(user.lastSignIn)).date}
                        </div>
                        <div className="ml-4 text-gray-500">
                          {formatDateTime(new Date(user.lastSignIn)).time}
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-500">Never</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </div>
  )
}