import { NextRequest, NextResponse } from "next/server";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { requireAuth } from "@/lib/api-auth";
import { eq, desc } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { storeDeviceCredentials } from "@/lib/secure-credentials";
import { VendorRegistry } from "@/lib/vendors/registry";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { specFromLegacyText } from "@/lib/capabilities/config";

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    // Get request data
    const { vendorType, credentials, deviceInfo } = await request.json();

    // Handle regular devices
    if (!credentials || !deviceInfo?.vendorSiteId) {
      return NextResponse.json(
        {
          error: "Credentials and system info with vendorSiteId are required",
        },
        { status: 400 },
      );
    }

    // Get the vendor adapter to verify it's supported
    const adapter = VendorRegistry.getAdapter(vendorType);

    if (!adapter) {
      return NextResponse.json(
        { error: `Unknown vendor type: ${vendorType}` },
        { status: 400 },
      );
    }

    if (!adapter.supportsAddDevice) {
      return NextResponse.json(
        {
          error: `${adapter.displayName} does not support automatic system addition`,
        },
        { status: 400 },
      );
    }

    console.log(
      `[Create System] Creating ${vendorType} system for user ${userId}`,
    );

    // Allow multiple devices for the same vendor site
    // This is useful for testing, multiple users monitoring the same site, etc.

    const newDevice = await DeviceWriter.createDevice({
      ownerClerkUserId: userId,
      vendorType,
      vendorSiteId: deviceInfo.vendorSiteId,
      status: "active",
      displayName: deviceInfo.displayName || `${adapter.displayName} System`,
      model: deviceInfo.model || null,
      serial: deviceInfo.serial || null,
      // Slice 1a: the adapter still reports the vendor's free-text ratings/sizes, but `devices` has no
      // counterpart to those three columns by design — they are parsed into the structured
      // `config.spec` here instead of being staged in `systems` for the mirror's SQL to parse. Same
      // parse, same rejection rules; see `specFromLegacyText`.
      config: (() => {
        const spec = specFromLegacyText({
          ratings: deviceInfo.ratings,
          solarSize: deviceInfo.solarSize,
          batterySize: deviceInfo.batterySize,
        });
        return spec ? { spec } : null;
      })(),
      timezoneOffsetMin: 600, // Default to AEST
    });

    // Store the credentials in Clerk
    const credentialResult = await storeDeviceCredentials(
      userId,
      newDevice.id,
      vendorType,
      credentials,
    );

    if (!credentialResult.success) {
      // If credential storage failed, delete the system.
      // Routed through the `systems` writer so the rollback matches the insert.
      await DeviceWriter.deleteDevice(newDevice.id);

      return NextResponse.json(
        { error: credentialResult.error || "Failed to store credentials" },
        { status: 500 },
      );
    }

    // Success!
    return NextResponse.json({
      success: true,
      systemId: newDevice.id,
    });
  } catch (error) {
    console.error("[Create System] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create system",
      },
      { status: 500 },
    );
  }
}

// GET endpoint to list user's devices
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    // Get all devices for this user. config-v4 slice K2: reads `devices`; the payload is now the
    // `DeviceRecord` shape (v4 identity added, the three free-text spec strings gone — they are
    // `config.spec`). No in-repo consumer reads this listing, so the shape change is contained.
    const userDevices = (
      await DeviceConfigRegistry.devicesByOwner(userId)
    ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return NextResponse.json({
      devices: userDevices,
    });
  } catch (error) {
    console.error("[List Systems] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch systems",
      },
      { status: 500 },
    );
  }
}
