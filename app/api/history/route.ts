import { NextRequest, NextResponse } from 'next/server';
import { db, readings, systems } from '@/lib/db';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
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
    const interval = (searchParams.get('interval') || '1m') as DataInterval;
    const fieldsParam = searchParams.get('fields');
    const fields = fieldsParam ? fieldsParam.split(',') : ['solar', 'load', 'battery', 'grid'];

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

    // Calculate time range based on interval
    const now = new Date();
    let startTime: Date;
    let aggregationInterval: string;

    switch (interval) {
      case '1m':
        // Last 7 days of 1-minute data
        startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        aggregationInterval = '1m';
        break;
      case '1d':
        // Last 365 days of daily data
        startTime = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        aggregationInterval = '1d';
        break;
      case '1w':
        // Last 52 weeks of weekly data
        startTime = new Date(now.getTime() - 52 * 7 * 24 * 60 * 60 * 1000);
        aggregationInterval = '1w';
        break;
      case '1M':
        // All time monthly data
        startTime = new Date(2020, 0, 1); // Assuming data starts from 2020
        aggregationInterval = '1M';
        break;
      default:
        return NextResponse.json(
          { error: 'Invalid interval. Use 1m, 1d, 1w, or 1M' },
          { status: 400 }
        );
    }

    // Fetch data from database
    const data = await db.select()
      .from(readings)
      .where(
        and(
          eq(readings.systemId, systemId),
          gte(readings.inverterTime, startTime)
        )
      )
      .orderBy(readings.inverterTime);

    // For now, we'll implement 1-minute interval (raw data)
    // Later we'll add aggregation for other intervals
    if (interval !== '1m') {
      return NextResponse.json(
        { error: 'Only 1m interval is currently supported' },
        { status: 501 }
      );
    }

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

    if (fields.includes('solar') && data.length > 0) {
      dataSeries.push({
        id: `liveone.${systemNumber}.solar.power`,
        type: 'power',
        units: 'W',
        history: {
          start: formatToAEST(data[0].inverterTime),
          last: formatToAEST(data[data.length - 1].inverterTime),
          interval: '1m',
          data: formatDataArray(data.map(r => r.solarPower))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Total solar generation (remote + local)'
      });
    }

    if (fields.includes('load') && data.length > 0) {
      dataSeries.push({
        id: `liveone.${systemNumber}.load.power`,
        type: 'power',
        units: 'W',
        history: {
          start: formatToAEST(data[0].inverterTime),
          last: formatToAEST(data[data.length - 1].inverterTime),
          interval: '1m',
          data: formatDataArray(data.map(r => r.loadPower))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Total load consumption'
      });
    }

    if (fields.includes('battery') && data.length > 0) {
      dataSeries.push({
        id: `liveone.${systemNumber}.battery.power`,
        type: 'power',
        units: 'W',
        history: {
          start: formatToAEST(data[0].inverterTime),
          last: formatToAEST(data[data.length - 1].inverterTime),
          interval: '1m',
          data: formatDataArray(data.map(r => r.batteryPower))
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
          start: formatToAEST(data[0].inverterTime),
          last: formatToAEST(data[data.length - 1].inverterTime),
          interval: '1m',
          data: formatDataArray(data.map(r => r.batterySOC))
        },
        network: 'liveone',
        source: 'selectronic',
        description: 'Battery state of charge'
      });
    }

    if (fields.includes('grid') && data.length > 0) {
      dataSeries.push({
        id: `liveone.${systemNumber}.grid.power`,
        type: 'power',
        units: 'W',
        history: {
          start: formatToAEST(data[0].inverterTime),
          last: formatToAEST(data[data.length - 1].inverterTime),
          interval: '1m',
          data: formatDataArray(data.map(r => r.gridPower))
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