import { NextRequest, NextResponse } from "next/server";
import { SystemsManager } from "@/lib/systems-manager";
import {
  updatePollingStatusSuccess,
  updatePollingStatusError,
} from "@/lib/polling-utils";
import { sessionManager } from "@/lib/session-manager";
import { PointManager, type SessionInfo } from "@/lib/point/point-manager";
import { FUSHER_POINTS } from "@/lib/vendors/fusher/point-metadata";
import { getSystemCredentials } from "@/lib/secure-credentials";

/**
 * Expected request body for Fusher (Fronius Pusher) push data
 * Contains all CommonPollingData fields except totals
 */
export interface FusherPushData {
  // Authentication and identification
  apiKey: string; // API key for authentication (validated against Clerk credentials)
  siteId?: string; // Site identifier (matches vendor_site_id in database). Defaults to "kinkora" if not provided.
  action: "test" | "store"; // Action to perform: 'test' for auth check, 'store' to save data

  // Timestamp and sequence (required for 'store' action)
  timestamp?: string;
  sequence?: string; // Required unique sequence identifier for 'store' action

  // Power readings (Watts) - instantaneous values
  solarW?: number | null;
  solarLocalW?: number | null; // Local solar from shunt/CT
  solarRemoteW?: number | null; // Remote solar from inverter
  loadW?: number | null;
  batteryW?: number | null;
  gridW?: number | null;

  // Battery state
  batterySOC?: number | null; // State of charge (0-100%)

  // System status
  faultCode?: string | null;
  faultTimestamp?: string | null; // ISO8601 timestamp of fault
  generatorStatus?: number | null;

  // Energy counters (Wh) - interval values (energy in this period)
  solarWhInterval?: number | null;
  loadWhInterval?: number | null;
  batteryInWhInterval?: number | null;
  batteryOutWhInterval?: number | null;
  gridInWhInterval?: number | null;
  gridOutWhInterval?: number | null;
}

// Removed validateApiKey function - we now use apiKey as the site identifier

// Helper function to record failed sessions
async function recordFailedSession(
  sessionStart: Date,
  systemId: number,
  errorCode: string | null,
  error: string,
  requestData: any,
  sessionLabel?: string,
) {
  const duration = Date.now() - sessionStart.getTime();
  await sessionManager.recordSession({
    sessionLabel,
    systemId,
    cause: "PUSH",
    started: sessionStart,
    duration,
    successful: false,
    errorCode,
    error,
    response: requestData,
    numRows: 0,
  });
}

export async function POST(request: NextRequest) {
  const sessionStart = new Date();

  try {
    // Parse JSON directly
    const data: FusherPushData = await request.json();

    // Validate required fields
    if (!data.apiKey) {
      return NextResponse.json({ error: "Missing apiKey" }, { status: 400 });
    }

    if (!data.action || (data.action !== "test" && data.action !== "store")) {
      return NextResponse.json(
        { error: 'Missing or invalid action. Must be "test" or "store"' },
        { status: 400 },
      );
    }

    // For 'store' action, validate additional required fields
    if (data.action === "store") {
      if (!data.timestamp) {
        return NextResponse.json(
          { error: "Missing timestamp (required for store action)" },
          { status: 400 },
        );
      }

      if (!data.sequence) {
        return NextResponse.json(
          { error: "Missing sequence (required for store action)" },
          { status: 400 },
        );
      }
    }

    // Get SystemsManager instance
    const systemsManager = SystemsManager.getInstance();

    // Use siteId to find system, defaulting to "kinkora" for backwards compatibility
    const siteId = data.siteId || "kinkora";

    // Find the system by vendorSiteId
    const system = await systemsManager.getSystemByVendorSiteId(siteId);

    if (!system) {
      console.error(`[Fusher Push] System not found for siteId: ${siteId}`);
      // Note: Cannot record session without valid system (requires JOIN with systems table)
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Verify it's a Fusher system (accept both "fusher" and legacy "fronius")
    if (system.vendorType !== "fusher" && system.vendorType !== "fronius") {
      console.error(
        `[Fusher Push] System ${system.id} is not a Fusher system (type: ${system.vendorType})`,
      );

      await recordFailedSession(
        sessionStart,
        system.id,
        "400",
        `System is configured as ${system.vendorType}, not fusher`,
        { action: data.action, siteId },
      );

      return NextResponse.json(
        { error: "System is not configured as Fusher type" },
        { status: 400 },
      );
    }

    // Validate API key against Clerk credentials
    if (!system.ownerClerkUserId) {
      console.error(
        `[Fusher Push] System ${system.id} has no owner - cannot validate credentials`,
      );
      return NextResponse.json(
        { error: "System has no owner configured" },
        { status: 500 },
      );
    }

    const credentials = await getSystemCredentials(
      system.ownerClerkUserId,
      system.id,
    );

    // Accept both "fusher" and legacy "fronius" credentials
    if (
      !credentials ||
      (credentials.vendorType !== "fusher" &&
        credentials.vendorType !== "fronius")
    ) {
      console.error(
        `[Fusher Push] No Fusher credentials found for system ${system.id}`,
      );
      await recordFailedSession(
        sessionStart,
        system.id,
        "401",
        "No credentials configured for this system",
        { action: data.action, siteId },
      );
      return NextResponse.json(
        { error: "No credentials configured for this system" },
        { status: 401 },
      );
    }

    if (credentials.apiKey !== data.apiKey) {
      console.error(
        `[Fusher Push] Invalid API key for system ${system.id} (${system.displayName})`,
      );
      await recordFailedSession(
        sessionStart,
        system.id,
        "401",
        "Invalid API key",
        { action: data.action, siteId },
      );
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    // If action is 'test', return success without storing data
    if (data.action === "test") {
      console.log(
        `[Fusher Push] Test authentication successful for system ${system.id} (${system.displayName})`,
      );

      // Record successful test session
      const duration = Date.now() - sessionStart.getTime();
      await sessionManager.recordSession({
        systemId: system.id,
        cause: "PUSH",
        started: sessionStart,
        duration,
        successful: true,
        response: { action: "test", siteId },
        numRows: 0,
      });

      return NextResponse.json({
        success: true,
        action: "test",
        message: "Authentication successful",
        systemId: system.id,
        displayName: system.displayName,
      });
    }

    // For 'store' action, proceed with data storage
    // Calculate timestamps and delay
    const inverterTime = new Date(data.timestamp!);
    const receivedTime = new Date();
    const delaySeconds = Math.floor(
      (receivedTime.getTime() - inverterTime.getTime()) / 1000,
    );

    // Log the push
    console.log(
      `[Fusher Push] Received data for system ${system.id} (${system.displayName})`,
    );
    console.log(
      `[Fusher Push] Timestamp: ${data.timestamp}, Sequence: ${data.sequence}, Delay: ${delaySeconds}s`,
    );
    console.log(
      `[Fusher Push] Power - Solar: ${data.solarW}W (Local: ${data.solarLocalW}W, Remote: ${data.solarRemoteW}W), Load: ${data.loadW}W, Battery: ${data.batteryW}W, Grid: ${data.gridW}W`,
    );

    // Create session record - required for inserting readings
    let session: SessionInfo;
    try {
      session = await sessionManager.createSession({
        sessionLabel: data.sequence,
        systemId: system.id,
        cause: "PUSH",
        started: sessionStart,
      });
    } catch (sessionError) {
      console.error("[Fusher Push] Failed to create session:", sessionError);
      return NextResponse.json(
        { error: "Failed to create session" },
        { status: 500 },
      );
    }

    try {
      // Insert into point_readings table
      const measurementTime = inverterTime.getTime();
      const readingsToInsert = [];

      // Build readings array from all configured points
      for (const pointConfig of FUSHER_POINTS) {
        const field = pointConfig.field as keyof FusherPushData;
        const rawValue = data[field];

        // Skip null/undefined values and non-data fields
        if (
          rawValue == null ||
          field === "apiKey" ||
          field === "action" ||
          field === "timestamp" ||
          field === "sequence"
        ) {
          continue;
        }

        readingsToInsert.push({
          pointMetadata: pointConfig.metadata,
          rawValue,
          measurementTime,
          dataQuality: "good" as const,
          error: null,
        });
      }

      // Batch insert all readings - this will automatically ensure point_info entries exist
      if (readingsToInsert.length > 0) {
        await PointManager.getInstance().insertPointReadingsBatch(
          system.id,
          session,
          readingsToInsert,
        );
        console.log(
          `[Fusher Push] Inserted ${readingsToInsert.length} point readings for system ${system.id}`,
        );
      }

      // Update polling status to show successful data receipt
      // Store the parsed JSON object
      await updatePollingStatusSuccess(system.id, data);

      // Update session with success
      const duration = Date.now() - sessionStart.getTime();
      await sessionManager.updateSessionResult(session.id, {
        duration,
        successful: true,
        response: data,
        numRows: readingsToInsert.length,
      });

      console.log(
        `[Fusher Push] Successfully stored data for system ${system.id}`,
      );

      return NextResponse.json({
        success: true,
        action: "store",
        message: "Data received and stored",
        systemId: system.id,
        timestamp: inverterTime.toISOString(),
        delaySeconds,
      });
    } catch (dbError) {
      console.error(
        `[Fusher Push] Database error for system ${system.id}:`,
        dbError,
      );

      // Update polling status with error
      await updatePollingStatusError(
        system.id,
        dbError instanceof Error ? dbError : "Database error",
      );

      // Update session with error
      const errorMessage =
        dbError instanceof Error ? dbError.message : String(dbError);
      const isDuplicate = errorMessage.includes("UNIQUE constraint failed");
      const duration = Date.now() - sessionStart.getTime();

      await sessionManager.updateSessionResult(session.id, {
        duration,
        successful: false,
        errorCode: isDuplicate ? "409" : null,
        error: errorMessage,
        response: data,
        numRows: 0,
      });

      // Check if it's a duplicate entry error
      if (isDuplicate) {
        return NextResponse.json(
          {
            success: false,
            error: "Duplicate timestamp - data already exists for this time",
            timestamp: inverterTime.toISOString(),
          },
          { status: 409 }, // Conflict
        );
      }

      throw dbError; // Re-throw for generic error handling
    }
  } catch (error) {
    console.error("[Fusher Push] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}

// Also support GET for testing/health check
export async function GET() {
  return NextResponse.json({
    status: "ready",
    endpoint: "/api/push/fusher",
    method: "POST",
    requiredFields: {
      always: ["apiKey", "action"], // apiKey for authentication, action is 'test' or 'store'
      forStoreAction: ["timestamp", "sequence"],
      optional: [
        "siteId", // Identifies the system (defaults to "kinkora" if not provided)
        "solarW",
        "solarLocalW",
        "solarRemoteW",
        "loadW",
        "batteryW",
        "gridW",
        "batterySOC",
        "faultCode",
        "faultTimestamp",
        "generatorStatus",
        "solarWhInterval",
        "loadWhInterval",
        "batteryInWhInterval",
        "batteryOutWhInterval",
        "gridInWhInterval",
        "gridOutWhInterval",
      ],
    },
    note: 'apiKey is validated against Clerk credentials. siteId identifies the system (matches vendor_site_id). Use action="test" to validate authentication, action="store" to save data.',
  });
}
