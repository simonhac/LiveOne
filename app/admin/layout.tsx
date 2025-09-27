'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { UserButton } from '@clerk/nextjs'
import { 
  Server, 
  Users, 
  Database, 
  Activity,
  Home,
  ChevronRight,
  Menu,
  X
} from 'lucide-react'

const navItems = [
  { 
    name: 'Systems', 
    href: '/admin', 
    icon: Server,
    description: 'Manage and monitor all systems'
  },
  { 
    name: 'Users', 
    href: '/admin/users', 
    icon: Users,
    description: 'Manage user access and permissions'
  },
  { 
    name: 'Activity', 
    href: '/admin/activity', 
    icon: Activity,
    description: 'View system activity logs'
  },
  { 
    name: 'Storage', 
    href: '/admin/storage', 
    icon: Database,
    description: 'Manage data storage and retention'
  },
]

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Top bar - full width */}
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="px-2 sm:px-6 lg:px-8 py-2 sm:py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              {/* Mobile menu button */}
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="lg:hidden p-2 text-gray-400 hover:text-white"
              >
                {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
              <h1 className="text-2xl font-bold text-white">
                <span className="hidden sm:inline">LiveOne </span>Administration
              </h1>
            </div>
            <div className="flex items-center gap-4">
              <Link
                href="/dashboard"
                className="flex items-center gap-2 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm font-medium"
              >
                <Home className="w-4 h-4" />
                Dashboard
              </Link>
              <UserButton 
                afterSignOutUrl="/sign-in"
                appearance={{
                  elements: {
                    avatarBox: "w-8 h-8"
                  }
                }}
              />
            </div>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar - positioned under header with rounded corners */}
        <div className={`fixed lg:relative top-[73px] lg:top-0 left-0 z-40 w-[220px] h-[calc(100vh-73px)] lg:h-[calc(100vh-73px)] transform transition-transform lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}>
          <div className="bg-gray-800 h-full border-r border-t border-gray-700">
            <div className="flex flex-col h-full">
              {/* Navigation */}
              <nav className="flex-1 p-4 space-y-1">
                {navItems.map((item) => {
                  const isActive = pathname === item.href || 
                                 (item.href === '/admin' && pathname === '/admin')
                  const Icon = item.icon
                  
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`group flex items-center px-3 py-3 rounded-lg transition-all ${
                        isActive
                          ? 'bg-blue-600 text-white'
                          : 'text-gray-400 hover:bg-gray-700 hover:text-white'
                      }`}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <Icon className={`w-5 h-5 flex-shrink-0 ${
                        isActive ? 'text-white' : 'text-gray-400 group-hover:text-white'
                      }`} />
                      <div className="ml-3 flex-1">
                        <p className="text-sm font-medium">{item.name}</p>
                        <p className={`text-xs mt-0.5 ${
                          isActive ? 'text-blue-100' : 'text-gray-500 group-hover:text-gray-400'
                        }`}>
                          {item.description}
                        </p>
                      </div>
                      {isActive && (
                        <ChevronRight className="w-4 h-4 flex-shrink-0 ml-2" />
                      )}
                    </Link>
                  )
                })}
              </nav>
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 lg:pl-0">
          <main className="h-[calc(100vh-73px)] sm:h-[calc(100vh-89px)]">
            {children}
          </main>
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  )
}