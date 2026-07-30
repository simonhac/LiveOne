import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { VendorRegistry } from "@/lib/vendors/registry";
import { isUserAdmin } from "@/lib/auth-utils";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { sessionManager } from "@/lib/session-manager";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import type { DeviceConfigView } from "@/lib/registry/device-config";

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
    let device: any = null; // Define device variable at outer scope

    // Use case 1: Testing a new device with provided credentials
    if (credentials && vendorType) {
      console.log(
        `[Test Connection] Testing new ${vendorType} system with provided credentials`,
      );
      // Use provided credentials and vendorType as-is
    }
    // Use case 2: Testing an existing device by systemId
    else if (systemId) {
      device = await DeviceConfigRegistry.deviceByHandle(systemId);

      if (!device) {
        return NextResponse.json(
          { error: `System ${systemId} not found` },
          { status: 404 },
        );
      }

      // Check authorization - admins can test any device, users can only test their own
      if (device.ownerClerkUserId !== userId && !isAdmin) {
        return NextResponse.json(
          { error: "You can only test your own systems" },
          { status: 403 },
        );
      }

      finalOwnerUserId = device.ownerClerkUserId;
      finalVendorType = device.vendorType;
      vendorSiteId = device.vendorSiteId;

      // Get credentials for the device
      finalCredentials = await getDeviceCredentials(
        device.ownerClerkUserId,
        systemId,
      );

      console.log(
        `[Test Connection] ${isAdmin && device.ownerClerkUserId !== userId ? "Admin" : "User"} testing existing ${finalVendorType} system ${systemId}`,
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

    // Only check supportsAddDevice for new devices (not testing existing devices)
    if (!systemId && !adapter.supportsAddDevice) {
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

    // Create a temporary device object for the adapter to use
    const tempDevice: DeviceConfigView = {
      id: systemId || -1, // Use real ID if testing existing device
      vendorType: finalVendorType,
      vendorSiteId: vendorSiteId || "", // Use existing vendorSiteId or let adapter discover
      ownerClerkUserId: finalOwnerUserId,
      status: "active",
      displayName: "Test System",
      alias: null,
      model: null,
      serial: null,
      location: null,
      metadata: null,
      config: null,
      timezoneOffsetMin: 600, // Default to AEST, adapter can override
      displayTimezone: "Australia/Melbourne", // Default timezone for test device
      createdAt: new Date(),
      updatedAt: new Date(),
      commissionedOn: null, // transient test device — no vendor commission date
      pollingStatus: null, // No polling status for test
    };

    console.log(`[Test Connection] Using system object:`, {
      id: tempDevice.id,
      vendorType: tempDevice.vendorType,
      vendorSiteId: tempDevice.vendorSiteId,
      hasCredentials: !!finalCredentials,
    });

    // Let the adapter handle the connection test and device discovery
    console.log(
      `[Test Connection] Calling adapter.testConnection for ${finalVendorType}`,
    );

    // Start timing for session recording
    const sessionStart = new Date();
    const result = await adapter.testConnection(tempDevice, finalCredentials);
    const duration = Date.now() - sessionStart.getTime();

    console.log(`[Test Connection] Result:`, {
      success: result.success,
      hasLatestData: !!result.latestData,
      hasDeviceInfo: !!result.deviceInfo,
      error: result.error,
    });

    // Record session only if we have a valid device (required for JOIN with devices table)
    // Skip recording for new device tests (no systemId)
    if (systemId) {
      const sessionCause =
        isAdmin && device?.ownerClerkUserId !== userId ? "ADMIN" : "USER";

      await sessionManager.recordSession({
        systemId,
        cause: sessionCause,
        started: sessionStart,
        duration,
        successful: result.success,
        errorCode: result.errorCode || null,
        error: result.success ? null : result.error || null,
        response: result.vendorResponse,
        numRows: result.latestData ? 1 : 0,
      });
    }

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
          hasDeviceInfo: !!result.deviceInfo,
          hasLatestData: !!result.latestData,
          hasVendorResponse: !!result.vendorResponse,
          deviceInfo: result.deviceInfo,
        },
      );
      return NextResponse.json(
        { error: "Connection successful but no data received from system" },
        { status: 400 },
      );
    }

    // Return the discovered device information with latest data
    return NextResponse.json({
      success: true,
      latest: result.latestData,
      deviceInfo: result.deviceInfo || {},
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
