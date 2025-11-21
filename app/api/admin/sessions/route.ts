import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { sessionManager } from "@/lib/session-manager";

export async function GET(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is an admin
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;

    // Legacy parameters (for backwards compatibility)
    const start = searchParams.get("start");
    const count = searchParams.get("count");
    const last = searchParams.get("last");
    const label = searchParams.get("label");

    // New server-side filtering/sorting parameters
    const systemParam = searchParams.get("system");
    const vendorParam = searchParams.get("vendor");
    const causeParam = searchParams.get("cause");
    const statusParam = searchParams.get("status");
    const timeRangeParam = searchParams.get("timeRange");
    const sortParam = searchParams.get("sort");
    const pageParam = searchParams.get("page");
    const pageSizeParam = searchParams.get("pageSize");

    // If using new query parameters, use querySessions
    if (
      systemParam ||
      vendorParam ||
      causeParam ||
      statusParam ||
      timeRangeParam ||
      sortParam ||
      pageParam
    ) {
      // Parse filters
      const systemIds = systemParam
        ? systemParam.split(",").map((id) => parseInt(id))
        : undefined;
      const vendorTypes = vendorParam ? vendorParam.split(",") : undefined;
      const causes = causeParam ? causeParam.split(",") : undefined;
      const successful = statusParam
        ? statusParam.split(",").map((s) => s === "success")
        : undefined;

      // Parse time range (24h, 3d, 7d, 30d)
      let timeRangeHours: number | undefined;
      if (timeRangeParam) {
        const rangeMap: Record<string, number> = {
          "24h": 24,
          "3d": 72,
          "7d": 168,
          "30d": 720,
        };
        timeRangeHours = rangeMap[timeRangeParam];
      }

      // Parse sort (format: "field.direction")
      let sortBy:
        | "started"
        | "duration"
        | "systemName"
        | "vendorType"
        | "cause"
        | "numRows" = "started";
      let sortOrder: "asc" | "desc" = "desc";
      if (sortParam) {
        const [field, direction] = sortParam.split(".");
        if (
          field === "started" ||
          field === "duration" ||
          field === "systemName" ||
          field === "vendorType" ||
          field === "cause" ||
          field === "numRows"
        ) {
          sortBy = field;
        }
        if (direction === "asc" || direction === "desc") {
          sortOrder = direction;
        }
      }

      // Parse pagination
      const page = pageParam ? parseInt(pageParam) : 0;
      const pageSize = pageSizeParam ? parseInt(pageSizeParam) : 100;

      // Query sessions
      const result = await sessionManager.querySessions({
        systemIds,
        vendorTypes,
        causes,
        successful,
        timeRangeHours,
        sortBy,
        sortOrder,
        page,
        pageSize,
        includeTotalCount: true,
      });

      // Format dates to ISO strings for JSON response
      const formattedSessions = result.sessions.map((session) => ({
        ...session,
        started: session.started.toISOString(),
        createdAt: session.createdAt.toISOString(),
      }));

      return NextResponse.json({
        success: true,
        sessions: formattedSessions,
        totalCount: result.totalCount,
        page: result.page,
        pageSize: result.pageSize,
      });
    }

    // Legacy API (backwards compatibility)
    let result;

    if (label) {
      // Get sessions by label
      result = await sessionManager.getSessionsByLabel(label);
    } else if (last) {
      // Get the last N sessions
      const lastCount = Math.min(parseInt(last), 200);
      result = await sessionManager.getLastSessions(lastCount);
    } else if (start && count) {
      // Get sessions starting from a specific ID
      const startId = parseInt(start);
      const sessionCount = Math.min(parseInt(count), 200);
      result = await sessionManager.getSessions(startId, sessionCount);
    } else {
      // Default: get last 200 sessions
      result = await sessionManager.getLastSessions(200);
    }

    // Format dates to ISO strings for JSON response
    const formattedSessions = result.sessions.map((session) => ({
      ...session,
      started: session.started.toISOString(),
      createdAt: session.createdAt.toISOString(),
    }));

    return NextResponse.json({
      success: true,
      sessions: formattedSessions,
      count: result.count,
    });
  } catch (error) {
    console.error("[API] Error fetching sessions:", error);
    return NextResponse.json(
      { error: "Failed to fetch sessions" },
      { status: 500 },
    );
  }
}
