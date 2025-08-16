import { NextRequest, NextResponse } from 'next/server';
import { db, readings, systems } from '@/lib/db';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { OpenNEMResponse, OpenNEMDataSeries, DataInterval } from '@/types/opennem';
import { APP_USERS, USER_TO_SYSTEM } from '@/config';
import { formatDataArray } from '@/lib/format-opennem';
import { parseAbsolute, toZoned } from '@internationalized/date';

// Helper function to format date to AEST timezone string without milliseconds
export function formatToAEST(date: Date): string {
  // Convert JavaScript Date to ISO string, then parse as an absolute date
  const isoString = date.toISOString();
  const absoluteDate = parseAbsolute(isoString);
  
  // Convert to AEST/AEDT (Australia/Sydney handles DST automatically)
  const zonedDate = toZoned(absoluteDate, 'Australia/Sydney');
  
  // Format as ISO string with timezone offset
  // The toString() method returns format like: 2025-08-16T20:36:41.999+10:00[Australia/Sydney]
  const fullString = zonedDate.toString();
  
  // Extract just the date, time and offset (remove timezone name and milliseconds)
  const match = fullString.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{3})?([\+\-]\d{2}:\d{2})/);
  if (match) {
    return match[1] + match[2];
  }
  
  // Fallback (shouldn't happen)
  return date.toISOString().slice(0, 19) + '+10:00';
}

// Helper function to aggregate data to 5-minute intervals
function aggregate5MinuteData(
  data: any[], 
  startTime: Date, 
  endTime: Date
): any[] {
  console.log('[5m Aggregation] Starting with', data.length, 'data points');
  console.log('[5m Aggregation] Time range:', startTime.toISOString(), 'to', endTime.toISOString());
  
  if (data.length === 0) return [];
  
  const result: any[] = [];
  const intervalMs = 5 * 60 * 1000; // 5 minutes in milliseconds
  const maxDriftMs = 2 * 60 * 1000; // 2 minutes maximum drift allowed
  
  // Align start time to 5-minute boundary
  const alignedStart = new Date(Math.floor(startTime.getTime() / intervalMs) * intervalMs);
  const alignedEnd = new Date(Math.ceil(endTime.getTime() / intervalMs) * intervalMs);
  
  // Calculate number of intervals to avoid infinite loops
  const numIntervals = Math.floor((alignedEnd.getTime() - alignedStart.getTime()) / intervalMs) + 1;
  console.log('[5m Aggregation] Creating', numIntervals, 'intervals');
  
  // Limit to prevent excessive memory usage
  if (numIntervals > 2500) { // ~8.7 days worth of 5-minute intervals
    console.error('[5m Aggregation] Too many intervals requested:', numIntervals);
    throw new Error('Too many intervals requested');
  }
  
  // Create a map for faster lookups
  const dataByTime = new Map();
  for (const reading of data) {
    const readingTime = reading.inverterTime.getTime();
    dataByTime.set(readingTime, reading);
  }
  
  // Sort data points by time for binary search
  const sortedTimes = Array.from(dataByTime.keys()).sort((a, b) => a - b);
  
  // Create time slots for every 5-minute interval
  for (let time = alignedStart.getTime(); time <= alignedEnd.getTime(); time += intervalMs) {
    const targetTime = new Date(time);
    
    // Binary search for closest reading
    let closestReading = null;
    let closestDistance = Infinity;
    
    // Find the insertion point for target time
    let left = 0;
    let right = sortedTimes.length - 1;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midTime = sortedTimes[mid];
      const distance = Math.abs(midTime - time);
      
      if (distance <= maxDriftMs && distance < closestDistance) {
        closestDistance = distance;
        closestReading = dataByTime.get(midTime);
      }
      
      if (midTime < time) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    
    // Check neighbors for potentially closer readings
    if (left > 0) {
      const prevTime = sortedTimes[left - 1];
      const distance = Math.abs(prevTime - time);
      if (distance <= maxDriftMs && distance < closestDistance) {
        closestDistance = distance;
        closestReading = dataByTime.get(prevTime);
      }
    }
    
    if (left < sortedTimes.length) {
      const nextTime = sortedTimes[left];
      const distance = Math.abs(nextTime - time);
      if (distance <= maxDriftMs && distance < closestDistance) {
        closestDistance = distance;
        closestReading = dataByTime.get(nextTime);
      }
    }
    
    if (closestReading) {
      // Use the closest reading but with the aligned timestamp
      result.push({
        ...closestReading,
        inverterTime: targetTime
      });
    } else {
      // No data within 2 minutes, create null entry
      result.push({
        inverterTime: targetTime,
        solarPower: null,
        loadPower: null,
        batteryPower: null,
        batterySOC: null,
        gridPower: null,
        systemId: data[0]?.systemId
      });
    }
  }
  
  console.log('[5m Aggregation] Created', result.length, 'aggregated points');
  return result;
}

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized - Bearer token required' },
        { status: 401 }
      );
    }

    const token = authHeader.substring(7);
    
    // Find user by matching password token
    const userEntry = Object.entries(APP_USERS).find(([_, user]) => user.password === token);
    
    if (!userEntry) {
      return NextResponse.json(
        { error: 'Invalid authentication token' },
        { status: 401 }
      );
    }

    const [username, userInfo] = userEntry;

    // Get system info for this user - for now hardcode since we only have one system
    const systemNumber = '1586'; // From SELECTLIVE_CREDENTIALS
    if (!systemNumber) {
      return NextResponse.json(
        { error: 'No system configured for user' },
        { status: 404 }
      );
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const interval = searchParams.get('interval') || '5m';
    const fieldsParam = searchParams.get('fields');
    const fields = fieldsParam ? fieldsParam.split(',') : ['solar', 'load', 'battery', 'grid'];
    
    // For now, only support 5m interval
    if (interval !== '5m') {
      return NextResponse.json(
        { error: 'Only 5m interval is currently supported' },
        { status: 501 }
      );
    }
    
    // Parse time range parameters
    const lastParam = searchParams.get('last');
    const startTimeParam = searchParams.get('startTime');
    const endTimeParam = searchParams.get('endTime');

    // Get system ID from database
    const system = await db.select()
      .from(systems)
      .where(eq(systems.systemNumber, systemNumber))
      .limit(1);

    if (!system.length) {
      return NextResponse.json(
        { error: 'System not found in database' },
        { status: 404 }
      );
    }

    const systemId = system[0].id;

    // Calculate time range
    const now = new Date();
    let startTime: Date;
    let endTime: Date;
    let aggregationInterval: string;

    // Parse 'last' parameter for relative time ranges
    if (lastParam) {
      const match = lastParam.match(/^(\d+)([dhm])$/i);
      if (!match) {
        return NextResponse.json(
          { error: 'Invalid last parameter. Use format like 7d, 3h, or 30m' },
          { status: 400 }
        );
      }
      
      const amount = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      
      endTime = now;
      switch (unit) {
        case 'd':
          startTime = new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
          break;
        case 'h':
          startTime = new Date(now.getTime() - amount * 60 * 60 * 1000);
          break;
        case 'm':
          startTime = new Date(now.getTime() - amount * 60 * 1000);
          break;
        default:
          return NextResponse.json(
            { error: 'Invalid time unit. Use d (days), h (hours), or m (minutes)' },
            { status: 400 }
          );
      }
      
      // Validate time range for 5m interval
      if (interval === '5m') {
        const timeDiff = endTime.getTime() - startTime.getTime();
        const maxDuration = 7.5 * 24 * 60 * 60 * 1000; // 7.5 days in milliseconds
        
        if (timeDiff > maxDuration) {
          return NextResponse.json(
            { error: 'Time range exceeds maximum of 7.5 days for 5m interval' },
            { status: 400 }
          );
        }
      }
    }
    // Use provided absolute time range if available
    else if (startTimeParam && endTimeParam) {
      try {
        startTime = new Date(startTimeParam);
        endTime = new Date(endTimeParam);
        
        if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
          return NextResponse.json(
            { error: 'Invalid date format. Use ISO 8601 format' },
            { status: 400 }
          );
        }
        
        if (startTime >= endTime) {
          return NextResponse.json(
            { error: 'startTime must be before endTime' },
            { status: 400 }
          );
        }
        
        // Validate time range for 5m interval
        if (interval === '5m') {
          const timeDiff = endTime.getTime() - startTime.getTime();
          const maxDuration = 7.5 * 24 * 60 * 60 * 1000; // 7.5 days in milliseconds
          
          if (timeDiff > maxDuration) {
            return NextResponse.json(
              { error: 'Time range exceeds maximum of 7.5 days for 5m interval' },
              { status: 400 }
            );
          }
        }
      } catch (error) {
        return NextResponse.json(
          { error: 'Invalid date format. Use ISO 8601 format' },
          { status: 400 }
        );
      }
    } else {
      // Default time range: last 7 days for 5m interval
      endTime = now;
      startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    
    aggregationInterval = '5m';

    // Fetch data from database
    console.log('[History API] Fetching data for interval:', interval);
    console.log('[History API] Time range:', startTime.toISOString(), 'to', endTime.toISOString());
    
    const data = await db.select()
      .from(readings)
      .where(
        and(
          eq(readings.systemId, systemId),
          gte(readings.inverterTime, startTime),
          lte(readings.inverterTime, endTime)
        )
      )
      .orderBy(readings.inverterTime);
    
    console.log('[History API] Fetched', data.length, 'raw data points');

    // Process data - always aggregate to 5-minute intervals
    let processedData: typeof data;
    let effectiveInterval: string = '5m';
    
    // Aggregate data to 5-minute intervals
    processedData = aggregate5MinuteData(data, startTime, endTime);

    // Build OpenNEM response
    const response: OpenNEMResponse = {
      type: 'energy',
      version: 'v4',
      network: 'liveone',
      created_at: formatToAEST(new Date()),
      data: []
    };

    // Process each requested field
    const dataSeries: OpenNEMDataSeries[] = [];

    if (fields.includes('solar') && processedData.length > 0) {
      dataSeries.push({
        id: `liveone.${systemNumber}.solar.power`,
        type: 'power',
        units: 'W',
        history: {
          start: formatToAEST(processedData[0].inverterTime),
          last: formatToAEST(processedData[processedData.length - 1].inverterTime),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.solarPower))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Total solar generation (remote + local)'
      });
    }

    if (fields.includes('load') && processedData.length > 0) {
      dataSeries.push({
        id: `liveone.${systemNumber}.load.power`,
        type: 'power',
        units: 'W',
        history: {
          start: formatToAEST(processedData[0].inverterTime),
          last: formatToAEST(processedData[processedData.length - 1].inverterTime),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.loadPower))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Total load consumption'
      });
    }

    if (fields.includes('battery') && processedData.length > 0) {
      dataSeries.push({
        id: `liveone.${systemNumber}.battery.power`,
        type: 'power',
        units: 'W',
        history: {
          start: formatToAEST(processedData[0].inverterTime),
          last: formatToAEST(processedData[processedData.length - 1].inverterTime),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.batteryPower))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Battery power (negative = charging, positive = discharging)'
      });

      // Also include battery SOC
      dataSeries.push({
        id: `liveone.${systemNumber}.battery.soc`,
        type: 'percentage',
        units: '%',
        history: {
          start: formatToAEST(processedData[0].inverterTime),
          last: formatToAEST(processedData[processedData.length - 1].inverterTime),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.batterySOC))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Battery state of charge'
      });
    }

    if (fields.includes('grid') && processedData.length > 0) {
      dataSeries.push({
        id: `liveone.${systemNumber}.grid.power`,
        type: 'power',
        units: 'W',
        history: {
          start: formatToAEST(processedData[0].inverterTime),
          last: formatToAEST(processedData[processedData.length - 1].inverterTime),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.gridPower))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Grid power (positive = import, negative = export)'
      });
    }

    response.data = dataSeries;

    // Convert to JSON string with proper indentation
    let jsonStr = JSON.stringify(response, null, 2);
    
    // Replace multi-line numeric data arrays with single-line arrays
    // Only target "data" arrays that contain numbers (within history objects)
    jsonStr = jsonStr.replace(/"data": \[\n\s+([\d\s,.\-null\n]+)\n\s+\]/g, (match, content) => {
      // Compact numeric arrays to single line with single spaces between elements
      const compacted = content.trim().replace(/\n\s+/g, '').replace(/,\s*/g, ',');
      return `"data": [${compacted}]`;
    });

    return new NextResponse(jsonStr, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });

  } catch (error) {
    console.error('Error fetching historical data:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}