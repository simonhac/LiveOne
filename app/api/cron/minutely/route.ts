import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { pointGroups } from '@/lib/db/schema-monitoring-points';
import { SystemsManager } from '@/lib/systems-manager';
import { updateAggregatedData } from '@/lib/aggregation-helper';
import { formatSystemId } from '@/lib/system-utils';
import { VendorRegistry } from '@/lib/vendors/registry';
import { getCredentialsForVendor } from '@/lib/vendors/credentials';
import type { SystemForVendor } from '@/lib/vendors/types';
import type { CommonPollingData } from '@/lib/types/common';
import {
  updatePollingStatusSuccess,
  updatePollingStatusError,
  type PollingResult as PollingStatusResult
} from '@/lib/polling-utils';
import { isUserAdmin } from '@/lib/auth-utils';
import { eq, and } from 'drizzle-orm';

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

    const results: PollingStatusResult[] = [];
    
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
          error: `Unknown vendor type: ${system.vendorType}`
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
          error: 'No owner configured'
        });
        continue;
      }
      
      // Get credentials for this vendor/owner, with optional site-specific matching
      const credentials = await getCredentialsForVendor(
        system.vendorType,
        system.ownerClerkUserId,
        system.id.toString()  // Use system ID as liveoneSiteId for site-specific credentials
      );
      
      if (!credentials && adapter.vendorType !== 'craighack' && adapter.vendorType !== 'fronius') {
        console.error(`[Cron] No credentials found for ${system.vendorType} system ${system.id}`);
        results.push({
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          status: 'error',
          error: 'No credentials found'
        });
        continue;
      }
      
      try {
        // Convert system to SystemForVendor type
        const systemForVendor: SystemForVendor = {
          id: system.id,
          vendorType: system.vendorType,
          vendorSiteId: system.vendorSiteId,
          ownerClerkUserId: system.ownerClerkUserId,
          displayName: system.displayName,
          timezoneOffsetMin: system.timezoneOffsetMin,
          isActive: system.isActive,
          model: system.model,
          serial: system.serial,
          ratings: system.ratings,
          solarSize: system.solarSize,
          batterySize: system.batterySize
        };
        
        // Let the adapter handle the polling logic
        const result = await adapter.poll(systemForVendor, credentials);
        
        // Process the result
        switch (result.action) {
          case 'POLLED':
            // Store the data if provided
            if (result.data) {
              const dataArray = Array.isArray(result.data) ? result.data : [result.data];
              
              for (const data of dataArray) {
                // Calculate delay
                const inverterTime = new Date(data.timestamp);
                const receivedTime = new Date();
                const delaySeconds = Math.floor((receivedTime.getTime() - inverterTime.getTime()) / 1000);
                
                // Insert reading into database
                await db.insert(readings).values({
                  systemId: system.id,
                  inverterTime,
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
                  faultTimestamp: data.faultTimestamp ?? null,
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
            
            results.push({
              systemId: system.id,
              displayName: system.displayName || undefined,
              vendorType: system.vendorType,
              status: 'polled',
              recordsUpserted: result.recordsProcessed
            });
            
            console.log(`[Cron] ${formatSystemId(system)} - Success (${result.recordsProcessed} records)`);
            break;
            
          case 'SKIPPED':
            results.push({
              systemId: system.id,
              displayName: system.displayName || undefined,
              vendorType: system.vendorType,
              status: 'skipped',
              skipReason: result.reason
            });
            console.log(`[Cron] ${formatSystemId(system)} - Skipped: ${result.reason}`);
            break;
            
          case 'ERROR':
            // Update error status
            await updatePollingStatusError(system.id, result.error || 'Unknown error');
            
            results.push({
              systemId: system.id,
              displayName: system.displayName || undefined,
              vendorType: system.vendorType,
              status: 'error',
              error: result.error
            });
            console.error(`[Cron] ${formatSystemId(system)} - Error: ${result.error}`);
            break;
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
    
    // Poll monitoring point groups (Mondo Power and future UBI devices)
    console.log('[Cron] Polling monitoring point groups...');

    const activePointGroups = await db.select()
      .from(pointGroups)
      .where(eq(pointGroups.pollingEnabled, true));

    for (const pointGroup of activePointGroups) {
      try {
        const adapter = VendorRegistry.getAdapter(pointGroup.vendorType);

        if (!adapter) {
          console.error(`[Cron] Unknown vendor type for point group: ${pointGroup.vendorType}`);
          continue;
        }

        if (adapter.dataSource === 'push') {
          console.log(`[Cron] Skipping push-only point group: ${pointGroup.name}`);
          continue;
        }

        // Get credentials for the owner, with optional site-specific matching
        const credentials = await getCredentialsForVendor(
          pointGroup.vendorType,
          pointGroup.ownerClerkUserId || '',
          pointGroup.id.toString()  // Use point group ID (same as system ID) as liveoneSiteId
        );

        if (!credentials) {
          console.error(`[Cron] No credentials for point group ${pointGroup.name} (${pointGroup.vendorType})`);
          continue;
        }

        // Create a pseudo-system for the adapter
        const systemForVendor: SystemForVendor = {
          id: -pointGroup.id, // Negative ID to distinguish from regular systems
          vendorType: pointGroup.vendorType,
          vendorSiteId: pointGroup.vendorId,
          ownerClerkUserId: pointGroup.ownerClerkUserId || '',
          displayName: pointGroup.displayName || pointGroup.name,
          timezoneOffsetMin: pointGroup.timezoneOffsetMin,
          isActive: true
        };

        // Poll the point group
        const result = await adapter.poll(systemForVendor, credentials);

        // Log result
        if (result.action === 'POLLED') {
          console.log(`[Cron] Point group ${pointGroup.name} - Success (${result.recordsProcessed} records)`);
          results.push({
            systemId: -pointGroup.id,
            displayName: pointGroup.displayName || pointGroup.name,
            vendorType: pointGroup.vendorType,
            status: 'polled',
            recordsUpserted: result.recordsProcessed
          });
        } else if (result.action === 'ERROR') {
          console.error(`[Cron] Point group ${pointGroup.name} - Error: ${result.error}`);
          results.push({
            systemId: -pointGroup.id,
            displayName: pointGroup.displayName || pointGroup.name,
            vendorType: pointGroup.vendorType,
            status: 'error',
            error: result.error
          });
        }
      } catch (error) {
        console.error(`[Cron] Error polling point group ${pointGroup.name}:`, error);
        results.push({
          systemId: -pointGroup.id,
          displayName: pointGroup.displayName || pointGroup.name,
          vendorType: pointGroup.vendorType,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    const successCount = results.filter(r => r.status === 'polled').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const failureCount = results.filter(r => r.status === 'error').length;

    console.log(`[Cron] Polling complete. success: ${successCount}, failed: ${failureCount}, skipped: ${skippedCount}`, results);

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