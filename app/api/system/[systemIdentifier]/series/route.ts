import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { PointManager } from "@/lib/point-manager";
import { resolveSystemFromIdentifier } from "@/lib/series-path-utils";
import { isUserAdmin } from "@/lib/auth-utils";

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
 * GET /api/system/{systemIdentifier}/series
 *
 * Returns all available series for a system with database mapping information
 * Supports optional filtering by glob patterns and interval
 *
 * @param systemIdentifier - Numeric system ID (e.g., "3")
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
 *
 * Error Response (400):
 * {
 *   "error": "Invalid filter pattern",
 *   "details": "Pattern contains invalid characters: \"$\". Only alphanumeric, dots, slashes, wildcards (*), braces ({}), commas, underscores, and hyphens are allowed.",
 *   "invalidPattern": "source.solar/$"
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemIdentifier: string }> },
) {
  try {
    // Step 1: Authenticate
    // In development, allow using X-CLAUDE header to bypass auth
    let userId: string;
    let isAdmin = false;

    if (
      process.env.NODE_ENV === "development" &&
      request.headers.get("x-claude") === "true"
    ) {
      userId = "claude-dev";
      isAdmin = true;
    } else {
      const authResult = await auth();
      if (!authResult.userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      userId = authResult.userId;
      // Check if user is admin using proper auth utils
      isAdmin = await isUserAdmin(userId);
    }

    // Step 2: Resolve systemIdentifier to system
    const { systemIdentifier } = await params;
    const system = await resolveSystemFromIdentifier(systemIdentifier);

    if (!system) {
      return NextResponse.json(
        { error: `System not found: ${systemIdentifier}` },
        { status: 404 },
      );
    }

    // Step 3: Check authorization
    if (!isAdmin && system.ownerClerkUserId !== userId) {
      return NextResponse.json(
        { error: "Forbidden: You do not have access to this system" },
        { status: 403 },
      );
    }

    // Step 4: Parse and validate query parameters
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
      // Split by comma to get individual patterns
      const rawPatterns = filterParam
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

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

    // Step 5: Get filtered series for the system
    const pointManager = PointManager.getInstance();
    const series = await pointManager.getFilteredSeriesForSystem(
      system.id,
      filter,
      interval,
    );

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
