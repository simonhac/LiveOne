import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readingsAgg5m, systems } from '@/lib/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { OpenNEMResponse, OpenNEMDataSeries } from '@/types/opennem';
import { formatDataArray } from '@/lib/format-opennem';
import { parseAbsolute, toZoned } from '@internationalized/date';

// Helper function to format date to AEST timezone string
function formatToAEST(date: Date): string {
  const isoString = date.toISOString();
  const absoluteDate = parseAbsolute(isoString, 'UTC');
  const zonedDate = toZoned(absoluteDate, 'Australia/Sydney');
  const fullString = zonedDate.toString();
  const match = fullString.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{3})?([\+\-]\d{2}:\d{2})/);
  if (match) {
    return match[1] + match[2];
  }
  return date.toISOString().slice(0, 19) + '+10:00';
}

// Helper to aggregate 5m data to 30m intervals
function aggregateTo30m(data: any[]): any[] {
  if (data.length === 0) return [];
  
  const result: any[] = [];
  const intervalMs = 30 * 60 * 1000;
  
  // Group by 30-minute intervals
  const intervalBuckets = new Map<number, any[]>();
  
  for (const reading of data) {
    const time = reading.intervalEnd.getTime();
    const intervalEnd = Math.ceil(time / intervalMs) * intervalMs;
    
    if (!intervalBuckets.has(intervalEnd)) {
      intervalBuckets.set(intervalEnd, []);
    }
    intervalBuckets.get(intervalEnd)!.push(reading);
  }
  
  // Aggregate each 30-minute bucket
  for (const [intervalEnd, readings] of intervalBuckets) {
    if (readings.length === 0) continue;
    
    // For 30m aggregation, we average the already-averaged 5m values
    // Weight by sample count for more accurate averaging
    let totalSamples = 0;
    let solarWSum = 0, loadWSum = 0, batteryWSum = 0, gridWSum = 0;
    
    for (const r of readings) {
      const weight = r.sampleCount || 1;
      totalSamples += weight;
      
      if (r.solarWAvg !== null) solarWSum += r.solarWAvg * weight;
      if (r.loadWAvg !== null) loadWSum += r.loadWAvg * weight;
      if (r.batteryWAvg !== null) batteryWSum += r.batteryWAvg * weight;
      if (r.gridWAvg !== null) gridWSum += r.gridWAvg * weight;
    }
    
    // Use the last reading for state values
    const sortedReadings = readings.sort((a, b) => 
      a.intervalEnd.getTime() - b.intervalEnd.getTime()
    );
    const lastReading = sortedReadings[sortedReadings.length - 1];
    
    result.push({
      intervalEnd: new Date(intervalEnd),
      solarWAvg: totalSamples > 0 ? solarWSum / totalSamples : null,
      loadWAvg: totalSamples > 0 ? loadWSum / totalSamples : null,
      batteryWAvg: totalSamples > 0 ? batteryWSum / totalSamples : null,
      gridWAvg: totalSamples > 0 ? gridWSum / totalSamples : null,
      batterySOCLast: lastReading.batterySOCLast,
      sampleCount: totalSamples,
    });
  }
  
  return result.sort((a, b) => a.intervalEnd.getTime() - b.intervalEnd.getTime());
}

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const cookieToken = request.cookies.get('auth-token');
    if (!cookieToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Get system
    const systemNumber = process.env.SELECTRONIC_SYSTEM || '1586';
    const [system] = await db.select()
      .from(systems)
      .where(eq(systems.systemNumber, systemNumber))
      .limit(1);
    
    if (!system) {
      return NextResponse.json({ error: 'System not found' }, { status: 404 });
    }
    
    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const interval = searchParams.get('interval') || '5m';
    const fieldsParam = searchParams.get('fields');
    const fields = fieldsParam ? fieldsParam.split(',') : ['solar', 'load', 'battery', 'grid'];
    
    // Only support 5m and 30m intervals
    if (interval !== '5m' && interval !== '30m') {
      return NextResponse.json(
        { error: 'Only 5m and 30m intervals are supported' },
        { status: 400 }
      );
    }
    
    // Parse time range
    const lastParam = searchParams.get('last');
    let endTime = new Date();
    let startTime: Date;
    
    if (lastParam) {
      const match = lastParam.match(/^(\d+)([dhm])$/i);
      if (!match) {
        return NextResponse.json(
          { error: 'Invalid last parameter' },
          { status: 400 }
        );
      }
      
      const amount = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      
      switch (unit) {
        case 'd':
          startTime = new Date(endTime.getTime() - amount * 24 * 60 * 60 * 1000);
          break;
        case 'h':
          startTime = new Date(endTime.getTime() - amount * 60 * 60 * 1000);
          break;
        case 'm':
          startTime = new Date(endTime.getTime() - amount * 60 * 1000);
          break;
        default:
          return NextResponse.json({ error: 'Invalid time unit' }, { status: 400 });
      }
    } else {
      // Default: last 24 hours
      startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);
    }
    
    console.log(`[History API Fast] Fetching ${interval} data from ${startTime.toISOString()} to ${endTime.toISOString()}`);
    const queryStart = Date.now();
    
    // Fetch from aggregated table (MUCH faster!)
    const data = await db.select()
      .from(readingsAgg5m)
      .where(
        and(
          eq(readingsAgg5m.systemId, system.id),
          gte(readingsAgg5m.intervalEnd, startTime),
          lte(readingsAgg5m.intervalEnd, endTime)
        )
      )
      .orderBy(readingsAgg5m.intervalEnd);
    
    const queryTime = Date.now() - queryStart;
    console.log(`[History API Fast] Query completed in ${queryTime}ms, ${data.length} rows`);
    
    // Process data based on interval
    let processedData = data;
    let effectiveInterval = '5m';
    
    if (interval === '30m') {
      processedData = aggregateTo30m(data);
      effectiveInterval = '30m';
    }
    
    if (processedData.length === 0) {
      return NextResponse.json({
        type: 'energy',
        version: 'v4',
        network: 'liveone',
        created_at: formatToAEST(new Date()),
        data: [],
        metadata: {
          query_time_ms: queryTime,
          source: 'aggregated_table'
        }
      });
    }
    
    // Build OpenNEM response
    const response: OpenNEMResponse = {
      type: 'energy',
      version: 'v4',
      network: 'liveone',
      created_at: formatToAEST(new Date()),
      data: []
    };
    
    const dataSeries: OpenNEMDataSeries[] = [];
    
    if (fields.includes('solar')) {
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
        description: 'Total solar generation'
      });
    }
    
    if (fields.includes('load')) {
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
    
    if (fields.includes('battery')) {
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
        description: 'Battery power'
      });
      
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
    
    if (fields.includes('grid')) {
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
        description: 'Grid power'
      });
    }
    
    response.data = dataSeries;
    
    // Add metadata about performance
    (response as any).metadata = {
      query_time_ms: queryTime,
      source: 'aggregated_table',
      rows_fetched: data.length,
      rows_processed: processedData.length
    };
    
    // Format response
    let jsonStr = JSON.stringify(response, null, 2);
    jsonStr = jsonStr.replace(/"data": \[\n\s+([\d\s,.\-null\n]+)\n\s+\]/g, (match, content) => {
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
    console.error('Error in fast history API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}