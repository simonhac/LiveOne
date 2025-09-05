import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { SystemsManager } from '@/lib/systems-manager';
import { updateAggregatedData } from '@/lib/aggregation-helper';
import { formatSystemId } from '@/lib/system-utils';
import { pollSelectronicSystem } from '@/lib/selectronic/polling';
import { pollEnphaseSystem } from '@/lib/enphase/enphase-polling';
import type { CommonPollingData } from '@/lib/types/common';
import { 
  getPollingStatus, 
  updatePollingStatusSuccess, 
  updatePollingStatusError,
  validateSystemForPolling,
  type PollingResult 
} from '@/lib/polling-utils';
import { parseDate } from '@internationalized/date';
import { isUserAdmin } from '@/lib/auth-utils';

// Verify the request is from Vercel Cron or an admin user
async function validateCronRequest(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get('authorization');
  
  // In production, check for either CRON_SECRET or admin user
  if (process.env.CRON_SECRET) {
    // First check if it's a valid cron request
    if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
      return true;
    }
    
    // Otherwise check if it's an admin user
    const isAdmin = await isUserAdmin();
    if (isAdmin) {
      console.log('[Cron] Admin user authorized to run cron job');
      return true;
    }
    
    return false;
  }
  
  // In development, allow all requests
  return process.env.NODE_ENV === 'development';
}

export async function GET(request: NextRequest) {
  try {
    // Validate cron request or admin user
    if (!(await validateCronRequest(request))) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // In development, allow testing specific systems with force flag
    const searchParams = request.nextUrl.searchParams;
    const testSystemId = searchParams.get('systemId');
    const forceTest = searchParams.get('force') === 'true';
    const testDate = searchParams.get('date'); // YYYY-MM-DD format
    const isDev = process.env.NODE_ENV === 'development';

    if (testSystemId && forceTest) {
      console.log(`[Cron] Testing system ${testSystemId} with force=true${testDate ? ` for date ${testDate}` : ''}`);
    }

    console.log('[Cron] Starting system polling...');
    
    // NOTE: This runs every minute for Selectronic systems
    // Enphase systems are only polled at :00 and :30 during daylight hours
    // due to API rate limits (1000 calls/month)
    
    // Create SystemsManager for this request
    const systemsManager = new SystemsManager();
    
    // Get systems to poll
    let activeSystems;
    if (testSystemId) {
      // With systemId parameter, get just that system
      const system = await systemsManager.getSystem(parseInt(testSystemId));
      activeSystems = system ? [system] : [];
      console.log(`[Cron] Testing single system: ${testSystemId}`);
    } else {
      // Normal operation - get only active systems
      activeSystems = await systemsManager.getActiveSystems();
    }
    
    if (activeSystems.length === 0) {
      console.log('[Cron] No active systems to poll');
      return NextResponse.json({ 
        success: true, 
        message: 'No systems to poll',
        count: 0 
      });
    }

    const results: PollingResult[] = [];
    
    // Parse date string to CalendarDate if provided
    let parsedTestDate;
    if (testDate) {
      try {
        parsedTestDate = parseDate(testDate); // Parse YYYY-MM-DD string
      } catch (error) {
        console.error(`[Cron] Invalid date format: ${testDate}. Use YYYY-MM-DD`);
      }
    }
    
    // Poll each system
    for (const system of activeSystems) {
      // Handle Enphase systems with their own polling logic
      if (system.vendorType === 'enphase') {
        const result = await pollEnphaseSystem(system, {
          force: forceTest,
          date: parsedTestDate
        });
        results.push(result);
        continue;
      }
      
      try {
        // Validate system has owner
        if (!system.ownerClerkUserId) {
          results.push({
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            status: 'error',
            error: 'No owner configured'
          });
          continue;
        }
        
        const systemId = formatSystemId({
          vendorType: system.vendorType,
          vendorSiteId: system.vendorSiteId,
          displayName: system.displayName
        });

        let data: CommonPollingData | null = null;
        
        // Poll based on vendor type
        if (system.vendorType === 'selectronic' || system.vendorType === 'select.live') {
          data = await pollSelectronicSystem({
            id: system.id,
            ownerClerkUserId: system.ownerClerkUserId,
            vendorSiteId: system.vendorSiteId
          });
        } else if (system.vendorType !== 'enphase') {
          console.log(`[Cron] Unknown vendor type: ${system.vendorType}`);
          results.push({
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            status: 'skipped',
            skipReason: `Unknown vendor type: ${system.vendorType}`
          });
          continue;
        }
        
        if (data) {
          // Calculate delay
          const inverterTime = new Date(data.timestamp);
          const receivedTime = new Date();
          const delaySeconds = Math.floor((receivedTime.getTime() - inverterTime.getTime()) / 1000);
          
          // Insert reading into database
          await db.insert(readings).values({
            systemId: system.id, // ourId -> systemId for database
            inverterTime,
            receivedTime,
            delaySeconds,
            solarW: data.solarW,
            solarInverterW: data.solarInverterW,
            shuntW: data.shuntW,
            loadW: data.loadW,
            batteryW: data.batteryW,
            gridW: data.gridW,
            batterySOC: Math.round(data.batterySOC * 10) / 10, // Round to 1 decimal place
            faultCode: data.faultCode,
            faultTimestamp: data.faultTimestamp,
            generatorStatus: data.generatorStatus,
            // Energy counters (kWh) - lifetime totals only, rounded to 3 decimal places
            solarKwhTotal: Math.round(data.solarKwhTotal * 1000) / 1000,
            loadKwhTotal: Math.round(data.loadKwhTotal * 1000) / 1000,
            batteryInKwhTotal: Math.round(data.batteryInKwhTotal * 1000) / 1000,
            batteryOutKwhTotal: Math.round(data.batteryOutKwhTotal * 1000) / 1000,
            gridInKwhTotal: Math.round(data.gridInKwhTotal * 1000) / 1000,
            gridOutKwhTotal: Math.round(data.gridOutKwhTotal * 1000) / 1000,
          });
          
          // Update 5-minute aggregated data
          await updateAggregatedData(system.id, inverterTime);
          
          // Update polling status with full response for Selectronic (they want detailed data)
          await updatePollingStatusSuccess(system.id, data as any);
          
          results.push({
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            status: 'polled',
            recordsUpserted: 1,
            durationMs: delaySeconds * 1000,
            data: {
              timestamp: inverterTime.toISOString(),
              delaySeconds,
              solarW: data.solarW,
              loadW: data.loadW,
              batteryW: data.batteryW,
              gridW: data.gridW,
              batterySOC: Math.round(data.batterySOC * 10) / 10
            }
          });
          
          console.log(`[Cron] ${systemId} - Success (${delaySeconds}s delay)`);
        }
      } catch (error) {
        console.error(`[Cron] Error polling ${system.id}:`, error);
        
        // Update polling status with error
        await updatePollingStatusError(system.id, error instanceof Error ? error : 'Unknown error');
        
        results.push({
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
    
    const successCount = results.filter(r => r.status === 'polled').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const failureCount = results.filter(r => r.status === 'error').length;
    
    console.log(`[Cron] Polling complete. Success: ${successCount}, Failed: ${failureCount}, Skipped: ${skippedCount}`);
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        total: results.length,
        successful: successCount,
        failed: failureCount,
        skipped: skippedCount
      },
      results
    });
    
  } catch (error) {
    console.error('[Cron] Fatal error:', error);
    return NextResponse.json(
      { 
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}