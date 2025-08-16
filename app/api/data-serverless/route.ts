import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readings, systems, pollingStatus } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { SELECTLIVE_CONFIG } from '@/config';

export async function GET(request: Request) {
  try {
    // In production, you'd verify the user's session here
    // For MVP, we're using hardcoded user
    const userId = 'simon';
    const systemNumber = SELECTLIVE_CONFIG.systemNumber;
    
    // Get system from database
    const [system] = await db.select()
      .from(systems)
      .where(eq(systems.systemNumber, systemNumber))
      .limit(1);
    
    if (!system) {
      return NextResponse.json({
        success: false,
        error: 'System not found',
        timestamp: new Date(),
      }, { status: 404 });
    }

    // Get latest reading
    const [latestReading] = await db.select()
      .from(readings)
      .where(eq(readings.systemId, system.id))
      .orderBy(desc(readings.inverterTime))
      .limit(1);

    // Get polling status
    const [status] = await db.select()
      .from(pollingStatus)
      .where(eq(pollingStatus.systemId, system.id))
      .limit(1);

    if (latestReading) {
      // Convert reading to API format
      const data = {
        timestamp: latestReading.inverterTime.toISOString(),
        solarPower: latestReading.solarPower,
        solarInverterPower: latestReading.solarInverterPower,
        shuntPower: latestReading.shuntPower,
        loadPower: latestReading.loadPower,
        batteryPower: latestReading.batteryPower,
        batterySOC: latestReading.batterySOC,
        gridPower: latestReading.gridPower,
        faultCode: latestReading.faultCode,
        faultTimestamp: latestReading.faultTimestamp,
        generatorStatus: latestReading.generatorStatus,
        solarKwhTotal: latestReading.solarKwhTotal,
        loadKwhTotal: latestReading.loadKwhTotal,
        batteryInKwhTotal: latestReading.batteryInKwhTotal,
        batteryOutKwhTotal: latestReading.batteryOutKwhTotal,
        gridInKwhTotal: latestReading.gridInKwhTotal,
        gridOutKwhTotal: latestReading.gridOutKwhTotal,
        // Calculate today's values (would need to query for start of day)
        solarKwhToday: 0, // TODO: Calculate from database
        loadKwhToday: 0,
        batteryInKwhToday: 0,
        batteryOutKwhToday: 0,
        gridInKwhToday: 0,
        gridOutKwhToday: 0,
      };

      return NextResponse.json({
        success: true,
        data: data,
        timestamp: latestReading.receivedTime || latestReading.inverterTime,
        systemInfo: system.systemInfo,
        status: {
          isPolling: status?.isActive || false,
          isAuthenticated: status?.isAuthenticated || false,
        }
      });
    } else if (status?.lastError) {
      return NextResponse.json({
        success: false,
        error: status.lastError,
        timestamp: new Date(),
        status: {
          isPolling: status?.isActive || false,
          isAuthenticated: status?.isAuthenticated || false,
        }
      }, { status: 503 });
    } else {
      // No data yet, might be first request
      return NextResponse.json({
        success: false,
        error: 'No data available yet. Polling service may be starting up.',
        timestamp: new Date(),
        status: {
          isPolling: status?.isActive || false,
          isAuthenticated: status?.isAuthenticated || false,
        }
      }, { status: 503 });
    }
    
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
      timestamp: new Date(),
    }, { status: 500 });
  }
}