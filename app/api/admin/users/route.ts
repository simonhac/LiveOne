import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/api-auth";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

// Helper function to map device data
function mapDeviceAccess(device: any) {
  return {
    systemId: device.id,
    vendorType: device.vendorType,
    vendorSiteId: device.vendorSiteId,
    displayName: device.displayName,
    status: device.status,
  };
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    // Devices are listed by OWNERSHIP only. There used to be a second leg here — a full-table
    // `user_systems innerJoin systems` that contributed extra (device, role) pairs and extra user ids.
    // That table died in migration 0045 (slice F), so a user who appeared ONLY via a grant no longer
    // appears at all, and every listed device is one the user owns (hence no `role` field).
    const allDevices = await DeviceConfigRegistry.allDevices();

    const uniqueUserIds = [
      ...new Set(
        allDevices
          .map((s) => s.ownerClerkUserId)
          .filter((id): id is string => id !== null),
      ),
    ];

    // Fetch user details from Clerk
    const usersData = [];

    for (const clerkUserId of uniqueUserIds) {
      const ownedDevices = allDevices
        .filter((s) => s.ownerClerkUserId === clerkUserId)
        .map(mapDeviceAccess);

      try {
        const client = await clerkClient();
        const clerkUser = await client.users.getUser(clerkUserId);

        // Extract data from private metadata
        let isPlatformAdmin = false;
        if (
          clerkUser.privateMetadata &&
          typeof clerkUser.privateMetadata === "object"
        ) {
          const metadata = clerkUser.privateMetadata as any;
          isPlatformAdmin = metadata.isPlatformAdmin === true;
        }

        usersData.push({
          clerkUserId,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
          username: clerkUser.username,
          createdAt: clerkUser.createdAt,
          lastSignIn: clerkUser.lastSignInAt,
          devices: ownedDevices,
          isPlatformAdmin,
        });
      } catch (err) {
        console.error(`Failed to fetch Clerk user ${clerkUserId}:`, err);
        // Include user even if Clerk fetch fails
        usersData.push({
          clerkUserId,
          email: undefined,
          firstName: undefined,
          lastName: undefined,
          createdAt: new Date().toISOString(),
          lastSignIn: undefined,
          devices: ownedDevices,
        });
      }
    }

    // Sort users by creation date (newest first)
    usersData.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return NextResponse.json({
      success: true,
      users: usersData,
      totalUsers: usersData.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching users data:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch users data",
      },
      { status: 500 },
    );
  }
}
