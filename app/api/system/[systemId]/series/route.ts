import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { PointManager } from "@/lib/point/point-manager";
import { splitBraceAware } from "@/lib/series-filter-utils";

/**
 * Validate a glob pattern for series filtering
 * Returns validation result with detailed error if invalid
 */
function validatePattern(pattern: string): {
  valid: boolean;
  error?: string;
  details?: string;
} {
  // Check length
  if (pattern.length === 0) {
    return {
      valid: false,
      error: "Empty pattern",
      details: "Pattern cannot be empty",
    };
  }

  if (pattern.length > 200) {
    return {
      valid: false,
      error: "Pattern too long",
      details: `Pattern length ${pattern.length} exceeds maximum of 200 characters`,
    };
  }

  // Check for invalid characters (micromatch is safe, but let's be defensive)
  // Allow: alphanumeric, dots, slashes, wildcards, braces, commas, underscores, hyphens
  const validChars = /^[a-zA-Z0-9.\/*{},_-]+$/;
  if (!validChars.test(pattern)) {
    const invalidChars = pattern
      .split("")
      .filter((c) => !validChars.test(c))
      .join("");
    return {
      valid: false,
      error: "Invalid characters in pattern",
      details: `Pattern contains invalid characters: "${invalidChars}". Only alphanumeric, dots, slashes, wildcards (*), braces ({}), commas, underscores, and hyphens are allowed.`,
    };
  }

  // Check for unmatched braces
  let braceDepth = 0;
  for (const char of pattern) {
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (braceDepth < 0) {
      return {
        valid: false,
        error: "Unmatched closing brace",
        details: `Pattern has unmatched '}' brace`,
      };
    }
  }
  if (braceDepth !== 0) {
    return {
      valid: false,
      error: "Unmatched opening brace",
      details: `Pattern has ${braceDepth} unmatched '{' brace(s)`,
    };
  }

  return { valid: true };
}

/**
 * GET /api/system/{systemId}/series
 *
 * Returns all available series for a system with database mapping information
 * Supports optional filtering by glob patterns and interval
 *
 * @param systemId - Numeric system ID
 * @param filter - Optional comma-separated glob patterns to filter series (e.g., "source.solar/*,bidi.battery/*")
 * @param interval - Optional interval to filter by ("5m" or "1d")
 *
 * Examples:
 * - GET /api/system/3/series
 *   Returns all series for system 3
 *
 * - GET /api/system/3/series?interval=5m
 *   Returns only series that support 5m interval
 *
 * - GET /api/system/3/series?filter=source.solar/*,load/*
 *   Returns only series matching the patterns
 *
 * - GET /api/system/3/series?filter=bidi.battery/power.*&interval=5m
 *   Returns battery power series that support 5m interval
 *
 * Response:
 * {
 *   "series": [
 *     {
 *       "id": "system.3/source.solar/power.avg",
 *       "intervals": ["5m", "1d"],
 *       "label": "Solar Power",
 *       "metricUnit": "W",
 *       "systemId": 3,
 *       "pointIndex": 2,
 *       "column": "avg"
 *     }
 *   ]
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    // Parse and validate systemId
    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr, 10);

    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: "Invalid system ID", details: "System ID must be numeric" },
        { status: 400 },
      );
    }

    // Authenticate and authorize
    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;
    const { system } = authResult;

    // Parse and validate query parameters
    const { searchParams } = new URL(request.url);
    const filterParam = searchParams.get("filter");
    const intervalParam = searchParams.get("interval");

    // Validate interval parameter if provided
    let interval: "5m" | "1d" | undefined;
    if (intervalParam) {
      if (intervalParam !== "5m" && intervalParam !== "1d") {
        return NextResponse.json(
          {
            error: "Invalid interval parameter",
            details: `Interval must be "5m" or "1d", got "${intervalParam}"`,
            validValues: ["5m", "1d"],
          },
          { status: 400 },
        );
      }
      interval = intervalParam as "5m" | "1d";
    }

    // Validate filter patterns if provided
    let filter: string[] | undefined;
    if (filterParam) {
      // Split by comma (brace-aware) to get individual patterns
      const rawPatterns = splitBraceAware(filterParam);

      if (rawPatterns.length === 0) {
        return NextResponse.json(
          {
            error: "Invalid filter parameter",
            details: "Filter parameter is empty or contains only whitespace",
          },
          { status: 400 },
        );
      }

      // Validate each pattern
      for (const pattern of rawPatterns) {
        const validation = validatePattern(pattern);
        if (!validation.valid) {
          return NextResponse.json(
            {
              error: validation.error,
              details: validation.details,
              invalidPattern: pattern,
            },
            { status: 400 },
          );
        }
      }

      filter = rawPatterns;
    }

    // Get filtered series for the system
    const pointManager = PointManager.getInstance();
    const seriesInfos = await pointManager.getSeriesForSystem(
      system,
      filter,
      interval,
    );

    // Transform SeriesInfo[] to response format
    const series = seriesInfos.map((seriesInfo) => {
      const seriesPath = `${seriesInfo.systemIdentifier.toString()}/${seriesInfo.point.getPath()}.${seriesInfo.aggregationField}`;

      return {
        id: seriesPath,
        intervals: seriesInfo.intervals,
        label: seriesInfo.point.name,
        metricUnit: seriesInfo.point.metricUnit,
        systemId: seriesInfo.point.systemId,
        pointIndex: seriesInfo.point.index,
        column: seriesInfo.aggregationField,
      };
    });

    return NextResponse.json({ series });
  } catch (error) {
    console.error("Error fetching series:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
