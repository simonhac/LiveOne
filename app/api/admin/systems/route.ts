import { NextRequest, NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { db } from '@/lib/db';
import { systems, readings, pollingStatus, userSystems } from '@/lib/db/schema';
import { eq, desc, or } from 'drizzle-orm';
import { formatTimeAEST, fromUnixTimestamp } from '@/lib/date-utils';
import { isUserAdmin } from '@/lib/auth-utils';
import { fromDate } from '@internationalized/date';
import { VendorRegistry } from '@/lib/vendors/registry';

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

    // Get unique owner user IDs to fetch user info in batch
    const ownerUserIds = [...new Set(allSystems.map(s => s.ownerClerkUserId).filter((id): id is string => Boolean(id)))];
    const userCache = new Map();

    // Batch fetch user information from Clerk
    const clerk = await clerkClient();
    for (const userId of ownerUserIds) {
      try {
        const user = await clerk.users.getUser(userId);
        userCache.set(userId, {
          email: user.emailAddresses[0]?.emailAddress || null,
          userName: user.username || null,
          firstName: user.firstName || null,
          lastName: user.lastName || null
        });
      } catch (error) {
        console.warn(`Failed to fetch user ${userId}:`, error);
        userCache.set(userId, { email: null, userName: null, firstName: null, lastName: null });
      }
    }
    
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

      // Get user info from cache
      const userInfo = userCache.get(system.ownerClerkUserId);

      systemsData.push({
        systemId: system.id,  // Our internal ID
        owner: {
          clerkId: system.ownerClerkUserId || '',
          email: userInfo?.email || null,
          userName: userInfo?.userName || null,
          firstName: userInfo?.firstName || null,
          lastName: userInfo?.lastName || null
        },
        displayName: system.displayName,  // Non-null from database
        vendor: {
          type: system.vendorType,
          siteId: system.vendorSiteId,  // Vendor's identifier
          userId: null,  // Don't fetch credentials to reduce API calls
          supportsPolling: VendorRegistry.supportsPolling(system.vendorType),
          dataStore: VendorRegistry.getDataStore(system.vendorType),
        },
        location: system.location,  // Location data (address, city/state/country, or lat/lon)
        status: system.status,  // System status: active, disabled, or removed
        systemInfo: {
          model: system.model,
          serial: system.serial,
          ratings: system.ratings,
          solarSize: system.solarSize,
          batterySize: system.batterySize,
        },
        polling: {
          isActive: system.status === 'active',
          lastPollTime: pollStatus?.lastPollTime ? 
            formatTimeAEST(fromDate(pollStatus.lastPollTime, 'Australia/Brisbane')) : null,
          lastSuccessTime: pollStatus?.lastSuccessTime ?
            formatTimeAEST(fromDate(pollStatus.lastSuccessTime, 'Australia/Brisbane')) : null,
          lastErrorTime: pollStatus?.lastErrorTime ?
            formatTimeAEST(fromDate(pollStatus.lastErrorTime, 'Australia/Brisbane')) : null,
          lastError: pollStatus?.lastError || null,
          lastResponse: pollStatus?.lastResponse || null,
          consecutiveErrors: pollStatus?.consecutiveErrors || 0,
          totalPolls: pollStatus?.totalPolls || 0,
          successfulPolls: pollStatus?.successfulPolls || 0,
          failedPolls: pollStatus?.totalPolls ? (pollStatus.totalPolls - pollStatus.successfulPolls) : 0,
          successRate: pollStatus?.totalPolls ? 
            Math.round((pollStatus.successfulPolls / pollStatus.totalPolls) * 100) : 0,
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