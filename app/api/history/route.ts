import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systems, readingsAgg5m, readingsAgg1d } from '@/lib/db/schema';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { OpenNEMResponse, OpenNEMDataSeries } from '@/types/opennem';
import { formatDataArray, formatOpenNEMResponse, roundToThree } from '@/lib/format-opennem';
import { formatTimeAEST, formatDateAEST, parseTimeRange, parseDateRange, parseRelativeTime, toUnixTimestamp, getDateDifferenceMs, getTimeDifferenceMs } from '@/lib/date-utils';
import { parseAbsolute, toZoned, CalendarDate, ZonedDateTime, now } from '@internationalized/date';
import { getCurrentUser, userHasSystemAccess } from '@/lib/user-manager';

// Fetch 5-minute aggregated data
async function fetch5MinuteData(systemId: number, startTime: ZonedDateTime, endTime: ZonedDateTime) {
  // Convert ZonedDateTime to Unix timestamp for database query
  const startTimestamp = toUnixTimestamp(startTime);
  const endTimestamp = toUnixTimestamp(endTime);
  
  // The intervalEnd column is stored as Unix timestamp, so compare directly
  const data = await db.select()
    .from(readingsAgg5m)
    .where(
      and(
        eq(readingsAgg5m.systemId, systemId),
        gte(readingsAgg5m.intervalEnd, startTimestamp),
        lte(readingsAgg5m.intervalEnd, endTimestamp)
      )
    )
    .orderBy(readingsAgg5m.intervalEnd);
  
  // Drizzle SQLite returns timestamps as integers (Unix seconds), not Date objects
  // We need to convert them to Date objects for formatTimeAEST
  const processedData = data.map(row => ({
    ...row,
    intervalEnd: new Date(row.intervalEnd * 1000) // Convert Unix seconds to Date
  }));
  
  return processedData;
}

// Fetch daily aggregated data and transform to match api/data structure
async function fetchDailyData(systemId: number, startDate: CalendarDate, endDate: CalendarDate) {
  // Format dates as YYYY-MM-DD strings for the database query
  const startDateStr = formatDateAEST(startDate);
  const endDateStr = formatDateAEST(endDate);
  
  const dailyData = await db.select()
    .from(readingsAgg1d)
    .where(
      and(
        eq(readingsAgg1d.systemId, systemId.toString()),
        gte(readingsAgg1d.day, startDateStr),
        lte(readingsAgg1d.day, endDateStr)
      )
    )
    .orderBy(readingsAgg1d.day);
  
  
  // Transform daily data to match the api/data structure
  return dailyData.map(row => {
    // End of day is 00:00:00 of the next day
    const nextDay = new Date(row.day + 'T00:00:00Z');
    nextDay.setDate(nextDay.getDate() + 1);
    
    return {
      // Fields for compatibility with existing charting
      intervalEnd: nextDay,
      solarWAvg: row.solarWAvg,
      loadWAvg: row.loadWAvg,
      batteryWAvg: row.batteryWAvg,
      gridWAvg: row.gridWAvg,
      batterySOCLast: row.batterySocEnd,
      sampleCount: row.intervalCount || 0,
      
      // Full structured data matching api/data format
      date: row.day,
      energy: {
        solarKwh: roundToThree(row.solarKwh),
        loadKwh: roundToThree(row.loadKwh),
        batteryChargeKwh: roundToThree(row.batteryChargeKwh),
        batteryDischargeKwh: roundToThree(row.batteryDischargeKwh),
        gridImportKwh: roundToThree(row.gridImportKwh),
        gridExportKwh: roundToThree(row.gridExportKwh)
      },
      power: {
        solar: {
          minW: row.solarWMin,
          avgW: row.solarWAvg,
          maxW: row.solarWMax
        },
        load: {
          minW: row.loadWMin,
          avgW: row.loadWAvg,
          maxW: row.loadWMax
        },
        battery: {
          minW: row.batteryWMin,
          avgW: row.batteryWAvg,
          maxW: row.batteryWMax
        },
        grid: {
          minW: row.gridWMin,
          avgW: row.gridWAvg,
          maxW: row.gridWMax
        }
      },
      soc: {
        minBattery: roundToThree(row.batterySocMin),
        avgBattery: roundToThree(row.batterySocAvg),
        maxBattery: roundToThree(row.batterySocMax),
        endBattery: roundToThree(row.batterySocEnd)
      },
      dataQuality: {
        intervalCount: row.intervalCount,
        coverage: row.intervalCount ? `${Math.round((row.intervalCount / 288) * 100)}%` : null
      }
    };
  });
}

// Helper function to create a data series for OpenNEM response
function createDataSeries(
  systemNumber: string,
  fieldName: string,
  dataExtractor: (r: any) => any,
  type: string,
  units: string,
  description: string,
  processedData: any[],
  startStr: string,
  lastStr: string,
  effectiveInterval: string
): OpenNEMDataSeries {
  return {
    id: `liveone.${systemNumber}.${fieldName}`,
    type,
    units,
    history: {
      start: startStr,
      last: lastStr,
      interval: effectiveInterval,
      data: formatDataArray(processedData.map(dataExtractor))
    },
    network: 'liveone',
    source: 'selectronic',
    description
  };
}

// Helper to aggregate 5m data to 30m intervals
// Optimized version that processes data in a single pass
function aggregateTo30m(data: any[]): any[] {
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
      const intervalEndMs = reading.intervalEnd.getTime();
      const intervalEnd = new Date(
        Math.ceil(intervalEndMs / intervalMs) * intervalMs
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
    // Get current user from request
    const user = await getCurrentUser(request);
    
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized - Authentication required' },
        { status: 401 }
      );
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const systemIdParam = searchParams.get('systemId');
    const interval = searchParams.get('interval');
    const fieldsParam = searchParams.get('fields');
    
    // Require systemId parameter
    if (!systemIdParam) {
      return NextResponse.json(
        { error: 'Missing required parameter: systemId' },
        { status: 400 }
      );
    }
    
    // Parse systemId as integer
    const systemId = parseInt(systemIdParam);
    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: 'Invalid systemId: must be a number' },
        { status: 400 }
      );
    }
    
    // Get system from database and verify user has access
    const [system] = await db.select()
      .from(systems)
      .where(eq(systems.id, systemId))
      .limit(1);
    
    if (!system) {
      return NextResponse.json(
        { error: 'System not found' },
        { status: 404 }
      );
    }
    
    // Check if user has access to this system
    const hasAccess = await userHasSystemAccess(user, system.systemNumber);
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Access denied to system' },
        { status: 403 }
      );
    }
    
    const systemNumber = system.systemNumber;
    
    // Require interval parameter
    if (!interval) {
      return NextResponse.json(
        { error: 'Missing required parameter: interval. Must be one of: 5m, 30m, 1d' },
        { status: 400 }
      );
    }
    
    // Require fields parameter
    if (!fieldsParam) {
      return NextResponse.json(
        { error: 'Missing required parameter: fields. Specify comma-separated list of: solar, load, battery, grid' },
        { status: 400 }
      );
    }
    
    const fields = fieldsParam.split(',');
    
    // Support 5m, 30m, and 1d intervals
    if (interval !== '5m' && interval !== '30m' && interval !== '1d') {
      return NextResponse.json(
        { error: 'Only 5m, 30m, and 1d intervals are supported' },
        { status: 501 }
      );
    }
    
    // Parse time range parameters
    const lastParam = searchParams.get('last');
    const startTimeParam = searchParams.get('startTime');
    const endTimeParam = searchParams.get('endTime');

    // Get system's timezone offset
    const systemTimezoneOffset = system.timezoneOffset || 10; // Default to AEST

    // Parse time range based on interval type and parameters
    let startTime: ZonedDateTime | CalendarDate;
    let endTime: ZonedDateTime | CalendarDate;

    try {
      if (lastParam) {
        // Parse relative time
        [startTime, endTime] = parseRelativeTime(lastParam, interval, systemTimezoneOffset);
      } else if (startTimeParam && endTimeParam) {
        // Parse absolute time based on interval
        if (interval === '1d') {
          // For daily intervals, expect date-only strings
          [startTime, endTime] = parseDateRange(startTimeParam, endTimeParam);
        } else {
          // For minute intervals, accept datetime or date strings
          [startTime, endTime] = parseTimeRange(startTimeParam, endTimeParam, systemTimezoneOffset);
        }
      } else {
        return NextResponse.json(
          { error: 'Missing time range. Provide either "last" parameter (e.g., last=7d) or both "startTime" and "endTime" parameters' },
          { status: 400 }
        );
      }
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid time range parameters' },
        { status: 400 }
      );
    }

    // Validate time range and check limits
    let timeDiff: number;
    
    if (interval === '1d') {
      // For CalendarDate, validate and calculate day difference
      const start = startTime as CalendarDate;
      const end = endTime as CalendarDate;
      
      if (start.compare(end) > 0) {
        return NextResponse.json(
          { error: 'startTime must be before endTime' },
          { status: 400 }
        );
      }
      
      // Calculate difference in milliseconds
      timeDiff = getDateDifferenceMs(start, end);
    } else {
      // For ZonedDateTime, validate and calculate millisecond difference
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;
      
      if (start.compare(end) >= 0) {
        return NextResponse.json(
          { error: 'startTime must be before endTime' },
          { status: 400 }
        );
      }
      
      // Calculate time difference in milliseconds
      timeDiff = getTimeDifferenceMs(start, end);
    }

    // Check time range limits
    let maxDuration: number;
    let maxDurationLabel: string;

    switch (interval) {
      case '5m':
        maxDuration = 7.5 * 24 * 60 * 60 * 1000; // 7.5 days
        maxDurationLabel = '7.5 days';
        break;
      case '30m':
        maxDuration = 30 * 24 * 60 * 60 * 1000; // 30 days
        maxDurationLabel = '30 days';
        break;
      case '1d':
        maxDuration = 13 * 30 * 24 * 60 * 60 * 1000; // ~13 months
        maxDurationLabel = '13 months';
        break;
      default:
        maxDuration = 7.5 * 24 * 60 * 60 * 1000;
        maxDurationLabel = '7.5 days';
    }

    if (timeDiff > maxDuration) {
      return NextResponse.json(
        { error: `Time range exceeds maximum of ${maxDurationLabel} for ${interval} interval` },
        { status: 400 }
      );
    }

    // Fetch data based on interval
    let processedData: any[];
    let effectiveInterval: string = interval;
    
    if (interval === '1d') {
      // CalendarDate objects are already properly typed
      const start = startTime as CalendarDate;
      const end = endTime as CalendarDate;
      
      processedData = await fetchDailyData(systemId, start, end);
    } else {
      // ZonedDateTime objects are already properly typed
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;
      
      // Fetch 5-minute data
      const data = await fetch5MinuteData(systemId, start, end);
      
      // Aggregate to 30m if needed
      if (interval === '30m') {
        processedData = aggregateTo30m(data);
      } else {
        processedData = data;
      }
    }

    // Build OpenNEM response (identical format to regular API)
    const response: OpenNEMResponse = {
      type: 'energy',
      version: 'v4.1', // Fast implementation version
      network: 'liveone',
      created_at: formatTimeAEST(new Date()),
      data: []
    };

    // Process each requested field
    const dataSeries: OpenNEMDataSeries[] = [];

    // Skip if no data
    if (processedData.length === 0) {
      response.data = dataSeries;
      return new NextResponse(JSON.stringify(response, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Calculate date strings once for all fields
    let startStr: string;
    let lastStr: string;
    
    if (interval === '1d') {
      startStr = processedData[0].date;
      lastStr = processedData[processedData.length - 1].date;
    } else {
      // For 5m/30m intervals, intervalEnd is a Date object after processing
      const firstInterval = processedData[0].intervalEnd;
      const lastInterval = processedData[processedData.length - 1].intervalEnd;
      
      startStr = formatTimeAEST(firstInterval);
      lastStr = formatTimeAEST(lastInterval);
    }

    // Add requested fields
    if (fields.includes('solar')) {
      dataSeries.push(createDataSeries(
        systemNumber,
        'solar.power',
        r => r.solarWAvg,
        'power',
        'W',
        'Total solar generation (remote + local)',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
    }

    if (fields.includes('load')) {
      dataSeries.push(createDataSeries(
        systemNumber,
        'load.power',
        r => r.loadWAvg,
        'power',
        'W',
        'Total load consumption',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
    }

    if (fields.includes('battery')) {
      dataSeries.push(createDataSeries(
        systemNumber,
        'battery.power',
        r => r.batteryWAvg,
        'power',
        'W',
        'Battery power (negative = charging, positive = discharging)',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
      
      // Also include battery SOC
      dataSeries.push(createDataSeries(
        systemNumber,
        'battery.soc',
        r => r.batterySOCLast,
        'percentage',
        '%',
        'Battery state of charge',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
    }

    if (fields.includes('grid')) {
      dataSeries.push(createDataSeries(
        systemNumber,
        'grid.power',
        r => r.gridWAvg,
        'power',
        'W',
        'Grid power (positive = import, negative = export)',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
    }

    response.data = dataSeries;

    // Format response with compact data arrays
    const jsonStr = formatOpenNEMResponse(response);

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