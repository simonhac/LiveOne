import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systems, readings, pollingStatus } from '@/lib/db/schema';
import { SelectronicFetchClient } from '@/lib/selectronic-fetch-client';
import { SELECTLIVE_CONFIG } from '@/config';
import { eq, sql } from 'drizzle-orm';
import { updateAggregatedData } from '@/lib/aggregation-helper';
import { getSelectLiveCredentials } from '@/lib/secure-credentials';
import { formatSystemId } from '@/lib/system-utils';

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
    
    // Get all active systems from database
    const activeSystems = await db.select().from(systems);
    
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
        console.log(`[Cron] Polling ${systemId}...`);
        
        // Get the owner's Select.Live credentials from Clerk
        if (!system.ownerClerkUserId) {
          console.error(`[Cron] ${systemId} has no ownerClerkUserId`);
          throw new Error('System has no owner Clerk user ID');
        }
        
        const credentials = await getSelectLiveCredentials(system.ownerClerkUserId);
        
        if (!credentials) {
          console.error(`[Cron] No credentials found for ${systemId}`);
          throw new Error('No credentials found');
        }
        
        console.log(`[Cron] Using credentials for ${systemId}`);
        
        // Create client for this system
        const client = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: system.vendorSiteId
        });
        
        // Authenticate if needed
        const authCookie = await getOrRefreshAuth(system.vendorSiteId, client);
        if (!authCookie) {
          throw new Error('Authentication failed');
        }
        
        // Fetch data
        const response = await client.fetchData();
        
        if (response && response.success && response.data) {
          const data = response.data;
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
              isActive: true,
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
                isActive: true,
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
            isActive: true,
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
              isActive: true,
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

// Helper function to get or refresh authentication
async function getOrRefreshAuth(vendorSiteId: string, client: SelectronicFetchClient): Promise<string | null> {
  try {
    // Try to get existing session from database
    // For now, just authenticate fresh each time
    // TODO: Store session cookies in database for reuse
    
    const authenticated = await client.authenticate();
    return authenticated ? 'authenticated' : null;
  } catch (error) {
    console.error(`[Cron] Auth failed for system ${vendorSiteId}:`, error);
    return null;
  }
}