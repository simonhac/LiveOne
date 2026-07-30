import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

async function getUserDisplay(userId: string): Promise<string> {
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    const identifier =
      user.username || user.emailAddresses[0]?.emailAddress || "unknown";
    return `${userId} (${identifier})`;
  } catch {
    return userId;
  }
}

export async function POST(request: NextRequest) {
  console.log("ENPHASE: Disconnect endpoint called");

  try {
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      console.log("ENPHASE: Unauthorized disconnect attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userDisplay = await getUserDisplay(userId);
    console.log("ENPHASE: User disconnecting Enphase:", userDisplay);

    // Note: We don't clear tokens anymore - devices are just marked as removed
    // and credentials are ignored for removed devices

    // The read is the config registry (`devices`); each Enphase device is then marked removed through
    // the `devices` writer, keyed by handle.

    const ownedDevices = await DeviceConfigRegistry.devicesByOwner(userId);
    const enphaseDevices = ownedDevices.filter(
      (s) => s.vendorType === "enphase",
    );

    for (const s of enphaseDevices) {
      await DeviceWriter.updateDevice(s.id, {
        ownerClerkUserId: null,
        status: "removed",
      });
    }

    console.log("ENPHASE: Disconnected successfully for user:", userDisplay);

    return NextResponse.json({
      success: true,
      message: "Enphase system disconnected",
    });
  } catch (error) {
    console.error("ENPHASE: Error in disconnect endpoint:", error);
    return NextResponse.json(
      { error: "Failed to disconnect Enphase system" },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  console.log("ENPHASE: Status check endpoint called");

  try {
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ connected: false });
    }

    const searchParams = request.nextUrl.searchParams;
    const systemId = searchParams.get("systemId");

    if (!systemId) {
      return NextResponse.json(
        { error: "systemId parameter required" },
        { status: 400 },
      );
    }

    const device = await DeviceConfigRegistry.deviceByHandle(
      parseInt(systemId),
    );

    if (
      !device ||
      device.ownerClerkUserId !== userId ||
      device.vendorType !== "enphase" ||
      device.status !== "active"
    ) {
      return NextResponse.json({ connected: false });
    }

    // Check if credentials exist for this device
    const credentials = await getDeviceCredentials(userId, device.id);

    return NextResponse.json({
      connected: credentials !== null,
      systemId: device.id,
      deviceName: device.displayName,
      expiresAt: (credentials as any)?.expires_at,
    });
  } catch (error) {
    console.error("ENPHASE: Error checking status:", error);
    return NextResponse.json({ connected: false });
  }
}
