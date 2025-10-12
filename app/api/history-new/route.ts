import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SystemsManager, SystemWithPolling } from '@/lib/systems-manager';
import { OpenNEMResponse, OpenNEMDataSeries } from '@/types/opennem';
import { formatOpenNEMResponse } from '@/lib/history/format-opennem';
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
import { HistoryService } from '@/lib/history/history-service';
import { isUserAdmin } from '@/lib/auth-utils';

// ============================================================================
// Types and Interfaces
// ============================================================================

interface AuthResult {
  userId: string;
  isAdmin: boolean;
}

interface SystemAccess {
  system: SystemWithPolling;
  hasAccess: boolean;
}

interface ParsedParams {
  systemId: number;
  interval: '5m' | '30m' | '1d';
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
  const systemsManager = SystemsManager.getInstance();

  try {
    const system = await systemsManager.getSystem(systemId);

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
  } catch (error) {
    return NextResponse.json(
      { error: 'System not found' },
      { status: 404 }
    );
  }
}

// ============================================================================
// Parameter Parsing & Validation
// ============================================================================

function parseBasicParams(searchParams: URLSearchParams): ValidationResult & {
  systemId?: number;
  interval?: string;
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

  return {
    isValid: true,
    systemId,
    interval
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
// Data Fetching using new abstraction
// ============================================================================

async function getSystemHistoryInOpenNEMFormat(
  system: SystemWithPolling,
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: '5m' | '30m' | '1d'
): Promise<OpenNEMDataSeries[]> {
  // Special handling for craighack systems (combine systems 2 & 3)
  if (system.vendorType === 'craighack') {
    // Get both systems' data and combine them
    const systemsManager = SystemsManager.getInstance();

    try {
      const system2 = await systemsManager.getSystem(2);
      const system3 = await systemsManager.getSystem(3);

      if (!system2 || !system3) {
        throw new Error('Unable to fetch craighack systems 2 and 3');
      }

      // Select fields based on interval type
      let craighackFields: string[];
      if (interval === '1d') {
        craighackFields = [
          'solar_energy',
          'load_energy',
          'battery_soc_avg', 'battery_soc_min', 'battery_soc_max'
        ];
      } else {
        craighackFields = ['solar', 'load', 'battery', 'grid', 'battery_soc'];
      }

      // Fetch data for both systems
      const [data2, data3] = await Promise.all([
        HistoryService.getHistoryInOpenNEMFormat(
          system2,
          startTime,
          endTime,
          interval,
          craighackFields
        ),
        HistoryService.getHistoryInOpenNEMFormat(
          system3,
          startTime,
          endTime,
          interval,
          craighackFields
        )
      ]);

      // Combine all data
      return [...data2, ...data3];
    } catch (error) {
      console.error('Error fetching craighack data:', error);
      throw error;
    }
  }

  // Select fields based on interval type
  let fields: string[];

  if (interval === '1d') {
    // For daily data, only include energy fields and all SOC variants (no power fields)
    fields = [
      'solar_energy',
      'load_energy',
      'battery_soc_avg', 'battery_soc_min', 'battery_soc_max'
    ];
  } else {
    // For 5m and 30m intervals, use standard power fields
    fields = ['solar', 'load', 'battery', 'grid', 'battery_soc'];
  }

  return HistoryService.getHistoryInOpenNEMFormat(
    system,
    startTime,
    endTime,
    interval,
    fields
  );
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
// Main Handler
// ============================================================================

export async function GET(request: NextRequest) {
  try {
    // Step 1: Authentication
    const authResult = await authenticateUser();
    if (authResult instanceof NextResponse) {
      return authResult;
    }

    // Step 2: Parse basic parameters (no fields parameter needed)
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

    // Step 6: Fetch data using new abstraction
    const dataSeries = await getSystemHistoryInOpenNEMFormat(
      system,
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as '5m' | '30m' | '1d'
    );

    // Step 7: Build and return response
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