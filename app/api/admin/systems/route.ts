import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systems, readings, pollingStatus } from '@/lib/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { formatToAEST } from '@/lib/date-utils';

export async function GET(request: NextRequest) {
  try {
    // Check for auth token - accept either admin or regular password
    const authToken = request.cookies.get('auth-token')?.value;
    const validPassword = process.env.AUTH_PASSWORD;
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    const isAuthorized = (validPassword && authToken === validPassword) || 
                         (adminPassword && authToken === adminPassword);
    
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Get all systems with their latest data
    const allSystems = await db.select().from(systems);
    const systemsData = [];
    
    for (const system of allSystems) {
      // Get latest reading
      const latestReading = await db
        .select()
        .from(readings)
        .where(eq(readings.systemId, system.id))
        .orderBy(desc(readings.inverterTime))
        .limit(1);
      
      // Get polling status
      const status = await db
        .select()
        .from(pollingStatus)
        .where(eq(pollingStatus.systemId, system.id))
        .limit(1);
      
      const reading = latestReading[0];
      const pollStatus = status[0];
      
      systemsData.push({
        owner: system.userId,
        displayName: system.displayName || system.userId,
        systemNumber: system.systemNumber,
        lastLogin: null, // No longer tracking user sessions
        isLoggedIn: false, // No longer tracking user sessions
        activeSessions: 0, // No longer tracking user sessions
        systemInfo: {
          model: system.model,
          serial: system.serial,
          ratings: system.ratings,
          solarSize: system.solarSize,
          batterySize: system.batterySize,
        },
        polling: {
          isActive: pollStatus?.isActive || false,
          isAuthenticated: true, // Always true if we have data
          lastPollTime: pollStatus?.lastPollTime ? formatToAEST(pollStatus.lastPollTime) : null,
          lastError: pollStatus?.lastError || null,
        },
        data: reading ? {
          solarPower: reading.solarW,
          loadPower: reading.loadW,
          batteryPower: reading.batteryW,
          batterySOC: reading.batterySOC,
          gridPower: reading.gridW,
          timestamp: formatToAEST(reading.inverterTime),
        } : null,
      });
    }
    
    return NextResponse.json({
      success: true,
      systems: systemsData,
      totalSystems: systemsData.length,
      activeSessions: 0, // No longer tracking sessions
      timestamp: formatToAEST(new Date()),
    });
    
  } catch (error) {
    console.error('Admin API Error:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
    }, { status: 500 });
  }
}