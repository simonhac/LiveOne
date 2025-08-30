import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { isUserAdmin } from '@/lib/auth-utils'
import { getSelectLiveCredentials } from '@/lib/secure-credentials'
import { SelectronicFetchClient } from '@/lib/selectronic-fetch-client'
import { db } from '@/lib/db'
import { systems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function POST(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    // Get the system details from the request
    const { ownerClerkUserId, vendorType, vendorSiteId } = await request.json()
    
    if (!ownerClerkUserId || !vendorType || !vendorSiteId) {
      return NextResponse.json({ error: 'Owner ID, vendor type, and vendor site ID required' }, { status: 400 })
    }
    
    // Check if user is admin
    const isAdmin = await isUserAdmin()
    
    // If not admin, verify the user can only test their own credentials
    if (!isAdmin) {
      // For regular users, they can only test their own credentials
      if (ownerClerkUserId !== userId) {
        return NextResponse.json({ error: 'You can only test your own systems' }, { status: 403 })
      }
    }
    
    // Get the user's Select.Live credentials
    const credentials = await getSelectLiveCredentials(ownerClerkUserId)
    
    if (!credentials) {
      return NextResponse.json({ 
        error: 'No Select.Live credentials found for this user' 
      }, { status: 404 })
    }
    
    // Create client and test connection
    const client = new SelectronicFetchClient({
      email: credentials.email,
      password: credentials.password,
      systemNumber: vendorSiteId
    })
    
    // Authenticate
    const authSuccess = await client.authenticate()
    
    if (!authSuccess) {
      return NextResponse.json({ 
        error: 'Failed to authenticate with Select.Live' 
      }, { status: 401 })
    }
    
    // Fetch current data
    const result = await client.fetchData()
    
    if (!result.success || !result.data) {
      return NextResponse.json({ 
        error: result.error || 'Failed to fetch data from Select.Live' 
      }, { status: 500 })
    }
    
    const data = result.data
    
    // Also fetch system info (model, serial, ratings, etc.)
    const systemInfo = await client.fetchSystemInfo()
    console.log('[Test Connection] System info received:', JSON.stringify(systemInfo, null, 2))
    
    // If we got system info and it has data, update the database
    if (systemInfo && (systemInfo.model || systemInfo.serial || systemInfo.ratings || 
        systemInfo.solarSize || systemInfo.batterySize)) {
      try {
        // Find the system by vendor site ID (may not exist yet)
        const [system] = await db.select()
          .from(systems)
          .where(eq(systems.vendorSiteId, vendorSiteId))
          .limit(1)
        
        if (system) {
          // Update the system with the new info
          await db.update(systems)
            .set({
              model: systemInfo.model,
              serial: systemInfo.serial,
              ratings: systemInfo.ratings,
              solarSize: systemInfo.solarSize,
              batterySize: systemInfo.batterySize,
              updatedAt: new Date()
            })
            .where(eq(systems.id, system.id))
          
          console.log(`Updated system info for system ${vendorSiteId}`)
        }
      } catch (error) {
        console.error('Error updating system info in database:', error)
        // Don't fail the request if we couldn't update the database
      }
    }
    
    // Format the response matching /api/data structure
    return NextResponse.json({
      success: true,
      timestamp: data.timestamp.toISOString(),
      credentials: {
        email: credentials.email,
        vendorSiteId: vendorSiteId
      },
      latest: {
        timestamp: data.timestamp.toISOString(),
        power: {
          solarW: data.solarW,
          loadW: data.loadW,
          batteryW: data.batteryW,
          gridW: data.gridW,
        },
        soc: {
          battery: data.batterySOC,
        },
        energy: {
          today: {
            solarKwh: parseFloat(data.solarKwhToday.toFixed(1)),
            loadKwh: parseFloat(data.loadKwhToday.toFixed(1)),
            batteryInKwh: parseFloat(data.batteryInKwhToday.toFixed(1)),
            batteryOutKwh: parseFloat(data.batteryOutKwhToday.toFixed(1)),
            gridInKwh: parseFloat(data.gridInKwhToday.toFixed(1)),
            gridOutKwh: parseFloat(data.gridOutKwhToday.toFixed(1)),
          }
        },
        generatorStatus: data.generatorStatus,
      },
      systemInfo: systemInfo || {
        model: null,
        serial: null,
        ratings: null,
        solarSize: null,
        batterySize: null
      }
    })
    
  } catch (error) {
    console.error('Error testing connection:', error)
    return NextResponse.json({
      error: 'Failed to test connection',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}