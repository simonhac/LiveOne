import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readings, systems, pollingStatus } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { SELECTLIVE_CONFIG } from '@/config';

// Helper function to round to 3 decimal places
const roundToThree = (value: number | null | undefined): number | null => {
  return value != null ? Math.round(value * 1000) / 1000 : null;
};

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
      // Get today values from stored response if available
      const lastResponse = status?.lastResponse as any;
      
      // Convert reading to API format
      const data = {
        timestamp: latestReading.inverterTime.toISOString(),
        solarW: latestReading.solarW,
        solarInverterW: latestReading.solarInverterW,
        shuntW: latestReading.shuntW,
        loadW: latestReading.loadW,
        batteryW: latestReading.batteryW,
        batterySOC: latestReading.batterySOC,
        gridW: latestReading.gridW,
        faultCode: latestReading.faultCode,
        faultTimestamp: latestReading.faultTimestamp,
        generatorStatus: latestReading.generatorStatus,
        solarKwhTotal: latestReading.solarKwhTotal,
        loadKwhTotal: latestReading.loadKwhTotal,
        batteryInKwhTotal: latestReading.batteryInKwhTotal,
        batteryOutKwhTotal: latestReading.batteryOutKwhTotal,
        gridInKwhTotal: latestReading.gridInKwhTotal,
        gridOutKwhTotal: latestReading.gridOutKwhTotal,
        // Use today values from stored Select.Live response (rounded to 3 decimal places)
        solarKwhToday: roundToThree(lastResponse?.solarKwhToday),
        loadKwhToday: roundToThree(lastResponse?.loadKwhToday),
        batteryInKwhToday: roundToThree(lastResponse?.batteryInKwhToday),
        batteryOutKwhToday: roundToThree(lastResponse?.batteryOutKwhToday),
        gridInKwhToday: roundToThree(lastResponse?.gridInKwhToday),
        gridOutKwhToday: roundToThree(lastResponse?.gridOutKwhToday),
      };

      return NextResponse.json({
        success: true,
        data: data,
        timestamp: latestReading.receivedTime || latestReading.inverterTime,
        systemInfo: {
          model: system.model,
          serial: system.serial,
          ratings: system.ratings,
          solarSize: system.solarSize,
          batterySize: system.batterySize,
        },
        status: {
          isPolling: status?.isActive || false,
          isAuthenticated: true, // Always true if we have data
        }
      });
    } else if (status?.lastError) {
      return NextResponse.json({
        success: false,
        error: status.lastError,
        timestamp: new Date(),
        status: {
          isPolling: status?.isActive || false,
          isAuthenticated: true, // Always true if we have data
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
          isAuthenticated: true, // Always true if we have data
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