import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { SystemsManager } from '@/lib/systems-manager';
import { updateAggregatedData } from '@/lib/aggregation-helper';
import { formatSystemId } from '@/lib/system-utils';
import { VendorRegistry } from '@/lib/vendors/registry';
import { getSystemCredentials } from '@/lib/secure-credentials';
import { sessionManager } from '@/lib/session-manager';
import type { CommonPollingData } from '@/lib/types/common';
import {
  updatePollingStatusSuccess,
  updatePollingStatusError,
  type PollingResult
} from '@/lib/polling-utils';
import { isUserAdmin } from '@/lib/auth-utils';
import { and } from 'drizzle-orm';
import { fromDate } from '@internationalized/date';
import { formatTimeAEST } from '@/lib/date-utils';

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
  const apiStartTime = Date.now(); // Track API call start time

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
    const includeRaw = searchParams.get('includeRaw') === 'true';

    if (testSystemId && forceTest) {
      console.log(`[Cron] Testing system ${testSystemId} with force=true`);
    }

    console.log('[Cron] Starting system polling...');
    
    // Get cached SystemsManager for this request
    const systemsManager = SystemsManager.getInstance();
    
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
    
    // Poll each system using the new vendor adapter architecture
    for (const system of activeSystems) {
      // Get the vendor adapter first to check if it supports polling
      const adapter = VendorRegistry.getAdapter(system.vendorType);
      
      if (!adapter) {
        console.error(`[Cron] Unknown vendor type: ${system.vendorType}`);
        results.push({
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          status: 'error',
          error: `Unknown vendor type: ${system.vendorType}`,
          lastPoll: system.pollingStatus?.lastPollTime ? formatTimeAEST(fromDate(system.pollingStatus.lastPollTime, 'Australia/Brisbane')) : null,
          nextPoll: undefined
        });
        continue;
      }
      
      // Skip push-only systems (they don't need polling)
      if (adapter.dataSource === 'push') {
        continue;  // Don't add to results at all, don't log
      }
      
      console.log(`[Cron] Processing systemId=${system.id} (${system.vendorType}/${system.vendorSiteId} '${system.displayName}')`);
      
      
      // Check if system has an owner
      if (!system.ownerClerkUserId) {
        results.push({
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          status: 'error',
          error: 'No owner configured',
          lastPoll: system.pollingStatus?.lastPollTime ? formatTimeAEST(fromDate(system.pollingStatus.lastPollTime, 'Australia/Brisbane')) : null,
          nextPoll: undefined
        });
        continue;
      }
      
      // Get credentials for this system
      const credentials = await getSystemCredentials(
        system.ownerClerkUserId,
        system.id
      );

      if (!credentials && adapter.vendorType !== 'craighack' && adapter.vendorType !== 'fronius') {
        console.error(`[Cron] No credentials found for ${system.vendorType} system ${system.id}`);
        results.push({
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          status: 'error',
          error: 'No credentials found',
          lastPoll: system.pollingStatus?.lastPollTime ? formatTimeAEST(fromDate(system.pollingStatus.lastPollTime, 'Australia/Brisbane')) : null,
          nextPoll: undefined
        });
        continue;
      }
      
      try {
        // Start timing for session recording
        const sessionStart = new Date();

        // Let the adapter handle the polling logic
        const now = new Date();
        const result = await adapter.poll(system, credentials, forceTest, now);

        // Calculate duration
        const duration = Date.now() - sessionStart.getTime();
        
        // Process the result
        switch (result.action) {
          case 'POLLED':
            // Store the data if provided
            if (result.data) {
              const dataArray = Array.isArray(result.data) ? result.data : [result.data];

              for (const data of dataArray) {
                // Calculate delay (timestamp should be a Date object from adapters)
                const inverterTime = data.timestamp;
                const receivedTime = new Date();
                const delaySeconds = Math.floor((receivedTime.getTime() - inverterTime.getTime()) / 1000);

                // Insert reading into database (Drizzle handles Date -> Unix conversion)
                await db.insert(readings).values({
                  systemId: system.id,
                  inverterTime, // Pass Date directly - Drizzle converts to Unix timestamp
                  receivedTime,
                  delaySeconds,
                  solarW: data.solarW ?? null,  // Preserve null, don't convert to 0
                  solarLocalW: data.solarLocalW ?? null,
                  solarRemoteW: data.solarRemoteW ?? null,
                  loadW: data.loadW ?? null,
                  batteryW: data.batteryW ?? null,
                  gridW: data.gridW ?? null,
                  batterySOC: data.batterySOC != null ? Math.round(data.batterySOC * 10) / 10 : null,
                  faultCode: data.faultCode ?? null,
                  faultTimestamp: data.faultTimestamp
                    ? Math.floor(data.faultTimestamp.getTime() / 1000)
                    : null,
                  generatorStatus: data.generatorStatus ?? null,
                  // Energy interval counters (Wh) - integers, preserve nulls
                  solarWhInterval: data.solarWhInterval != null ? Math.round(data.solarWhInterval) : null,
                  loadWhInterval: data.loadWhInterval != null ? Math.round(data.loadWhInterval) : null,
                  batteryInWhInterval: data.batteryInWhInterval != null ? Math.round(data.batteryInWhInterval) : null,
                  batteryOutWhInterval: data.batteryOutWhInterval != null ? Math.round(data.batteryOutWhInterval) : null,
                  gridInWhInterval: data.gridInWhInterval != null ? Math.round(data.gridInWhInterval) : null,
                  gridOutWhInterval: data.gridOutWhInterval != null ? Math.round(data.gridOutWhInterval) : null,
                  // Energy counters (kWh) - rounded to 3 decimal places, preserve nulls
                  solarKwhTotal: data.solarKwhTotal != null ? Math.round(data.solarKwhTotal * 1000) / 1000 : null,
                  loadKwhTotal: data.loadKwhTotal != null ? Math.round(data.loadKwhTotal * 1000) / 1000 : null,
                  batteryInKwhTotal: data.batteryInKwhTotal != null ? Math.round(data.batteryInKwhTotal * 1000) / 1000 : null,
                  batteryOutKwhTotal: data.batteryOutKwhTotal != null ? Math.round(data.batteryOutKwhTotal * 1000) / 1000 : null,
                  gridInKwhTotal: data.gridInKwhTotal != null ? Math.round(data.gridInKwhTotal * 1000) / 1000 : null,
                  gridOutKwhTotal: data.gridOutKwhTotal != null ? Math.round(data.gridOutKwhTotal * 1000) / 1000 : null,
                });

                // Update 5-minute aggregated data
                await updateAggregatedData(system.id, inverterTime);
              }
            }

            // Update polling status with raw response
            await updatePollingStatusSuccess(system.id, result.rawResponse);

            // Record successful session
            await sessionManager.recordSession({
              systemId: system.id,
              vendorType: system.vendorType,
              systemName: system.displayName || `System ${system.id}`,
              cause: 'POLL',
              started: sessionStart,
              duration,
              successful: true,
              response: result.rawResponse,
              numRows: result.recordsProcessed || 0,
            });

            results.push({
              systemId: system.id,
              displayName: system.displayName || undefined,
              vendorType: system.vendorType,
              status: 'polled',
              recordsUpserted: result.recordsProcessed,
              ...(includeRaw && result.rawResponse ? { rawResponse: result.rawResponse } : {}),
              lastPoll: formatTimeAEST(fromDate(now, 'Australia/Brisbane')),
              nextPoll: result.nextPoll ? formatTimeAEST(result.nextPoll) : undefined
            });

            console.log(`[Cron] ${formatSystemId(system)} - Success (${result.recordsProcessed} records)`);
            break;
            
          case 'SKIPPED':
            results.push({
              systemId: system.id,
              displayName: system.displayName || undefined,
              vendorType: system.vendorType,
              status: 'skipped',
              skipReason: result.reason,
              lastPoll: system.pollingStatus?.lastPollTime ? formatTimeAEST(fromDate(system.pollingStatus.lastPollTime, 'Australia/Brisbane')) : null,
              nextPoll: result.nextPoll ? formatTimeAEST(result.nextPoll) : undefined
            });
            console.log(`[Cron] ${formatSystemId(system)} - Skipped: ${result.reason}`);
            break;
            
          case 'ERROR':
            // Update error status
            await updatePollingStatusError(system.id, result.error || 'Unknown error');

            // Record failed session
            await sessionManager.recordSession({
              systemId: system.id,
              vendorType: system.vendorType,
              systemName: system.displayName || `System ${system.id}`,
              cause: 'POLL',
              started: sessionStart,
              duration,
              successful: false,
              errorCode: result.errorCode || null,
              error: result.error || null,
              numRows: 0,
            });

            results.push({
              systemId: system.id,
              displayName: system.displayName || undefined,
              vendorType: system.vendorType,
              status: 'error',
              error: result.error,
              lastPoll: system.pollingStatus?.lastPollTime ? formatTimeAEST(fromDate(system.pollingStatus.lastPollTime, 'Australia/Brisbane')) : null,
              nextPoll: undefined
            });
            console.error(`[Cron] ${formatSystemId(system)} - Error: ${result.error}`);
            break;
        }
        
      } catch (error) {
        console.error(`[Cron] Error polling ${system.id}:`, error);

        // Update polling status with error
        await updatePollingStatusError(system.id, error instanceof Error ? error : 'Unknown error');

        // Record failed session for unexpected errors
        await sessionManager.recordSession({
          systemId: system.id,
          vendorType: system.vendorType,
          systemName: system.displayName || `System ${system.id}`,
          cause: 'POLL',
          started: new Date(), // Use current time as we might not have sessionStart
          duration: 0, // Unknown duration for unexpected errors
          successful: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          numRows: 0,
        });

        results.push({
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          lastPoll: system.pollingStatus?.lastPollTime ? formatTimeAEST(fromDate(system.pollingStatus.lastPollTime, 'Australia/Brisbane')) : null,
          nextPoll: undefined
        });
      }
    }

    const successCount = results.filter(r => r.status === 'polled').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const failureCount = results.filter(r => r.status === 'error').length;

    // Create sanitized results for logging (truncate rawResponse to first 60 chars)
    const resultsForLogging = results.map(r => ({
      ...r,
      rawResponse: r.rawResponse ?
        (JSON.stringify(r.rawResponse).substring(0, 60) + '...') :
        undefined
    }));

    console.log(`[Cron] Polling complete. success: ${successCount}, failed: ${failureCount}, skipped: ${skippedCount}`, resultsForLogging);

    // Calculate total API call duration
    const durationMs = Date.now() - apiStartTime;

    // Format timestamp using AEST
    const nowZoned = fromDate(new Date(), 'Australia/Brisbane');
    const timestamp = formatTimeAEST(nowZoned);

    return NextResponse.json({
      success: true,
      timestamp,
      durationMs,
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

    // Calculate duration even for errors
    const durationMs = Date.now() - apiStartTime;

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs
      },
      { status: 500 }
    );
  }
}