import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readingsAgg5m, systems } from '@/lib/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { OpenNEMResponse, OpenNEMDataSeries } from '@/types/opennem';
import { formatDataArray } from '@/lib/format-opennem';
import { parseAbsolute, toZoned } from '@internationalized/date';

// Helper function to format date to AEST timezone string without milliseconds
// (identical to regular API)
function formatToAEST(date: Date): string {
  // Convert JavaScript Date to ISO string, then parse as an absolute date
  const isoString = date.toISOString();
  const absoluteDate = parseAbsolute(isoString, 'UTC');
  
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

// Helper to aggregate 5m data to 30m intervals
// Optimized version that processes data in a single pass
function aggregateTo30m(data: any[], startTime: Date, endTime: Date): any[] {
  if (data.length === 0) return [];
  
  const result: any[] = [];
  const intervalMs = 30 * 60 * 1000;
  
  // Running totals for the current 30-minute interval
  let solarWSum = 0;
  let loadWSum = 0;
  let batteryWSum = 0;
  let gridWSum = 0;
  let totalSamples = 0;
  let count = 0;
  let lastReading: any = null;
  
  // Process data in order (it's already sorted)
  for (let i = 0; i < data.length; i++) {
    const reading = data[i];
    const weight = reading.sampleCount || 1;
    
    // Add to running totals
    totalSamples += weight;
    if (reading.solarWAvg !== null) solarWSum += reading.solarWAvg * weight;
    if (reading.loadWAvg !== null) loadWSum += reading.loadWAvg * weight;
    if (reading.batteryWAvg !== null) batteryWSum += reading.batteryWAvg * weight;
    if (reading.gridWAvg !== null) gridWSum += reading.gridWAvg * weight;
    lastReading = reading;
    count++;
    
    // Every 6 readings (or at the end of data), create a 30-minute aggregate
    if (count === 6 || i === data.length - 1) {
      // Calculate the interval end time (round up to next 30-minute boundary)
      const intervalEnd = new Date(
        Math.ceil(reading.intervalEnd.getTime() / intervalMs) * intervalMs
      );
      
      result.push({
        intervalEnd,
        solarWAvg: totalSamples > 0 ? Math.round(solarWSum / totalSamples) : null,
        loadWAvg: totalSamples > 0 ? Math.round(loadWSum / totalSamples) : null,
        batteryWAvg: totalSamples > 0 ? Math.round(batteryWSum / totalSamples) : null,
        gridWAvg: totalSamples > 0 ? Math.round(gridWSum / totalSamples) : null,
        batterySOCLast: lastReading?.batterySOCLast || null,
        sampleCount: totalSamples,
      });
      
      // Reset for next interval
      solarWSum = 0;
      loadWSum = 0;
      batteryWSum = 0;
      gridWSum = 0;
      totalSamples = 0;
      count = 0;
      lastReading = null;
    }
  }
  
  return result;
}

export async function GET(request: NextRequest) {
  try {
    // Check authentication - try Bearer token first, then cookie
    let token: string | undefined;
    
    // Check for Bearer token
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    
    // If no Bearer token, check for cookie
    if (!token) {
      const cookieToken = request.cookies.get('auth-token');
      if (cookieToken) {
        token = cookieToken.value;
      }
    }
    
    // If still no token, unauthorized
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized - Authentication required' },
        { status: 401 }
      );
    }
    
    // In production, validate against AUTH_PASSWORD env var if set
    const validPassword = process.env.AUTH_PASSWORD;
    if (validPassword && token !== validPassword) {
      return NextResponse.json(
        { error: 'Invalid authentication token' },
        { status: 401 }
      );
    }

    // Default values for production
    const username = 'simon';

    // Get system info for this user - for now hardcode since we only have one system
    const systemNumber = process.env.SELECTRONIC_SYSTEM || '1586';
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
    
    // Support 5m and 30m intervals
    if (interval !== '5m' && interval !== '30m') {
      return NextResponse.json(
        { error: 'Only 5m and 30m intervals are currently supported' },
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
      
      // Validate time range based on interval
      const timeDiff = endTime.getTime() - startTime.getTime();
      if (interval === '5m') {
        const maxDuration = 7.5 * 24 * 60 * 60 * 1000; // 7.5 days in milliseconds
        if (timeDiff > maxDuration) {
          return NextResponse.json(
            { error: 'Time range exceeds maximum of 7.5 days for 5m interval' },
            { status: 400 }
          );
        }
      } else if (interval === '30m') {
        const maxDuration = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
        if (timeDiff > maxDuration) {
          return NextResponse.json(
            { error: 'Time range exceeds maximum of 30 days for 30m interval' },
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
        
        // Validate time range based on interval
        const timeDiff = endTime.getTime() - startTime.getTime();
        if (interval === '5m') {
          const maxDuration = 7.5 * 24 * 60 * 60 * 1000; // 7.5 days in milliseconds
          if (timeDiff > maxDuration) {
            return NextResponse.json(
              { error: 'Time range exceeds maximum of 7.5 days for 5m interval' },
              { status: 400 }
            );
          }
        } else if (interval === '30m') {
          const maxDuration = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
          if (timeDiff > maxDuration) {
            return NextResponse.json(
              { error: 'Time range exceeds maximum of 30 days for 30m interval' },
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
      // Default time range: last 7 days
      endTime = now;
      startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Fetch data from aggregated table
    console.log('[History API Fast] Fetching data for interval:', interval);
    console.log('[History API Fast] Time range:', startTime.toISOString(), 'to', endTime.toISOString());
    
    const queryStart = Date.now();
    
    const data = await db.select()
      .from(readingsAgg5m)
      .where(
        and(
          eq(readingsAgg5m.systemId, systemId),
          gte(readingsAgg5m.intervalEnd, startTime),
          lte(readingsAgg5m.intervalEnd, endTime)
        )
      )
      .orderBy(readingsAgg5m.intervalEnd);
    
    const queryTime = Date.now() - queryStart;
    console.log(`[History API Fast] Query completed in ${queryTime}ms, fetched ${data.length} rows`);

    // Process data - aggregate to 30m if needed
    let processedData: any[];
    let effectiveInterval: string = interval;
    
    if (interval === '30m') {
      processedData = aggregateTo30m(data, startTime, endTime);
      console.log(`[History API Fast] Aggregated to ${processedData.length} 30m intervals`);
    } else {
      processedData = data;
    }

    // Build OpenNEM response (identical format to regular API)
    const response: OpenNEMResponse = {
      type: 'energy',
      version: 'v4.1', // Fast implementation version
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
          start: formatToAEST(processedData[0].intervalEnd),
          last: formatToAEST(processedData[processedData.length - 1].intervalEnd),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.solarWAvg))
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
          start: formatToAEST(processedData[0].intervalEnd),
          last: formatToAEST(processedData[processedData.length - 1].intervalEnd),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.loadWAvg))
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
          start: formatToAEST(processedData[0].intervalEnd),
          last: formatToAEST(processedData[processedData.length - 1].intervalEnd),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.batteryWAvg))
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
          start: formatToAEST(processedData[0].intervalEnd),
          last: formatToAEST(processedData[processedData.length - 1].intervalEnd),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.batterySOCLast))
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
          start: formatToAEST(processedData[0].intervalEnd),
          last: formatToAEST(processedData[processedData.length - 1].intervalEnd),
          interval: effectiveInterval,
          data: formatDataArray(processedData.map(r => r.gridWAvg))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Grid power (positive = import, negative = export)'
      });
    }

    response.data = dataSeries;

    // Convert to JSON string with proper indentation (identical to regular API)
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
    console.error('Error fetching historical data (fast):', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}