import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { isUserAdmin } from '@/lib/auth-utils'
import { db } from '@/lib/db'
import { readings, systems, pollingStatus, userSystems } from '@/lib/db/schema'
import { eq, sql, max, min } from 'drizzle-orm'

// Helper to create a streaming response
function createStreamResponse() {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController

  const stream = new ReadableStream({
    start(c) {
      controller = c
    }
  })

  const send = (data: any) => {
    const line = JSON.stringify(data) + '\n'
    controller.enqueue(encoder.encode(line))
  }

  const close = () => {
    controller.close()
  }

  return { stream, send, close }
}

export async function POST(request: NextRequest) {
  try {
    // Check if user is authenticated and admin
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const isAdmin = await isUserAdmin()
    
    if (!isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    
    // Check if we're in development environment
    const isDevelopment = process.env.NODE_ENV === 'development'
    const tursoUrl = process.env.TURSO_DATABASE_URL
    const tursoToken = process.env.TURSO_AUTH_TOKEN
    
    if (!isDevelopment) {
      return NextResponse.json({ 
        error: 'Sync is only available in development environment' 
      }, { status: 400 })
    }
    
    if (!tursoUrl || !tursoToken) {
      return NextResponse.json({ 
        error: 'Production database credentials not configured' 
      }, { status: 400 })
    }
    
    // Create streaming response
    const { stream, send, close } = createStreamResponse()
    
    // Start the sync process in the background
    syncDatabase(send, close, request.signal).catch(err => {
      console.error('Sync error:', err)
      send({ type: 'error', message: err.message })
      close()
    })
    
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
    })
    
  } catch (error) {
    console.error('Sync initialization error:', error)
    return NextResponse.json({
      error: 'Failed to start sync',
    }, { status: 500 })
  }
}

async function syncDatabase(
  send: (data: any) => void,
  close: () => void,
  signal: AbortSignal
) {
  try {
    // Step 1: Check what data we already have locally
    send({ 
      type: 'progress', 
      message: 'Checking local database...', 
      progress: 0, 
      total: 100 
    })
    
    // Get the latest reading timestamp in local database
    const allReadings = await db
      .select()
      .from(readings)
      .orderBy(sql`${readings.inverterTime} DESC`)
      .limit(1)
    
    const localLatestTime = allReadings.length > 0 ? allReadings[0].inverterTime : new Date(0)
    
    // Format date as "DD MMM YYYY"
    const formatDate = (date: Date) => {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const day = date.getDate().toString().padStart(2, '0')
      const month = months[date.getMonth()]
      const year = date.getFullYear()
      return `${day} ${month} ${year}`
    }
    
    send({ 
      type: 'progress', 
      message: `Latest local data: ${localLatestTime ? formatDate(new Date(localLatestTime)) : 'No data'}`, 
      progress: 5, 
      total: 100 
    })
    
    // Step 2: Connect to production database
    if (signal.aborted) throw new Error('Sync cancelled')
    
    send({ 
      type: 'progress', 
      message: 'Connecting to production database...', 
      progress: 10, 
      total: 100 
    })
    
    // Import Turso client dynamically
    const { createClient } = await import('@libsql/client')
    
    const prodDb = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    })
    
    // Step 3: Sync systems table first
    if (signal.aborted) throw new Error('Sync cancelled')
    
    send({ 
      type: 'progress', 
      message: 'Syncing systems...', 
      progress: 15, 
      total: 100 
    })
    
    const prodSystems = await prodDb.execute('SELECT * FROM systems')
    
    for (const system of prodSystems.rows) {
      // Check if system exists locally
      const [existingSystem] = await db
        .select()
        .from(systems)
        .where(eq(systems.id, system.id as number))
        .limit(1)
      
      if (!existingSystem) {
        // Insert new system
        await db.insert(systems).values({
          ownerClerkUserId: system.owner_clerk_user_id as string | undefined,
          vendorType: system.vendor_type as string,
          vendorSiteId: system.vendor_site_id as string,
          displayName: system.display_name as string,
          model: system.model as string | undefined,
          serial: system.serial as string | undefined,
          ratings: system.ratings as string | undefined,
          solarSize: system.solar_size as string | undefined,
          batterySize: system.battery_size as string | undefined,
          timezoneOffsetMin: system.timezone_offset_min as number,
          createdAt: new Date(system.created_at as number * 1000),
          updatedAt: new Date(system.updated_at as number * 1000),
        })
      }
    }
    
    // Step 4: Count total readings to sync
    if (signal.aborted) throw new Error('Sync cancelled')
    
    send({ 
      type: 'progress', 
      message: 'Counting new data to sync...', 
      progress: 20, 
      total: 100 
    })
    
    const countResult = await prodDb.execute(
      `SELECT COUNT(*) as count FROM readings WHERE inverter_time > ?`,
      [Math.floor(localLatestTime.getTime() / 1000)]
    )
    
    const totalToSync = (countResult.rows[0]?.count as number) || 0
    
    if (totalToSync === 0) {
      send({ 
        type: 'progress', 
        message: 'Local database is already up to date!', 
        progress: 100, 
        total: 100 
      })
      send({ type: 'complete' })
      close()
      return
    }
    
    send({ 
      type: 'progress', 
      message: `Found ${totalToSync.toLocaleString()} new readings to sync from production`, 
      progress: 25, 
      total: 100 
    })
    
    // Step 5: Sync readings in batches
    const BATCH_SIZE = 1000
    let offset = 0
    let synced = 0
    
    while (synced < totalToSync) {
      if (signal.aborted) throw new Error('Sync cancelled')
      
      // Calculate progress (25% to 95% for data sync)
      const dataProgress = 25 + (synced / totalToSync) * 70
      
      const percentComplete = Math.round((synced / totalToSync) * 100)
      send({ 
        type: 'progress', 
        message: `Syncing readings: ${synced.toLocaleString()} of ${totalToSync.toLocaleString()} (${percentComplete}%)`, 
        progress: Math.round(dataProgress), 
        total: 100 
      })
      
      // Fetch batch from production
      const batchResult = await prodDb.execute(
        `SELECT * FROM readings 
         WHERE inverter_time > ? 
         ORDER BY inverter_time 
         LIMIT ? OFFSET ?`,
        [Math.floor(localLatestTime.getTime() / 1000), BATCH_SIZE, offset]
      )
      
      if (batchResult.rows.length === 0) break
      
      // Insert batch into local database
      const batchData = batchResult.rows.map(row => ({
        systemId: row.system_id as number,
        inverterTime: new Date(row.inverter_time as number * 1000),
        receivedTime: new Date(row.received_time as number * 1000),
        delaySeconds: row.delay_seconds as number | undefined,
        solarW: row.solar_w as number,
        solarInverterW: row.solar_inverter_w as number,
        shuntW: row.shunt_w as number,
        loadW: row.load_w as number,
        batteryW: row.battery_w as number,
        gridW: row.grid_w as number,
        batterySOC: row.battery_soc as number,
        faultCode: row.fault_code as number,
        faultTimestamp: row.fault_timestamp as number,
        generatorStatus: row.generator_status as number,
        solarKwhTotal: row.solar_kwh_total as number | undefined,
        loadKwhTotal: row.load_kwh_total as number | undefined,
        batteryInKwhTotal: row.battery_in_kwh_total as number | undefined,
        batteryOutKwhTotal: row.battery_out_kwh_total as number | undefined,
        gridInKwhTotal: row.grid_in_kwh_total as number | undefined,
        gridOutKwhTotal: row.grid_out_kwh_total as number | undefined,
        createdAt: new Date(row.created_at as number * 1000),
      }))
      
      // Insert in smaller chunks to avoid SQLite limits
      for (let i = 0; i < batchData.length; i += 100) {
        const chunk = batchData.slice(i, i + 100)
        await db.insert(readings).values(chunk).onConflictDoNothing()
      }
      
      synced += batchResult.rows.length
      offset += BATCH_SIZE
      
      // Small delay to prevent overwhelming the database
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    
    // Step 6: Sync other tables (user_systems, polling_status) if needed
    if (signal.aborted) throw new Error('Sync cancelled')
    
    send({ 
      type: 'progress', 
      message: 'Finalizing sync...', 
      progress: 96, 
      total: 100 
    })
    
    // Try to sync user_systems if it exists
    try {
      const prodUserSystems = await prodDb.execute('SELECT * FROM user_systems')
      for (const us of prodUserSystems.rows) {
        await db.insert(userSystems).values({
          id: us.id as number,
          clerkUserId: us.clerk_user_id as string,
          systemId: us.system_id as number,
          role: us.role as string,
          createdAt: new Date(us.created_at as number * 1000),
          updatedAt: new Date(us.updated_at as number * 1000),
        }).onConflictDoNothing()
      }
    } catch (err: any) {
      // Table might not exist in production yet, that's ok
      console.log('user_systems table not found in production (expected for new tables)')
    }
    
    // Step 7: Complete
    send({ 
      type: 'progress', 
      message: `Successfully synced ${synced.toLocaleString()} readings from production!`, 
      progress: 100, 
      total: 100 
    })
    
    send({ type: 'complete' })
    close()
    
  } catch (error: any) {
    if (error.message === 'Sync cancelled') {
      send({ type: 'error', message: 'Sync was cancelled by user' })
    } else {
      console.error('Sync error:', error)
      send({ type: 'error', message: error.message || 'Sync failed' })
    }
    close()
  }
}