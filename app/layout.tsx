import type { Metadata } from 'next'
import { DM_Sans } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import { Analytics } from "@vercel/analytics/next"
import './globals.css'

const dmSans = DM_Sans({ 
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  preload: false, // Disable preloading to avoid unused preload warnings
})

export const metadata: Metadata = {
  title: process.env.NODE_ENV === 'development' ? 'LiveOne — Dev' : 'LiveOne',
  description: 'Real-time solar energy monitoring and analytics',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const isDev = process.env.NODE_ENV === 'development'
  
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={dmSans.className}>
          {isDev && (
            <div className="fixed top-0 left-0 right-0 h-1 bg-orange-500 z-[9999]" />
          )}
          {children}
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  )
}