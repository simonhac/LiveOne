import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { isUserAdmin } from '@/lib/auth-utils'
import { getSelectLiveCredentials } from '@/lib/selectronic/credentials'
import { getEnphaseCredentials } from '@/lib/enphase/enphase-client'
import { SelectronicFetchClient } from '@/lib/selectronic/selectronic-client'
import { getEnphaseClient } from '@/lib/enphase/enphase-client'
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
    
    // Get usernames for better logging
    const { clerkClient: getClerkClient } = await import('@clerk/nextjs/server')
    const clerk = await getClerkClient()
    let currentUserName = 'unknown'
    let ownerUserName = 'unknown'
    
    try {
      const currentUser = await clerk.users.getUser(userId)
      currentUserName = currentUser.username || currentUser.emailAddresses[0]?.emailAddress || 'unknown'
    } catch (e) {}
    
    try {
      const ownerUser = await clerk.users.getUser(ownerClerkUserId)
      ownerUserName = ownerUser.username || ownerUser.emailAddresses[0]?.emailAddress || 'unknown'
    } catch (e) {}
    
    console.log('[Test Connection] Request received:', {
      currentUser: `${userId} (${currentUserName})`,
      ownerUser: `${ownerClerkUserId} (${ownerUserName})`,
      vendorType,
      vendorSiteId
    })
    
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
    
    // Handle different vendor types
    if (vendorType === 'enphase') {
      // Clean up the system ID - remove any decimal point that might exist in the database
      const cleanSystemId = String(vendorSiteId).replace(/\.0$/, '').split('.')[0]
      console.log(`[Test Connection] Testing Enphase for owner ${ownerClerkUserId}, site ${vendorSiteId}${cleanSystemId !== vendorSiteId ? ` (cleaned: ${cleanSystemId})` : ''}`)
      const credentials = await getEnphaseCredentials(ownerClerkUserId)
      
      if (!credentials) {
        console.log(`[Test Connection] No Enphase credentials found for owner ${ownerClerkUserId}`)
        return NextResponse.json({ 
          error: 'No Enphase credentials found for this user' 
        }, { status: 404 })
      }
      
      // Check if token is expired
      if (credentials.expires_at < Date.now()) {
        return NextResponse.json({ 
          error: 'Enphase token expired. Please reconnect your system.' 
        }, { status: 401 })
      }
      
      try {
        // Create Enphase client
        const client = getEnphaseClient()
        
        // Fetch latest telemetry data with cleaned system ID
        const telemetry = await client.getLatestTelemetry(
          cleanSystemId,
          credentials.access_token
        )
        
        // Extract the raw vendor response from telemetry
        const rawVendorResponse = telemetry.raw
        
        // Extract power and energy values
        // Use actual values or null if undefined to properly represent missing data
        const currentPower = telemetry.production_power ?? null
        const consumptionPower = telemetry.consumption_power ?? null
        
        // Enphase summary provides energy_today in Wh
        const todayProduction = telemetry.energy_today ?? null
        const todayConsumption = null // Summary endpoint doesn't provide consumption
        
        console.log(`[Test Connection] Enphase telemetry parsed - Production: ${currentPower}W, Consumption: ${consumptionPower}W, Today: ${todayProduction}Wh`)
        
        // Format response to match test-connection format
        return NextResponse.json({
          success: true,
          timestamp: new Date().toISOString(),
          vendorResponse: rawVendorResponse, // Include raw vendor response
          credentials: {
            systemId: cleanSystemId,
            vendorType: 'enphase'
          },
          latest: {
            timestamp: new Date().toISOString(),
            power: {
              solarW: currentPower,
              loadW: consumptionPower, // Use actual consumption if available
              batteryW: null, // No battery data in basic Enphase API
              gridW: null,
            },
            soc: {
              battery: null,
            },
            energy: {
              today: {
                solarKwh: todayProduction ? todayProduction / 1000 : null, // Convert to kWh if available
                loadKwh: todayConsumption ? todayConsumption / 1000 : null, // Convert to kWh if available
                batteryInKwh: null,
                batteryOutKwh: null,
                gridInKwh: null,
                gridOutKwh: null,
              }
            },
            generatorStatus: 0,
          },
          systemInfo: {
            model: 'Enphase System',
            serial: cleanSystemId,
            ratings: null,
            // Use system_size from telemetry if available, otherwise fallback to current power
            solarSize: telemetry.system_size !== null && telemetry.system_size !== undefined
              ? `${(telemetry.system_size / 1000).toFixed(1)} kW`
              : currentPower !== null 
              ? `${(currentPower / 1000).toFixed(1)} kW capacity` 
              : null,
            batterySize: telemetry.storage_soc && telemetry.storage_soc > 0 ? 'Battery present' : null
          }
        })
      } catch (error) {
        console.error('Error fetching Enphase data:', error)
        return NextResponse.json({ 
          error: 'Failed to fetch data from Enphase',
          details: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 })
      }
      
    } else if (vendorType === 'select.live') {
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
      // Extract the raw vendor response from data
      const rawVendorResponse = data.raw
      
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
        vendorResponse: rawVendorResponse, // Include raw vendor response
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
    } else {
      return NextResponse.json({ 
        error: `Unsupported vendor type: ${vendorType}` 
      }, { status: 400 })
    }
    
  } catch (error) {
    console.error('Error testing connection:', error)
    return NextResponse.json({
      error: 'Failed to test connection',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}