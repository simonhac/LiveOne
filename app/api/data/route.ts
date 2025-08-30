import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { SELECTLIVE_CONFIG } from '@/config'
import { db } from '@/lib/db'
import { systems, readings, pollingStatus, readingsAgg1d, userSystems } from '@/lib/db/schema'
import { eq, and, desc, or } from 'drizzle-orm'
import { formatTimeAEST, getYesterdayDate, fromUnixTimestamp } from '@/lib/date-utils'
import { roundToThree } from '@/lib/format-opennem'

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
    
    // Get the system and check user access (systemId is our internal ID)
    const userSystemRecords = await db.select()
      .from(userSystems)
      .innerJoin(systems, eq(systems.id, userSystems.systemId))
      .where(
        and(
          eq(userSystems.clerkUserId, userId),
          eq(systems.id, parseInt(systemId))
        )
      );
    
    if (userSystemRecords.length === 0) {
      // Check if user is admin
      const isAdmin = await db.select()
        .from(userSystems)
        .where(
          and(
            eq(userSystems.clerkUserId, userId),
            eq(userSystems.role, 'admin')
          )
        )
        .limit(1);
      
      if (isAdmin.length > 0) {
        // Admin can access any system
        const [adminSystem] = await db.select()
          .from(systems)
          .where(eq(systems.id, parseInt(systemId)))
          .limit(1);
        
        if (!adminSystem) {
          return NextResponse.json({
            success: false,
            error: 'System not found or access denied',
          }, { status: 404 });
        }
        
        var system = adminSystem;
        var userRole = 'admin';
      } else {
        return NextResponse.json({
          success: false,
          error: 'System not found or access denied',
        }, { status: 404 });
      }
    } else {
      var system = userSystemRecords[0].systems;
      var userRole = userSystemRecords[0].user_systems.role;
    }
    
    if (!system) {
      return NextResponse.json({
        success: false,
        error: 'System not found',
        timestamp: new Date(),
      }, { status: 404 });
    }
    
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
              minW: yesterdayData.solarWMin,
              avgW: yesterdayData.solarWAvg,
              maxW: yesterdayData.solarWMax,
            },
            load: {
              minW: yesterdayData.loadWMin,
              avgW: yesterdayData.loadWAvg,
              maxW: yesterdayData.loadWMax,
            },
            battery: {
              minW: yesterdayData.batteryWMin,
              avgW: yesterdayData.batteryWAvg,
              maxW: yesterdayData.batteryWMax,
            },
            grid: {
              minW: yesterdayData.gridWMin,
              avgW: yesterdayData.gridWAvg,
              maxW: yesterdayData.gridWMax,
            },
          },
          soc: {
            minBattery: roundToThree(yesterdayData.batterySocMin),
            avgBattery: roundToThree(yesterdayData.batterySocAvg),
            maxBattery: roundToThree(yesterdayData.batterySocMax),
            endBattery: roundToThree(yesterdayData.batterySocEnd),
          },
          dataQuality: {
            intervalCount: yesterdayData.intervalCount,
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
          isActive: status?.isActive || false,
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
          isActive: status?.isActive || false,
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
          isActive: status.isActive || false,
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