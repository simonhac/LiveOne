import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systems, readings, pollingStatus } from '@/lib/db/schema';
import { SelectronicFetchClient } from '@/lib/selectronic-fetch-client';
import { SELECTLIVE_CONFIG, USER_TO_SYSTEM } from '@/config';
import { eq, sql } from 'drizzle-orm';

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
        console.log(`[Cron] Polling system ${system.systemNumber}...`);
        
        // Get credentials for this system
        const credentials = USER_TO_SYSTEM[system.userId as keyof typeof USER_TO_SYSTEM] || SELECTLIVE_CONFIG;
        
        // Create client for this system
        const client = new SelectronicFetchClient({
          email: credentials.username,
          password: credentials.password,
          systemNumber: system.systemNumber
        });
        
        // Authenticate if needed
        const authCookie = await getOrRefreshAuth(system.systemNumber, client);
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
            systemId: system.id,
            inverterTime,
            receivedTime,
            delaySeconds,
            solarPower: data.solarPower,
            solarInverterPower: data.solarInverterPower,
            shuntPower: data.shuntPower,
            loadPower: data.loadPower,
            batteryPower: data.batteryPower,
            gridPower: data.gridPower,
            batterySOC: data.batterySOC,
            faultCode: data.faultCode,
            faultTimestamp: data.faultTimestamp,
            generatorStatus: data.generatorStatus,
            solarKwhTotal: data.solarKwhTotal,
            loadKwhTotal: data.loadKwhTotal,
            batteryInKwhTotal: data.batteryInKwhTotal,
            batteryOutKwhTotal: data.batteryOutKwhTotal,
            gridInKwhTotal: data.gridInKwhTotal,
            gridOutKwhTotal: data.gridOutKwhTotal,
          });
          
          // Update polling status
          await db.update(pollingStatus)
            .set({
              lastPollTime: receivedTime,
              lastSuccessTime: receivedTime,
              isActive: true,
              lastError: null,
              consecutiveErrors: 0,
            })
            .where(eq(pollingStatus.systemId, system.id));
          
          results.push({
            system: system.systemNumber,
            success: true,
            solar: data.solarPower,
            battery: data.batterySOC,
            delay: delaySeconds
          });
          
          console.log(`[Cron] System ${system.systemNumber} - Success (${delaySeconds}s delay)`);
        }
      } catch (error) {
        console.error(`[Cron] Error polling system ${system.systemNumber}:`, error);
        
        // Update polling status with error
        await db.update(pollingStatus)
          .set({
            lastPollTime: new Date(),
            lastErrorTime: new Date(),
            isActive: true,
            lastError: error instanceof Error ? error.message : 'Unknown error',
            consecutiveErrors: sql`${pollingStatus.consecutiveErrors} + 1`,
          })
          .where(eq(pollingStatus.systemId, system.id));
        
        results.push({
          system: system.systemNumber,
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
async function getOrRefreshAuth(systemNumber: string, client: SelectronicFetchClient): Promise<string | null> {
  try {
    // Try to get existing session from database
    // For now, just authenticate fresh each time
    // TODO: Store session cookies in database for reuse
    
    const authenticated = await client.authenticate();
    return authenticated ? 'authenticated' : null;
  } catch (error) {
    console.error(`[Cron] Auth failed for system ${systemNumber}:`, error);
    return null;
  }
}