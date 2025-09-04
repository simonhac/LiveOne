import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systems, readings, pollingStatus } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { updateAggregatedData } from '@/lib/aggregation-helper';
import { formatSystemId } from '@/lib/system-utils';
import { pollSelectronicSystem } from '@/lib/selectronic/polling';
import { pollEnphaseSystems } from '@/lib/enphase/enphase-cron';
import type { CommonPollingData } from '@/lib/types/common';
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

    if (isDev && testSystemId && forceTest) {
      console.log(`[Cron] Development mode - Testing system ${testSystemId} with force=true${testDate ? ` for date ${testDate}` : ''}`);
    }

    console.log('[Cron] Starting system polling...');
    
    // NOTE: This runs every minute for Selectronic systems
    // Enphase systems are only polled at :00 and :30 during daylight hours
    // due to API rate limits (1000 calls/month)
    
    // Get all active systems from database (exclude disabled and removed)
    let activeSystems;
    if (isDev && testSystemId) {
      // In dev with systemId, get just that system
      activeSystems = await db.select()
        .from(systems)
        .where(eq(systems.id, parseInt(testSystemId)));
      console.log(`[Cron] Testing single system: ${testSystemId}`);
    } else {
      // Normal operation - get all active systems
      activeSystems = await db.select()
        .from(systems)
        .where(eq(systems.status, 'active'));
    }
    
    if (activeSystems.length === 0) {
      console.log('[Cron] No active systems to poll');
      return NextResponse.json({ 
        success: true, 
        message: 'No systems to poll',
        count: 0 
      });
    }

    const results = [];
    let enphaseResult = null;
    
    // Handle Enphase systems with smart polling schedule
    // Always check Enphase systems - the polling function will decide per-system whether to poll
    console.log('[Cron] Checking Enphase systems for polling');
    // Parse date string to CalendarDate if provided
    let parsedTestDate;
    if (isDev && testDate) {
      try {
        parsedTestDate = parseDate(testDate); // Parse YYYY-MM-DD string
      } catch (error) {
        console.error(`[Cron] Invalid date format: ${testDate}. Use YYYY-MM-DD`);
      }
    }
    
    enphaseResult = await pollEnphaseSystems(
      isDev && testSystemId ? parseInt(testSystemId) : undefined,
      isDev && forceTest,
      parsedTestDate
    );
    
    // Poll each non-Enphase system
    for (const system of activeSystems) {
      // Skip Enphase systems as they're handled separately
      if (system.vendorType === 'enphase') {
        continue;
      }
      
      try {
        const systemId = formatSystemId({
          vendorType: system.vendorType,
          vendorSiteId: system.vendorSiteId,
          displayName: system.displayName
        });
        
        if (!system.ownerClerkUserId) {
          console.error(`[Cron] ${systemId} has no ownerClerkUserId`);
          results.push({
            systemId: system.id,
            displayName: system.displayName,
            vendorType: system.vendorType,
            vendorSiteId: system.vendorSiteId,
            success: false,
            error: 'No owner configured',
            skipped: false
          });
          continue;
        }

        let data: CommonPollingData | null = null;
        
        // Poll based on vendor type
        if (system.vendorType === 'selectronic' || system.vendorType === 'select.live') {
          data = await pollSelectronicSystem({
            id: system.id,
            ownerClerkUserId: system.ownerClerkUserId,
            vendorSiteId: system.vendorSiteId
          });
        } else {
          console.log(`[Cron] Unknown vendor type: ${system.vendorType}`);
          results.push({
            systemId: system.id,
            displayName: system.displayName,
            vendorType: system.vendorType,
            vendorSiteId: system.vendorSiteId,
            success: false,
            error: `Unknown vendor type: ${system.vendorType}`,
            skipped: true
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
          
          // Upsert polling status with full response
          await db.insert(pollingStatus)
            .values({
              systemId: system.id, // ourId -> systemId for database
              lastPollTime: receivedTime,
              lastSuccessTime: receivedTime,
              lastError: null,
              lastResponse: data as any, // Store the full Select.Live response
              consecutiveErrors: 0,
              totalPolls: 1,
              successfulPolls: 1,
            })
            .onConflictDoUpdate({
              target: pollingStatus.systemId,
              set: {
                lastPollTime: receivedTime,
                lastSuccessTime: receivedTime,
                lastError: null,
                lastResponse: data as any,
                consecutiveErrors: 0,
                totalPolls: sql`${pollingStatus.totalPolls} + 1`,
                successfulPolls: sql`${pollingStatus.successfulPolls} + 1`,
              },
            });
          
          results.push({
            systemId: system.id,
            displayName: system.displayName,
            vendorType: system.vendorType,
            vendorSiteId: system.vendorSiteId,
            success: true,
            skipped: false,
            timestamp: inverterTime.toISOString(),
            delaySeconds,
            data: {
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
        
        // Upsert polling status with error
        await db.insert(pollingStatus)
          .values({
            systemId: system.id, // ourId -> systemId for database
            lastPollTime: new Date(),
            lastErrorTime: new Date(),
            lastError: error instanceof Error ? error.message : 'Unknown error',
            consecutiveErrors: 1,
            totalPolls: 1,
            successfulPolls: 0,
          })
          .onConflictDoUpdate({
            target: pollingStatus.systemId,
            set: {
              lastPollTime: new Date(),
              lastErrorTime: new Date(),
              lastError: error instanceof Error ? error.message : 'Unknown error',
              consecutiveErrors: sql`${pollingStatus.consecutiveErrors} + 1`,
              totalPolls: sql`${pollingStatus.totalPolls} + 1`,
            },
          });
        
        results.push({
          systemId: system.id,
          displayName: system.displayName,
          vendorType: system.vendorType,
          vendorSiteId: system.vendorSiteId,
          success: false,
          skipped: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
    
    const successCount = results.filter(r => r.success && !r.skipped).length;
    const skippedCount = results.filter(r => r.skipped).length;
    const failureCount = results.filter(r => !r.success && !r.skipped).length;
    
    // Add Enphase results to summary
    const totalEnphase = enphaseResult ? (enphaseResult.polled + enphaseResult.skipped + enphaseResult.errors) : 0;
    const totalSuccessful = successCount + (enphaseResult?.polled || 0);
    const totalSkipped = skippedCount + (enphaseResult?.skipped || 0);
    const totalFailed = failureCount + (enphaseResult?.errors || 0);
    
    console.log(`[Cron] Polling complete. Success: ${totalSuccessful}, Failed: ${totalFailed}, Skipped: ${totalSkipped}`);
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        total: results.length + totalEnphase,
        successful: totalSuccessful,
        failed: totalFailed,
        skipped: totalSkipped,
        enphase: enphaseResult
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