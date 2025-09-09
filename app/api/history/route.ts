import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { OpenNEMResponse, OpenNEMDataSeries } from '@/types/opennem';
import { formatDataArray, formatOpenNEMResponse } from '@/lib/format-opennem';
import { 
  formatTimeAEST, 
  formatDateAEST, 
  parseTimeRange as parseTimeRangeUtil, 
  parseDateRange, 
  parseRelativeTime, 
  getDateDifferenceMs, 
  getTimeDifferenceMs
} from '@/lib/date-utils';
import { CalendarDate, ZonedDateTime, now } from '@internationalized/date';
import { fetch5MinuteData, fetch30MinuteData, fetch1DayData } from '@/lib/history-data-fetcher';
import { fetchCraighackHistory } from '@/lib/craighack/craighack-history';
import { isUserAdmin } from '@/lib/auth-utils';

// ============================================================================
// Types and Interfaces
// ============================================================================

interface AuthResult {
  userId: string;
  isAdmin: boolean;
}

interface SystemAccess {
  system: typeof systems.$inferSelect;
  hasAccess: boolean;
}

interface ParsedParams {
  systemId: number;
  interval: '5m' | '30m' | '1d';
  fields: string[];
  startTime: ZonedDateTime | CalendarDate;
  endTime: ZonedDateTime | CalendarDate;
  systemTimezoneOffsetMin: number;
}

interface ValidationResult {
  isValid: boolean;
  error?: string;
  statusCode?: number;
}

// ============================================================================
// Authentication & Access Control
// ============================================================================

async function authenticateUser(): Promise<AuthResult | NextResponse> {
  const { userId } = await auth();
  
  if (!userId) {
    return NextResponse.json(
      { error: 'Unauthorized - Authentication required' },
      { status: 401 }
    );
  }

  const isAdmin = await isUserAdmin();
  return { userId, isAdmin };
}

async function checkSystemAccess(
  systemId: number, 
  userId: string, 
  isAdmin: boolean
): Promise<SystemAccess | NextResponse> {
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
  
  // Admin can access all systems, regular users can only access their own
  const hasAccess = isAdmin || system.ownerClerkUserId === userId;
  
  if (!hasAccess) {
    return NextResponse.json(
      { error: 'Access denied to system' },
      { status: 403 }
    );
  }
  
  return { system, hasAccess };
}

// ============================================================================
// Parameter Parsing & Validation
// ============================================================================

function parseBasicParams(searchParams: URLSearchParams): ValidationResult & { 
  systemId?: number; 
  interval?: string; 
  fields?: string[] 
} {
  const systemIdParam = searchParams.get('systemId');
  if (!systemIdParam) {
    return {
      isValid: false,
      error: 'Missing required parameter: systemId',
      statusCode: 400
    };
  }
  
  const systemId = parseInt(systemIdParam);
  if (isNaN(systemId)) {
    return {
      isValid: false,
      error: 'Invalid systemId: must be a number',
      statusCode: 400
    };
  }
  
  const interval = searchParams.get('interval');
  if (!interval) {
    return {
      isValid: false,
      error: 'Missing required parameter: interval. Must be one of: 5m, 30m, 1d',
      statusCode: 400
    };
  }
  
  if (!['5m', '30m', '1d'].includes(interval)) {
    return {
      isValid: false,
      error: 'Only 5m, 30m, and 1d intervals are supported',
      statusCode: 501
    };
  }
  
  const fieldsParam = searchParams.get('fields');
  if (!fieldsParam) {
    return {
      isValid: false,
      error: 'Missing required parameter: fields. Specify comma-separated list of: solar, load, battery, grid',
      statusCode: 400
    };
  }
  
  const fields = fieldsParam.split(',').filter(f => f.trim());
  
  return {
    isValid: true,
    systemId,
    interval,
    fields
  };
}

function parseTimeRangeParams(
  searchParams: URLSearchParams,
  interval: '5m' | '30m' | '1d',
  systemTimezoneOffsetMin: number
): ValidationResult & {
  startTime?: ZonedDateTime | CalendarDate;
  endTime?: ZonedDateTime | CalendarDate;
} {
  const lastParam = searchParams.get('last');
  const startTimeParam = searchParams.get('startTime');
  const endTimeParam = searchParams.get('endTime');
  
  let startTime: ZonedDateTime | CalendarDate;
  let endTime: ZonedDateTime | CalendarDate;
  
  try {
    if (lastParam) {
      // Parse relative time
      [startTime, endTime] = parseRelativeTime(lastParam, interval, systemTimezoneOffsetMin);
    } else if (startTimeParam && endTimeParam) {
      // Parse absolute time based on interval
      switch (interval) {
        case '1d':
          // For daily intervals, expect date-only strings
          [startTime, endTime] = parseDateRange(startTimeParam, endTimeParam);
          break;
          
        case '30m':
        case '5m':
          // For minute intervals, accept datetime or date strings
          [startTime, endTime] = parseTimeRangeUtil(startTimeParam, endTimeParam, systemTimezoneOffsetMin);
          break;
          
        default:
          throw new Error(`Unsupported interval: ${interval}`);
      }
    } else {
      return {
        isValid: false,
        error: 'Missing time range. Provide either "last" parameter (e.g., last=7d) or both "startTime" and "endTime" parameters',
        statusCode: 400
      };
    }
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Invalid time range parameters',
      statusCode: 400
    };
  }
  
  return {
    isValid: true,
    startTime,
    endTime
  };
}

function validateTimeRange(
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: '5m' | '30m' | '1d'
): ValidationResult {
  let timeDiff: number;
  
  switch (interval) {
    case '1d': {
      // For CalendarDate, validate and calculate day difference
      const start = startTime as CalendarDate;
      const end = endTime as CalendarDate;
      
      if (start.compare(end) > 0) {
        return {
          isValid: false,
          error: 'startTime must be before endTime',
          statusCode: 400
        };
      }
      
      timeDiff = getDateDifferenceMs(start, end);
      break;
    }
    
    case '30m':
    case '5m': {
      // For ZonedDateTime, validate and calculate millisecond difference
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;
      
      if (start.compare(end) >= 0) {
        return {
          isValid: false,
          error: 'startTime must be before endTime',
          statusCode: 400
        };
      }
      
      // Validate alignment with interval boundaries
      const intervalMinutes = interval === '30m' ? 30 : 5;
      
      // Check if start time is aligned to interval boundary
      const startMinute = start.minute;
      const startSecond = start.second;
      if (startSecond !== 0 || startMinute % intervalMinutes !== 0) {
        return {
          isValid: false,
          error: `Start time must be aligned to ${intervalMinutes}-minute boundaries (e.g., HH:00:00, HH:${intervalMinutes.toString().padStart(2, '0')}:00)`,
          statusCode: 400
        };
      }
      
      // Check if end time is aligned to interval boundary
      const endMinute = end.minute;
      const endSecond = end.second;
      if (endSecond !== 0 || endMinute % intervalMinutes !== 0) {
        return {
          isValid: false,
          error: `End time must be aligned to ${intervalMinutes}-minute boundaries (e.g., HH:00:00, HH:${intervalMinutes.toString().padStart(2, '0')}:00)`,
          statusCode: 400
        };
      }
      
      timeDiff = getTimeDifferenceMs(start, end);
      break;
    }
    
    default:
      return {
        isValid: false,
        error: `Unsupported interval: ${interval}`,
        statusCode: 400
      };
  }
  
  // Check time range limits
  const limits = {
    '5m': { duration: 7.5 * 24 * 60 * 60 * 1000, label: '7.5 days' },
    '30m': { duration: 30 * 24 * 60 * 60 * 1000, label: '30 days' },
    '1d': { duration: 13 * 30 * 24 * 60 * 60 * 1000, label: '13 months' }
  };
  
  const { duration: maxDuration, label: maxDurationLabel } = limits[interval];
  
  if (timeDiff > maxDuration) {
    return {
      isValid: false,
      error: `Time range exceeds maximum of ${maxDurationLabel} for ${interval} interval`,
      statusCode: 400
    };
  }
  
  return { isValid: true };
}

// ============================================================================
// Data Fetching
// ============================================================================

async function fetchHistoryData(
  system: typeof systems.$inferSelect,
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: '5m' | '30m' | '1d',
  systemTimezoneOffsetMin: number
): Promise<any[]> {
  // Check if this is a craighack system that needs special handling
  if (system.vendorType === 'craighack') {
    return await fetchCraighackHistory(
      system.id,
      startTime,
      endTime,
      interval,
      systemTimezoneOffsetMin
    );
  }
  
  // Normal system - fetch data directly
  switch (interval) {
    case '1d': {
      const start = startTime as CalendarDate;
      const end = endTime as CalendarDate;
      return await fetch1DayData(system.id, start, end);
    }
    
    case '30m': {
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;
      return await fetch30MinuteData(system.id, start, end, systemTimezoneOffsetMin);
    }
    
    case '5m': {
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;
      return await fetch5MinuteData(system.id, start, end, systemTimezoneOffsetMin);
    }
    
    default:
      // This should never happen due to earlier validation
      throw new Error(`Unsupported interval: ${interval}`);
  }
}

// ============================================================================
// Data Series Creation
// ============================================================================

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

function buildDataSeries(
  fields: string[],
  processedData: any[],
  interval: '5m' | '30m' | '1d',
  remoteSystemIdentifier: string,
  startStr: string,
  lastStr: string
): OpenNEMDataSeries[] {
  const dataSeries: OpenNEMDataSeries[] = [];
  
  if (processedData.length === 0) {
    return dataSeries;
  }
  
  // Solar field
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
      interval
    ));
    
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
        interval
      ));
    }
  }
  
  // Load field
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
      interval
    ));
    
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
        interval
      ));
    }
  }
  
  // Battery field
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
      interval
    ));
    
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
      interval
    ));
    
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
        interval
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
        interval
      ));
    }
  }
  
  // Grid field
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
      interval
    ));
  }
  
  return dataSeries;
}

// ============================================================================
// Response Building
// ============================================================================

function buildResponse(
  dataSeries: OpenNEMDataSeries[],
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: '5m' | '30m' | '1d'
): NextResponse {
  // Format date strings based on interval type
  let requestStartStr: string;
  let requestEndStr: string;
  
  switch (interval) {
    case '1d':
      requestStartStr = formatDateAEST(startTime as CalendarDate);
      requestEndStr = formatDateAEST(endTime as CalendarDate);
      break;
      
    case '30m':
    case '5m':
      requestStartStr = formatTimeAEST(startTime as ZonedDateTime);
      requestEndStr = formatTimeAEST(endTime as ZonedDateTime);
      break;
      
    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }
  
  const response: OpenNEMResponse = {
    type: 'energy',
    version: 'v4.1',
    network: 'liveone',
    created_at: formatTimeAEST(now('Australia/Brisbane')),
    requestStart: requestStartStr,
    requestEnd: requestEndStr,
    data: dataSeries
  };
  
  const jsonStr = formatOpenNEMResponse(response);
  
  return new NextResponse(jsonStr, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

// ============================================================================
// Combined History Data Function
// ============================================================================

async function getSystemHistoryInOpenNEMFormat(
  system: SystemAccess['system'],
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: '5m' | '30m' | '1d',
  fields: string[]
): Promise<OpenNEMDataSeries[]> {
  // Step 6: Fetch data
  const systemTimezoneOffsetMin = system.timezoneOffsetMin;
  const processedData = await fetchHistoryData(
    system,
    startTime,
    endTime,
    interval,
    systemTimezoneOffsetMin
  );
  
  // Step 7: Build data series
  const remoteSystemIdentifier = `${system.vendorType}.${system.vendorSiteId}`;
  
  // Format date strings for data series
  let startStr: string;
  let lastStr: string;
  
  switch (interval) {
    case '1d':
      startStr = formatDateAEST(startTime as CalendarDate);
      lastStr = formatDateAEST(endTime as CalendarDate);
      break;
      
    case '30m':
    case '5m':
      startStr = formatTimeAEST(startTime as ZonedDateTime);
      lastStr = formatTimeAEST(endTime as ZonedDateTime);
      break;
      
    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }
  
  const dataSeries = buildDataSeries(
    fields,
    processedData,
    interval,
    remoteSystemIdentifier,
    startStr,
    lastStr
  );
  
  return dataSeries;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function GET(request: NextRequest) {
  try {
    // Step 1: Authentication
    const authResult = await authenticateUser();
    if (authResult instanceof NextResponse) {
      return authResult;
    }
    
    // Step 2: Parse basic parameters
    const searchParams = request.nextUrl.searchParams;
    const basicParams = parseBasicParams(searchParams);
    if (!basicParams.isValid) {
      return NextResponse.json(
        { error: basicParams.error },
        { status: basicParams.statusCode! }
      );
    }
    
    // Step 3: Check system access
    const systemAccess = await checkSystemAccess(
      basicParams.systemId!,
      authResult.userId,
      authResult.isAdmin
    );
    if (systemAccess instanceof NextResponse) {
      return systemAccess;
    }
    
    const { system } = systemAccess;
    
    // Step 4: Parse time range
    const timeRange = parseTimeRangeParams(
      searchParams,
      basicParams.interval as '5m' | '30m' | '1d',
      system.timezoneOffsetMin
    );
    if (!timeRange.isValid) {
      return NextResponse.json(
        { error: timeRange.error },
        { status: timeRange.statusCode! }
      );
    }
    
    // Step 5: Validate time range
    const validation = validateTimeRange(
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as '5m' | '30m' | '1d'
    );
    if (!validation.isValid) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.statusCode! }
      );
    }
    
    // Steps 6 & 7: Fetch data and build data series
    const dataSeries = await getSystemHistoryInOpenNEMFormat(
      system,
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as '5m' | '30m' | '1d',
      basicParams.fields!
    );
    
    // Step 8: Build and return response
    return buildResponse(
      dataSeries,
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as '5m' | '30m' | '1d'
    );
    
  } catch (error) {
    console.error('Error fetching historical data:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}