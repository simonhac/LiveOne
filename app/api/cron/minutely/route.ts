import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systems, readings, pollingStatus } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { updateAggregatedData } from '@/lib/aggregation-helper';
import { formatSystemId } from '@/lib/system-utils';
import { pollSelectronicSystem } from '@/lib/selectronic/polling';
import { pollEnphaseSystem, shouldPollEnphase } from '@/lib/enphase/polling';
import type { PollingData } from '@/lib/types/enphase';

// Verify the request is from Vercel Cron
function validateCronRequest(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  
  // In production, Vercel sets CRON_SECRET
  if (process.env.CRON_SECRET) {
    return authHeader === `Bearer ${process.env.CRON_SECRET}`;
  }
  
  // In development, allow all requests
  return process.env.NODE_ENV === 'development';
}

export async function GET(request: NextRequest) {
  try {
    // Validate cron request
    if (!validateCronRequest(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    console.log('[Cron] Starting system polling...');
    
    // NOTE: This runs every minute for Selectronic systems
    // Enphase systems are only polled at :00 and :30 during daylight hours
    // due to API rate limits (1000 calls/month)
    
    // Get all active systems from database (exclude disabled and removed)
    const activeSystems = await db.select()
      .from(systems)
      .where(eq(systems.status, 'active'));
    
    if (activeSystems.length === 0) {
      console.log('[Cron] No active systems to poll');
      return NextResponse.json({ 
        success: true, 
        message: 'No systems to poll',
        count: 0 
      });
    }

    const results = [];
    
    // Poll each system
    for (const system of activeSystems) {
      try {
        const systemId = formatSystemId({
          vendorType: system.vendorType,
          vendorSiteId: system.vendorSiteId,
          displayName: system.displayName
        });
        
        if (!system.ownerClerkUserId) {
          console.error(`[Cron] ${systemId} has no ownerClerkUserId`);
          throw new Error('System has no owner Clerk user ID');
        }

        let data: PollingData | null = null;
        
        // Poll based on vendor type
        if (system.vendorType === 'enphase') {
          // Check if we should poll Enphase (daylight hours only)
          if (!shouldPollEnphase({
            id: system.id,
            ownerClerkUserId: system.ownerClerkUserId,
            vendorSiteId: system.vendorSiteId,
            timezoneOffsetMin: system.timezoneOffsetMin
          })) {
            console.log(`[Cron] Skipping Enphase system ${systemId} - outside polling window`);
            continue;
          }
          
          data = await pollEnphaseSystem({
            id: system.id,
            ownerClerkUserId: system.ownerClerkUserId,
            vendorSiteId: system.vendorSiteId,
            timezoneOffsetMin: system.timezoneOffsetMin
          });
        } else {
          // Default to Selectronic polling
          data = await pollSelectronicSystem({
            id: system.id,
            ownerClerkUserId: system.ownerClerkUserId,
            vendorSiteId: system.vendorSiteId
          });
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
            system: system.vendorSiteId,
            success: true,
            solar: data.solarW,
            battery: data.batterySOC,
            delay: delaySeconds
          });
          
          console.log(`[Cron] ${system.id} - Success (${delaySeconds}s delay)`);
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
          system: system.vendorSiteId,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
    
    console.log(`[Cron] Polling complete. ${results.filter(r => r.success).length}/${results.length} successful`);
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: results.length,
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