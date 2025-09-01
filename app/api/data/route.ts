import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { SELECTLIVE_CONFIG } from '@/config'
import { db } from '@/lib/db'
import { systems, readings, pollingStatus, readingsAgg1d, userSystems } from '@/lib/db/schema'
import { eq, and, desc, or } from 'drizzle-orm'
import { formatTimeAEST, getYesterdayDate, fromUnixTimestamp } from '@/lib/date-utils'
import { roundToThree } from '@/lib/format-opennem'
import { isUserAdmin } from '@/lib/auth-utils'

// Helper function to ensure values are null instead of undefined
function nullifyUndefined<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

export async function GET(request: Request) {
  try {
    // Get the authenticated user's Clerk ID
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({
        success: false,
        error: 'Unauthorized',
      }, { status: 401 })
    }

    // Get systemId from query parameters
    const { searchParams } = new URL(request.url)
    const systemId = searchParams.get('systemId')
    
    if (!systemId) {
      return NextResponse.json({
        success: false,
        error: 'System ID is required',
      }, { status: 400 })
    }
    
    // Get the system first
    const [system] = await db.select()
      .from(systems)
      .where(eq(systems.id, parseInt(systemId)))
      .limit(1);
    
    if (!system) {
      return NextResponse.json({
        success: false,
        error: 'System not found',
      }, { status: 404 });
    }
    
    // Check if user has access to this system
    // Admin can access all systems, regular users can only access their own
    const isAdmin = await isUserAdmin();
    
    // Check user access via userSystems table (for non-owners who have been granted access)
    const userSystemAccess = await db.select()
      .from(userSystems)
      .where(
        and(
          eq(userSystems.clerkUserId, userId),
          eq(userSystems.systemId, system.id)
        )
      )
      .limit(1);
    
    const hasDirectAccess = userSystemAccess.length > 0;
    const isOwner = system.ownerClerkUserId === userId;
    
    if (!isAdmin && !isOwner && !hasDirectAccess) {
      return NextResponse.json({
        success: false,
        error: 'Access denied to system',
      }, { status: 403 });
    }
    
    // Determine user role
    const userRole = isAdmin ? 'admin' : 
                    isOwner ? 'owner' : 
                    hasDirectAccess ? userSystemAccess[0].role : 
                    'viewer';
    
    // Get latest reading from database
    const [latestReading] = await db.select()
      .from(readings)
      .where(eq(readings.systemId, system.id))
      .orderBy(desc(readings.inverterTime))
      .limit(1);
    
    // Get polling status from database
    const [status] = await db.select()
      .from(pollingStatus)
      .where(eq(pollingStatus.systemId, system.id))
      .limit(1);
    
    // Get yesterday's aggregated data using system's timezone
    const systemTimezoneOffsetMinutes = system.timezoneOffsetMin;
    const yesterdayDate = getYesterdayDate(systemTimezoneOffsetMinutes);
    const [yesterdayData] = await db.select()
      .from(readingsAgg1d)
      .where(
        and(
          eq(readingsAgg1d.systemId, String(system.id)),
          eq(readingsAgg1d.day, yesterdayDate)
        )
      )
      .limit(1);
    
    if (latestReading) {
      // Get today values from stored response if available
      const lastResponse = status?.lastResponse as any;
      // Build historical section
      const historical = {
        yesterday: yesterdayData ? {
          date: yesterdayData.day,
          energy: {
            solarKwh: roundToThree(yesterdayData.solarKwh),
            loadKwh: roundToThree(yesterdayData.loadKwh),
            batteryChargeKwh: roundToThree(yesterdayData.batteryChargeKwh),
            batteryDischargeKwh: roundToThree(yesterdayData.batteryDischargeKwh),
            gridImportKwh: roundToThree(yesterdayData.gridImportKwh),
            gridExportKwh: roundToThree(yesterdayData.gridExportKwh),
          },
          power: {
            solar: {
              minW: nullifyUndefined(yesterdayData.solarWMin),
              avgW: nullifyUndefined(yesterdayData.solarWAvg),
              maxW: nullifyUndefined(yesterdayData.solarWMax),
            },
            load: {
              minW: nullifyUndefined(yesterdayData.loadWMin),
              avgW: nullifyUndefined(yesterdayData.loadWAvg),
              maxW: nullifyUndefined(yesterdayData.loadWMax),
            },
            battery: {
              minW: nullifyUndefined(yesterdayData.batteryWMin),
              avgW: nullifyUndefined(yesterdayData.batteryWAvg),
              maxW: nullifyUndefined(yesterdayData.batteryWMax),
            },
            grid: {
              minW: nullifyUndefined(yesterdayData.gridWMin),
              avgW: nullifyUndefined(yesterdayData.gridWAvg),
              maxW: nullifyUndefined(yesterdayData.gridWMax),
            },
          },
          soc: {
            minBattery: roundToThree(yesterdayData.batterySocMin),
            avgBattery: roundToThree(yesterdayData.batterySocAvg),
            maxBattery: roundToThree(yesterdayData.batterySocMax),
            endBattery: roundToThree(yesterdayData.batterySocEnd),
          },
          dataQuality: {
            intervalCount: nullifyUndefined(yesterdayData.intervalCount),
            coverage: yesterdayData.intervalCount ? `${Math.round((yesterdayData.intervalCount / 288) * 100)}%` : null,
          },
        } : null,
        // Placeholder for future periods
        // lastWeek: null,
        // lastMonth: null,
      };
      
      // Structure latest data with hierarchy
      const latest = {
        timestamp: formatTimeAEST(fromUnixTimestamp(latestReading.inverterTime.getTime() / 1000, system.timezoneOffsetMin)),
        power: {
          solarW: latestReading.solarW,
          solarInverterW: latestReading.solarInverterW,
          shuntW: latestReading.shuntW,
          loadW: latestReading.loadW,
          batteryW: latestReading.batteryW,
          gridW: latestReading.gridW,
        },
        soc: {
          battery: latestReading.batterySOC,
        },
        energy: {
          today: {
            solarKwh: roundToThree(lastResponse?.solarKwhToday),
            loadKwh: roundToThree(lastResponse?.loadKwhToday),
            batteryInKwh: roundToThree(lastResponse?.batteryInKwhToday),
            batteryOutKwh: roundToThree(lastResponse?.batteryOutKwhToday),
            gridInKwh: roundToThree(lastResponse?.gridInKwhToday),
            gridOutKwh: roundToThree(lastResponse?.gridOutKwhToday),
          },
          total: {
            solarKwh: latestReading.solarKwhTotal,
            loadKwh: latestReading.loadKwhTotal,
            batteryInKwh: latestReading.batteryInKwhTotal,
            batteryOutKwh: latestReading.batteryOutKwhTotal,
            gridInKwh: latestReading.gridInKwhTotal,
            gridOutKwh: latestReading.gridOutKwhTotal,
          },
        },
        system: {
          faultCode: latestReading.faultCode,
          faultTimestamp: latestReading.faultTimestamp,
          generatorStatus: latestReading.generatorStatus,
        },
      };
      
      return NextResponse.json({
        success: true,
        latest: latest,
        historical: historical,
        inverterTime: formatTimeAEST(fromUnixTimestamp(latestReading.inverterTime.getTime() / 1000, system.timezoneOffsetMin)),
        receivedTime: formatTimeAEST(fromUnixTimestamp(latestReading.receivedTime.getTime() / 1000, system.timezoneOffsetMin)),
        vendorType: system.vendorType,
        vendorSiteId: system.vendorSiteId,
        displayName: system.displayName,
        systemInfo: {
          model: system.model,
          serial: system.serial,
          ratings: system.ratings,
          solarSize: system.solarSize,
          batterySize: system.batterySize,
        },
        polling: {
          lastPollTime: status?.lastPollTime ? formatTimeAEST(fromUnixTimestamp(status.lastPollTime.getTime() / 1000, system.timezoneOffsetMin)) : null,
          lastSuccessTime: status?.lastSuccessTime ? formatTimeAEST(fromUnixTimestamp(status.lastSuccessTime.getTime() / 1000, system.timezoneOffsetMin)) : null,
          lastErrorTime: status?.lastErrorTime ? formatTimeAEST(fromUnixTimestamp(status.lastErrorTime.getTime() / 1000, system.timezoneOffsetMin)) : null,
          lastError: status?.lastError || null,
          consecutiveErrors: status?.consecutiveErrors || 0,
          totalPolls: status?.totalPolls || 0,
          successfulPolls: status?.successfulPolls || 0,
          isActive: system.status === 'active',
        }
      })
    } else if (status?.lastError) {
      return NextResponse.json({
        success: false,
        error: status.lastError,
        timestamp: new Date(),
        polling: {
          lastPollTime: status?.lastPollTime ? formatTimeAEST(fromUnixTimestamp(status.lastPollTime.getTime() / 1000, system.timezoneOffsetMin)) : null,
          lastSuccessTime: status?.lastSuccessTime ? formatTimeAEST(fromUnixTimestamp(status.lastSuccessTime.getTime() / 1000, system.timezoneOffsetMin)) : null,
          lastErrorTime: status?.lastErrorTime ? formatTimeAEST(fromUnixTimestamp(status.lastErrorTime.getTime() / 1000, system.timezoneOffsetMin)) : null,
          lastError: status?.lastError || null,
          consecutiveErrors: status?.consecutiveErrors || 0,
          totalPolls: status?.totalPolls || 0,
          successfulPolls: status?.successfulPolls || 0,
          isActive: system.status === 'active',
        }
      }, { status: 503 })
    } else {
      // No data yet
      return NextResponse.json({
        success: false,
        error: 'No data available yet.',
        timestamp: new Date(),
        polling: status ? {
          lastPollTime: status.lastPollTime || null,
          lastSuccessTime: status.lastSuccessTime || null,
          lastErrorTime: status.lastErrorTime || null,
          lastError: status.lastError || null,
          consecutiveErrors: status.consecutiveErrors || 0,
          totalPolls: status.totalPolls || 0,
          successfulPolls: status.successfulPolls || 0,
          isActive: system.status === 'active',
        } : null
      }, { status: 503 })
    }
    
  } catch (error) {
    console.error('API Error:', error)
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
      timestamp: new Date(),
    }, { status: 500 })
  }
}