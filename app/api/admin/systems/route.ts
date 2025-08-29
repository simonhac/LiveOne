import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/lib/db';
import { systems, readings, pollingStatus, userSystems } from '@/lib/db/schema';
import { eq, desc, or } from 'drizzle-orm';
import { formatTimeAEST, fromUnixTimestamp } from '@/lib/date-utils';
import { isUserAdmin } from '@/lib/auth-utils';
import { fromDate } from '@internationalized/date';

export async function GET(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Check if user is admin
    const isAdmin = await isUserAdmin();
    
    if (!isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
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
        ownerClerkUserId: system.ownerClerkUserId || '',
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
          isAuthenticated: pollStatus?.lastSuccessTime ? 
            ((Date.now() - new Date(pollStatus.lastSuccessTime).getTime()) / 1000 / 60) < 5 : false,
          lastPollTime: pollStatus?.lastPollTime ? 
            formatTimeAEST(fromDate(pollStatus.lastPollTime, 'Australia/Brisbane')) : null,
          lastError: pollStatus?.lastError || null,
        },
        data: reading ? {
          solarPower: reading.solarW,
          loadPower: reading.loadW,
          batteryPower: reading.batteryW,
          batterySOC: reading.batterySOC,
          gridPower: reading.gridW,
          timestamp: formatTimeAEST(fromDate(reading.inverterTime, 'Australia/Brisbane')),
        } : null,
      });
    }
    
    return NextResponse.json({
      success: true,
      systems: systemsData,
      totalSystems: systemsData.length,
      activeSessions: 0, // No longer tracking sessions
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('Error fetching systems data:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch systems data',
    }, { status: 500 });
  }
}