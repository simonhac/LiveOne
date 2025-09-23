import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { getSystemsManager } from '@/lib/get-systems-manager';
import { updateAggregatedData } from '@/lib/aggregation-helper';
import { updatePollingStatusSuccess, updatePollingStatusError } from '@/lib/polling-utils';

/**
 * Expected request body for Fronius push data
 * Contains all CommonPollingData fields except totals
 */
interface FroniusPushData {
  // Authentication and action
  apiKey: string;  // This is actually the site ID (vendorSiteId in database)
  action: 'test' | 'store';  // Action to perform: 'test' for auth check, 'store' to save data
  
  // Timestamp and sequence (required for 'store' action)
  timestamp?: string;
  sequence?: string;  // Required unique sequence identifier for 'store' action
  
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
  faultTimestamp?: string | null;  // ISO8601 timestamp of fault
  generatorStatus?: number | null;
  
  // Energy counters (Wh) - interval values (energy in this period)
  solarWhInterval?: number | null;
  loadWhInterval?: number | null;
  batteryInWhInterval?: number | null;
  batteryOutWhInterval?: number | null;
  gridInWhInterval?: number | null;
  gridOutWhInterval?: number | null;
}

// Removed validateApiKey function - we now use apiKey as the site identifier

export async function POST(request: NextRequest) {
  try {
    // Get raw body text first
    const rawBody = await request.text();
    // Then parse it
    const data: FroniusPushData = JSON.parse(rawBody);
    
    // Validate required fields
    if (!data.apiKey) {
      return NextResponse.json(
        { error: 'Missing apiKey' },
        { status: 400 }
      );
    }
    
    if (!data.action || (data.action !== 'test' && data.action !== 'store')) {
      return NextResponse.json(
        { error: 'Missing or invalid action. Must be "test" or "store"' },
        { status: 400 }
      );
    }
    
    // For 'store' action, validate additional required fields
    if (data.action === 'store') {
      if (!data.timestamp) {
        return NextResponse.json(
          { error: 'Missing timestamp (required for store action)' },
          { status: 400 }
        );
      }
      
      if (!data.sequence) {
        return NextResponse.json(
          { error: 'Missing sequence (required for store action)' },
          { status: 400 }
        );
      }
    }
    
    // Get SystemsManager instance
    const systemsManager = await getSystemsManager();
    
    // Find the system by vendorSiteId (using apiKey as the site identifier)
    const system = await systemsManager.getSystemByVendorSiteId(data.apiKey);
    
    if (!system) {
      console.error(`[Fronius Push] System not found for apiKey: ${data.apiKey}`);
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
    
    // If action is 'test', return success without storing data
    if (data.action === 'test') {
      console.log(`[Fronius Push] Test authentication successful for system ${system.id} (${system.displayName})`);
      return NextResponse.json({
        success: true,
        action: 'test',
        message: 'Authentication successful',
        systemId: system.id,
        displayName: system.displayName
      });
    }
    
    // For 'store' action, proceed with data storage
    // Calculate timestamps and delay
    const inverterTime = new Date(data.timestamp!);
    const receivedTime = new Date();
    const delaySeconds = Math.floor((receivedTime.getTime() - inverterTime.getTime()) / 1000);
    
    // Log the push
    console.log(`[Fronius Push] Received data for system ${system.id} (${system.displayName})`);
    console.log(`[Fronius Push] Timestamp: ${data.timestamp}, Sequence: ${data.sequence}, Delay: ${delaySeconds}s`);
    console.log(`[Fronius Push] Power - Solar: ${data.solarW}W (Local: ${data.solarLocalW}W, Remote: ${data.solarRemoteW}W), Load: ${data.loadW}W, Battery: ${data.batteryW}W, Grid: ${data.gridW}W`);
    
    try {
      // Insert reading into database
      await db.insert(readings).values({
        systemId: system.id,
        inverterTime,
        sequence: data.sequence,
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
        faultTimestamp: data.faultTimestamp ? Math.floor(new Date(data.faultTimestamp).getTime() / 1000) : null,
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
      // Store the raw JSON string
      await updatePollingStatusSuccess(system.id, rawBody);
      
      console.log(`[Fronius Push] Successfully stored data for system ${system.id}`);
      
      return NextResponse.json({
        success: true,
        action: 'store',
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
      always: ['apiKey', 'action'],  // apiKey is used as the site identifier, action is 'test' or 'store'
      forStoreAction: ['timestamp', 'sequence'],
      optional: [
        'solarW', 'solarLocalW', 'solarRemoteW', 
        'loadW', 'batteryW', 'gridW',
        'batterySOC', 'faultCode', 'faultTimestamp', 'generatorStatus',
        'solarWhInterval', 'loadWhInterval', 
        'batteryInWhInterval', 'batteryOutWhInterval',
        'gridInWhInterval', 'gridOutWhInterval'
      ]
    },
    note: 'The apiKey field is used as the site identifier (vendorSiteId). Use action="test" to validate authentication, action="store" to save data.'
  });
}