import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readings, systems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { updateAggregatedData } from '@/lib/aggregation-helper';
import { updatePollingStatusSuccess, updatePollingStatusError } from '@/lib/polling-utils';

/**
 * Expected request body for Fronius push data
 * Contains all CommonPollingData fields except totals
 */
interface FroniusPushData {
  // Authentication
  siteId: string;
  apiKey: string;
  
  // Timestamp
  timestamp: string;
  
  // Power readings (Watts) - instantaneous values
  solarW?: number | null;
  solarLocalW?: number | null;   // Local solar from shunt/CT
  solarRemoteW?: number | null;  // Remote solar from inverter
  loadW?: number | null;
  batteryW?: number | null;
  gridW?: number | null;
  
  // Battery state
  batterySOC?: number | null;  // State of charge (0-100%)
  
  // System status
  faultCode?: string | null;
  faultTimestamp?: number | null;  // Unix timestamp of fault
  generatorStatus?: number | null;
  
  // Energy counters (Wh) - interval values (energy in this period)
  solarWhInterval?: number | null;
  loadWhInterval?: number | null;
  batteryInWhInterval?: number | null;
  batteryOutWhInterval?: number | null;
  gridInWhInterval?: number | null;
  gridOutWhInterval?: number | null;
}

function validateApiKey(siteId: string, apiKey: string): boolean {
  // TODO: Implement per-site API key validation
  // For now, accept any non-empty API key
  return Boolean(apiKey && apiKey.length > 0);
}

export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const data: FroniusPushData = await request.json();
    
    // Validate required fields
    if (!data.siteId || !data.apiKey) {
      return NextResponse.json(
        { error: 'Missing siteId or apiKey' },
        { status: 400 }
      );
    }
    
    if (!data.timestamp) {
      return NextResponse.json(
        { error: 'Missing timestamp' },
        { status: 400 }
      );
    }
    
    // Validate API key
    if (!validateApiKey(data.siteId, data.apiKey)) {
      console.error(`[Fronius Push] Invalid API key for site ${data.siteId}`);
      return NextResponse.json(
        { error: 'Invalid API key' },
        { status: 401 }
      );
    }
    
    // Find the system by vendorSiteId
    const [system] = await db.select()
      .from(systems)
      .where(eq(systems.vendorSiteId, data.siteId))
      .limit(1);
    
    if (!system) {
      console.error(`[Fronius Push] System not found for siteId: ${data.siteId}`);
      return NextResponse.json(
        { error: 'System not found' },
        { status: 404 }
      );
    }
    
    // Verify it's a Fronius system
    if (system.vendorType !== 'fronius') {
      console.error(`[Fronius Push] System ${system.id} is not a Fronius system (type: ${system.vendorType})`);
      return NextResponse.json(
        { error: 'System is not configured as Fronius type' },
        { status: 400 }
      );
    }
    
    // Calculate timestamps and delay
    const inverterTime = new Date(data.timestamp);
    const receivedTime = new Date();
    const delaySeconds = Math.floor((receivedTime.getTime() - inverterTime.getTime()) / 1000);
    
    // Log the push
    console.log(`[Fronius Push] Received data for system ${system.id} (${system.displayName})`);
    console.log(`[Fronius Push] Timestamp: ${data.timestamp}, Delay: ${delaySeconds}s`);
    console.log(`[Fronius Push] Power - Solar: ${data.solarW}W (Local: ${data.solarLocalW}W, Remote: ${data.solarRemoteW}W), Load: ${data.loadW}W, Battery: ${data.batteryW}W, Grid: ${data.gridW}W`);
    
    try {
      // Insert reading into database
      await db.insert(readings).values({
        systemId: system.id,
        inverterTime,
        receivedTime,
        delaySeconds,
        solarW: data.solarW ?? null,
        solarLocalW: data.solarLocalW ?? null,
        solarRemoteW: data.solarRemoteW ?? null,
        loadW: data.loadW ?? null,
        batteryW: data.batteryW ?? null,
        gridW: data.gridW ?? null,
        batterySOC: data.batterySOC != null ? Math.round(data.batterySOC * 10) / 10 : null,
        faultCode: data.faultCode ?? null,
        faultTimestamp: data.faultTimestamp || null,
        generatorStatus: data.generatorStatus || null,
        // Energy interval counters (Wh) - integers
        solarWhInterval: data.solarWhInterval != null ? Math.round(data.solarWhInterval) : null,
        loadWhInterval: data.loadWhInterval != null ? Math.round(data.loadWhInterval) : null,
        batteryInWhInterval: data.batteryInWhInterval != null ? Math.round(data.batteryInWhInterval) : null,
        batteryOutWhInterval: data.batteryOutWhInterval != null ? Math.round(data.batteryOutWhInterval) : null,
        gridInWhInterval: data.gridInWhInterval != null ? Math.round(data.gridInWhInterval) : null,
        gridOutWhInterval: data.gridOutWhInterval != null ? Math.round(data.gridOutWhInterval) : null,
        // No totals provided in push data
        solarKwhTotal: null,
        loadKwhTotal: null,
        batteryInKwhTotal: null,
        batteryOutKwhTotal: null,
        gridInKwhTotal: null,
        gridOutKwhTotal: null,
      });
      
      // Update 5-minute aggregated data
      await updateAggregatedData(system.id, inverterTime);
      
      // Update polling status to show successful data receipt
      await updatePollingStatusSuccess(system.id);
      
      console.log(`[Fronius Push] Successfully stored data for system ${system.id}`);
      
      return NextResponse.json({
        success: true,
        message: 'Data received and stored',
        systemId: system.id,
        timestamp: inverterTime.toISOString(),
        delaySeconds
      });
      
    } catch (dbError) {
      console.error(`[Fronius Push] Database error for system ${system.id}:`, dbError);
      
      // Update polling status with error
      await updatePollingStatusError(system.id, dbError instanceof Error ? dbError : 'Database error');
      
      // Check if it's a duplicate entry error
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      if (errorMessage.includes('UNIQUE constraint failed')) {
        return NextResponse.json(
          { 
            success: false,
            error: 'Duplicate timestamp - data already exists for this time',
            timestamp: inverterTime.toISOString()
          },
          { status: 409 }  // Conflict
        );
      }
      
      throw dbError;  // Re-throw for generic error handling
    }
    
  } catch (error) {
    console.error('[Fronius Push] Error:', error);
    return NextResponse.json(
      { 
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error' 
      },
      { status: 500 }
    );
  }
}

// Also support GET for testing/health check
export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: 'ready',
    endpoint: '/api/push/fronius',
    method: 'POST',
    requiredFields: {
      authentication: ['siteId', 'apiKey'],
      data: ['timestamp'],
      optional: [
        'solarW', 'solarLocalW', 'solarRemoteW', 
        'loadW', 'batteryW', 'gridW',
        'batterySOC', 'faultCode', 'faultTimestamp', 'generatorStatus',
        'solarWhInterval', 'loadWhInterval', 
        'batteryInWhInterval', 'batteryOutWhInterval',
        'gridInWhInterval', 'gridOutWhInterval'
      ]
    },
    note: 'Currently accepts any non-empty API key. Per-site keys will be implemented later.'
  });
}