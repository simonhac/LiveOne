import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { OpenNEMResponse, OpenNEMDataSeries } from '@/types/opennem';
import { formatDataArray, formatOpenNEMResponse } from '@/lib/format-opennem';
import { formatTimeAEST, formatDateAEST, parseTimeRange, parseDateRange, parseRelativeTime, getDateDifferenceMs, getTimeDifferenceMs } from '@/lib/date-utils';
import { CalendarDate, ZonedDateTime, now } from '@internationalized/date';
import { fetch5MinuteData, fetch30MinuteData, fetch1DayData } from '@/lib/history-data-fetcher';
import { isUserAdmin } from '@/lib/auth-utils';


// Helper function to create a data series for OpenNEM response
function createDataSeries(
  remoteSystemIdentifier: string,
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
    id: `liveone.${remoteSystemIdentifier}.${fieldName}`,
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


export async function GET(request: NextRequest) {
  try {
    // Check if user is authenticated with Clerk
    const { userId } = await auth();
    
    if (!userId) {
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
    
    // Parse systemId as our internal system ID
    const systemId = parseInt(systemIdParam);
    
    // Get system from database using internal ID
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
    // Admin can access all systems, regular users can only access their own
    const isAdmin = await isUserAdmin();
    if (!isAdmin && system.ownerClerkUserId !== userId) {
      return NextResponse.json(
        { error: 'Access denied to system' },
        { status: 403 }
      );
    }
    
    // Create remote system identifier for OpenNEM data series IDs
    const remoteSystemIdentifier = `${system.vendorType}.${system.vendorSiteId}`;
    
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

    // Get system's timezone offset in minutes
    const systemTimezoneOffsetMin = system.timezoneOffsetMin;

    // Parse time range based on interval type and parameters
    let startTime: ZonedDateTime | CalendarDate;
    let endTime: ZonedDateTime | CalendarDate;

    try {
      if (lastParam) {
        // Parse relative time
        [startTime, endTime] = parseRelativeTime(lastParam, interval, systemTimezoneOffsetMin);
      } else if (startTimeParam && endTimeParam) {
        // Parse absolute time based on interval
        if (interval === '1d') {
          // For daily intervals, expect date-only strings
          [startTime, endTime] = parseDateRange(startTimeParam, endTimeParam);
        } else {
          // For minute intervals, accept datetime or date strings
          [startTime, endTime] = parseTimeRange(startTimeParam, endTimeParam, systemTimezoneOffsetMin);
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
      
      // Validate alignment with interval boundaries
      const intervalMinutes = interval === '30m' ? 30 : 5;
      
      // Check if start time is aligned to interval boundary
      const startMinute = start.minute;
      const startSecond = start.second;
      if (startSecond !== 0 || startMinute % intervalMinutes !== 0) {
        return NextResponse.json(
          { error: `Start time must be aligned to ${intervalMinutes}-minute boundaries (e.g., HH:00:00, HH:${intervalMinutes.toString().padStart(2, '0')}:00)` },
          { status: 400 }
        );
      }
      
      // Check if end time is aligned to interval boundary
      const endMinute = end.minute;
      const endSecond = end.second;
      if (endSecond !== 0 || endMinute % intervalMinutes !== 0) {
        return NextResponse.json(
          { error: `End time must be aligned to ${intervalMinutes}-minute boundaries (e.g., HH:00:00, HH:${intervalMinutes.toString().padStart(2, '0')}:00)` },
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
      
      processedData = await fetch1DayData(system.id, start, end);
    } else {
      // ZonedDateTime objects are already properly typed
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;
      
      // Fetch data based on interval
      if (interval === '30m') {
        processedData = await fetch30MinuteData(system.id, start, end, systemTimezoneOffsetMin);
      } else {
        processedData = await fetch5MinuteData(system.id, start, end, systemTimezoneOffsetMin);
      }
    }

    // Calculate date strings based on the requested range
    let requestStartStr: string;
    let requestEndStr: string;
    
    if (interval === '1d') {
      // For daily data, use the requested date range
      requestStartStr = formatDateAEST(startTime as CalendarDate);
      requestEndStr = formatDateAEST(endTime as CalendarDate);
    } else {
      // For 5m/30m intervals, use the requested time range
      requestStartStr = formatTimeAEST(startTime as ZonedDateTime);
      requestEndStr = formatTimeAEST(endTime as ZonedDateTime);
    }

    // Build OpenNEM response (identical format to regular API)
    const response: OpenNEMResponse = {
      type: 'energy',
      version: 'v4.1', // Fast implementation version
      network: 'liveone',
      created_at: formatTimeAEST(now('Australia/Brisbane')),
      requestStart: requestStartStr,
      requestEnd: requestEndStr,
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

    // Calculate date strings based on the requested range (not the data)
    let startStr: string;
    let lastStr: string;
    
    if (interval === '1d') {
      // For daily data, use the requested date range
      startStr = formatDateAEST(startTime as CalendarDate);
      lastStr = formatDateAEST(endTime as CalendarDate);
    } else {
      // For 5m/30m intervals, use the requested time range
      startStr = formatTimeAEST(startTime as ZonedDateTime);
      lastStr = formatTimeAEST(endTime as ZonedDateTime);
    }

    // Add requested fields
    if (fields.includes('solar')) {
      dataSeries.push(createDataSeries(
        remoteSystemIdentifier,
        'solar.power',
        r => r?.power?.solar?.avgW ?? r?.solar?.avgW,
        'power',
        'W',
        'Total solar generation (remote + local)',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
      
      // Add interval energy for daily data
      if (interval === '1d') {
        dataSeries.push(createDataSeries(
          remoteSystemIdentifier,
          'solar.energy',
          r => r?.solar?.intervalKwh,
          'energy',
          'kWh',
          'Total solar energy generated',
          processedData,
          startStr,
          lastStr,
          effectiveInterval
        ));
      }
    }

    if (fields.includes('load')) {
      dataSeries.push(createDataSeries(
        remoteSystemIdentifier,
        'load.power',
        r => r?.power?.load?.avgW ?? r?.load?.avgW,
        'power',
        'W',
        'Total load consumption',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
      
      // Add interval energy for daily data
      if (interval === '1d') {
        dataSeries.push(createDataSeries(
          remoteSystemIdentifier,
          'load.energy',
          r => r?.load?.loadIntervalKwh,
          'energy',
          'kWh',
          'Total load energy consumed',
          processedData,
          startStr,
          lastStr,
          effectiveInterval
        ));
      }
    }

    if (fields.includes('battery')) {
      dataSeries.push(createDataSeries(
        remoteSystemIdentifier,
        'battery.power',
        r => r?.power?.battery?.avgW ?? r?.battery?.avgW,
        'power',
        'W',
        'Battery power (negative = charging, positive = discharging)',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
      
      // Also include battery SOC - use average for daily data, last for minute data
      dataSeries.push(createDataSeries(
        remoteSystemIdentifier,
        interval === '1d' ? 'battery.soc.avg' : 'battery.soc.last',
        r => interval === '1d' ? r?.soc?.avgBattery : (r?.batterySOCLast ?? r?.battery?.batteryLastSOC),
        'percentage',
        '%',
        interval === '1d' ? 'Average battery state of charge' : 'Battery state of charge',
        processedData,
        startStr,
        lastStr,
        effectiveInterval
      ));
      
      // Add min and max SOC for daily intervals
      if (interval === '1d') {
        dataSeries.push(createDataSeries(
          remoteSystemIdentifier,
          'battery.soc.min',
          r => r?.soc?.minBattery,
          'percentage',
          '%',
          'Minimum battery state of charge',
          processedData,
          startStr,
          lastStr,
          effectiveInterval
        ));
        
        dataSeries.push(createDataSeries(
          remoteSystemIdentifier,
          'battery.soc.max',
          r => r?.soc?.maxBattery,
          'percentage',
          '%',
          'Maximum battery state of charge',
          processedData,
          startStr,
          lastStr,
          effectiveInterval
        ));
      }
    }

    if (fields.includes('grid')) {
      dataSeries.push(createDataSeries(
        remoteSystemIdentifier,
        'grid.power',
        r => r?.power?.grid?.avgW ?? r?.grid?.avgW,
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