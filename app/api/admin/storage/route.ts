import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { readings } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'
import { isUserAdmin } from '@/lib/auth-utils'

export async function GET(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    // Check if user is admin
    const isAdmin = await isUserAdmin()
    
    if (!isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    
    // Determine database type based on environment variables
    const isDevelopment = process.env.NODE_ENV === 'development'
    const databaseUrl = process.env.DATABASE_URL || 'file:./dev.db'
    const tursoUrl = process.env.TURSO_DATABASE_URL
    
    // Check if we're using Turso (production) or SQLite (development)
    const isUsingTurso = tursoUrl && !databaseUrl.startsWith('file:')
    
    // Mask sensitive parts of the database URL
    const maskedUrl = (() => {
      if (isUsingTurso && tursoUrl) {
        // For Turso URLs: libsql://database-name-user.region.turso.io
        const parts = tursoUrl.split('.')
        if (parts.length >= 3) {
          const dbPart = parts[0].split('//')[1]
          const maskedDb = dbPart.substring(0, 8) + '...'
          return `libsql://${maskedDb}.${parts[1]}.turso.io`
        }
        return 'libsql://*****.turso.io'
      } else {
        // For SQLite
        return databaseUrl.replace(/\/([^\/]+)$/, '/***')
      }
    })()
    
    // Get database statistics
    let stats = null
    try {
      // Get total readings count
      const countResults = await db
        .select()
        .from(readings)
      const totalCount = countResults.length
      
      // Get oldest and newest readings
      const oldestResults = await db
        .select()
        .from(readings)
        .orderBy(readings.inverterTime)
        .limit(1)
      
      const newestResults = await db
        .select()
        .from(readings)
        .orderBy(sql`${readings.inverterTime} DESC`)
        .limit(1)
      
      // Count tables (we know our schema has these tables)
      const tableCount = 5 // systems, readings, pollingStatus, userSystems, readingsAgg5m, readingsAgg1d
      
      // Format date as "DD MMM YYYY"
      const formatDate = (date: Date) => {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        const day = date.getDate().toString().padStart(2, '0')
        const month = months[date.getMonth()]
        const year = date.getFullYear()
        return `${day} ${month} ${year}`
      }
      
      stats = {
        tables: tableCount,
        totalReadings: totalCount || 0,
        oldestReading: oldestResults.length > 0 ? formatDate(new Date(oldestResults[0].inverterTime)) : 'No data',
        newestReading: newestResults.length > 0 ? formatDate(new Date(newestResults[0].inverterTime)) : 'No data',
      }
      
      // Try to get database size for SQLite
      if (!isUsingTurso) {
        try {
          // This would work if we had direct file system access
          // For now, we'll skip disk size for security reasons
        } catch (err) {
          // Ignore disk size errors
        }
      }
    } catch (err) {
      console.error('Error fetching database stats:', err)
    }
    
    // Prepare response
    const response = {
      success: true,
      database: {
        type: isUsingTurso ? 'production' as const : 'development' as const,
        provider: isUsingTurso ? 'Turso (LibSQL)' : 'SQLite',
        stats
      },
      environment: {
        nodeEnv: process.env.NODE_ENV || 'development',
        vercelEnv: process.env.VERCEL_ENV,
        region: process.env.VERCEL_REGION,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID?.substring(0, 8) + '...'
      }
    }
    
    return NextResponse.json(response)
    
  } catch (error) {
    console.error('Error fetching settings:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch settings',
    }, { status: 500 })
  }
}