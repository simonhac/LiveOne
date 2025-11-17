import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { VendorRegistry } from "@/lib/vendors/registry";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { getSystemCredentials } from "@/lib/secure-credentials";
import { sessionManager } from "@/lib/session-manager";
import type { SystemWithPolling } from "@/lib/systems-manager";

export async function POST(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get request data
    const { vendorType, credentials, systemId } = await request.json();

    // Check if user is admin
    const isAdmin = await isUserAdmin();

    let finalCredentials = credentials;
    let finalVendorType = vendorType;
    let finalOwnerUserId = userId;
    let vendorSiteId = "";
    let system: any = null; // Define system variable at outer scope

    // Use case 1: Testing a new system with provided credentials
    if (credentials && vendorType) {
      console.log(
        `[Test Connection] Testing new ${vendorType} system with provided credentials`,
      );
      // Use provided credentials and vendorType as-is
    }
    // Use case 2: Testing an existing system by systemId
    else if (systemId) {
      // Use SystemsManager to get the system
      const manager = SystemsManager.getInstance();
      system = await manager.getSystem(systemId);

      if (!system) {
        return NextResponse.json(
          { error: `System ${systemId} not found` },
          { status: 404 },
        );
      }

      // Check authorization - admins can test any system, users can only test their own
      if (system.ownerClerkUserId !== userId && !isAdmin) {
        return NextResponse.json(
          { error: "You can only test your own systems" },
          { status: 403 },
        );
      }

      finalOwnerUserId = system.ownerClerkUserId;
      finalVendorType = system.vendorType;
      vendorSiteId = system.vendorSiteId;

      // Get credentials for the system
      finalCredentials = await getSystemCredentials(
        system.ownerClerkUserId,
        systemId,
      );

      console.log(
        `[Test Connection] ${isAdmin && system.ownerClerkUserId !== userId ? "Admin" : "User"} testing existing ${finalVendorType} system ${systemId}`,
      );

      if (!finalCredentials) {
        return NextResponse.json(
          { error: `No ${finalVendorType} credentials found for this system` },
          { status: 404 },
        );
      }
    }
    // No valid input provided
    else {
      return NextResponse.json(
        {
          error:
            "Either provide credentials and vendorType for new system, or systemId for existing system",
        },
        { status: 400 },
      );
    }

    if (!finalVendorType) {
      return NextResponse.json(
        { error: "Could not determine vendor type" },
        { status: 400 },
      );
    }

    // Get the vendor adapter
    const adapter = VendorRegistry.getAdapter(finalVendorType);

    if (!adapter) {
      return NextResponse.json(
        { error: `Unknown vendor type: ${finalVendorType}` },
        { status: 400 },
      );
    }

    // Only check supportsAddSystem for new systems (not testing existing systems)
    if (!systemId && !adapter.supportsAddSystem) {
      return NextResponse.json(
        {
          error: `${adapter.displayName} does not support automatic system addition`,
        },
        { status: 400 },
      );
    }

    console.log(
      `[Test Connection] Testing ${finalVendorType} for user ${finalOwnerUserId}`,
    );

    // Create a temporary system object for the adapter to use
    const tempSystem: SystemWithPolling = {
      id: systemId || -1, // Use real ID if testing existing system
      vendorType: finalVendorType,
      vendorSiteId: vendorSiteId || "", // Use existing vendorSiteId or let adapter discover
      ownerClerkUserId: finalOwnerUserId,
      status: "active",
      displayName: "Test System",
      alias: null,
      model: null,
      serial: null,
      ratings: null,
      solarSize: null,
      batterySize: null,
      location: null,
      metadata: null,
      timezoneOffsetMin: 600, // Default to AEST, adapter can override
      displayTimezone: null, // No display timezone for test system
      createdAt: new Date(),
      updatedAt: new Date(),
      pollingStatus: null, // No polling status for test
    };

    console.log(`[Test Connection] Using system object:`, {
      id: tempSystem.id,
      vendorType: tempSystem.vendorType,
      vendorSiteId: tempSystem.vendorSiteId,
      hasCredentials: !!finalCredentials,
    });

    // Let the adapter handle the connection test and system discovery
    console.log(
      `[Test Connection] Calling adapter.testConnection for ${finalVendorType}`,
    );

    // Start timing for session recording
    const sessionStart = new Date();
    const result = await adapter.testConnection(tempSystem, finalCredentials);
    const duration = Date.now() - sessionStart.getTime();

    console.log(`[Test Connection] Result:`, {
      success: result.success,
      hasLatestData: !!result.latestData,
      hasSystemInfo: !!result.systemInfo,
      error: result.error,
    });

    // Record session - determine cause based on who initiated
    const sessionCause =
      isAdmin && system?.ownerClerkUserId !== userId ? "ADMIN" : "USER";
    const systemName =
      system?.displayName ||
      tempSystem.displayName ||
      `${finalVendorType} System`;

    await sessionManager.recordSession({
      systemId: systemId || 0, // Use 0 for new systems being tested
      vendorType: finalVendorType,
      systemName,
      cause: sessionCause,
      started: sessionStart,
      duration,
      successful: result.success,
      errorCode: result.errorCode || null,
      error: result.success ? null : result.error || null,
      response: result.vendorResponse,
      numRows: result.latestData ? 1 : 0,
    });

    if (!result.success) {
      console.log(`[Test Connection] Test failed:`, result.error);
      return NextResponse.json(
        { error: result.error || "Connection test failed" },
        { status: 400 },
      );
    }

    // Check if we got data from testConnection
    if (!result.latestData) {
      console.log(
        `[Test Connection] Test succeeded but no latestData returned. Full result:`,
        {
          success: result.success,
          hasSystemInfo: !!result.systemInfo,
          hasLatestData: !!result.latestData,
          hasVendorResponse: !!result.vendorResponse,
          systemInfo: result.systemInfo,
        },
      );
      return NextResponse.json(
        { error: "Connection successful but no data received from system" },
        { status: 400 },
      );
    }

    // Return the discovered system information with latest data
    return NextResponse.json({
      success: true,
      latest: result.latestData,
      systemInfo: result.systemInfo || {},
      vendorResponse: result.vendorResponse, // Optional vendor-specific data
    });
  } catch (error) {
    console.error("[Test Connection] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Connection test failed",
      },
      { status: 500 },
    );
  }
}
