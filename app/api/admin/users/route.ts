import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { userSystems, systems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";

// Helper function to map system data
function mapSystemAccess(system: any, role: "owner" | "viewer") {
  return {
    systemId: system.id,
    vendorType: system.vendorType,
    vendorSiteId: system.vendorSiteId,
    displayName: system.displayName,
    status: system.status,
    role,
  };
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    // Get all user-system relationships from userSystems table
    const allUserSystems = await db
      .select()
      .from(userSystems)
      .innerJoin(systems, eq(userSystems.systemId, systems.id));

    // Get all systems to find owners
    const systemsManager = SystemsManager.getInstance();
    const allSystems = await systemsManager.getAllSystems();

    // Get unique user IDs from both userSystems and system owners
    const userIdsFromUserSystems = allUserSystems.map(
      (us) => us.user_systems.clerkUserId,
    );
    const userIdsFromOwners = allSystems
      .map((s) => s.ownerClerkUserId)
      .filter((id) => id !== null) as string[];
    const uniqueUserIds = [
      ...new Set([...userIdsFromUserSystems, ...userIdsFromOwners]),
    ];

    // Fetch user details from Clerk
    const usersData = [];

    for (const clerkUserId of uniqueUserIds) {
      try {
        const client = await clerkClient();
        const clerkUser = await client.users.getUser(clerkUserId);

        // Get all systems this user owns
        const ownedSystems = allSystems
          .filter((s) => s.ownerClerkUserId === clerkUserId)
          .map((s) => mapSystemAccess(s, "owner"));

        // Get all systems this user has access to via userSystems table
        const additionalAccess = allUserSystems
          .filter((us) => us.user_systems.clerkUserId === clerkUserId)
          .map((us) =>
            mapSystemAccess(
              us.systems,
              us.user_systems.role as "owner" | "viewer",
            ),
          );

        // Combine and deduplicate (owned systems take precedence)
        const ownedSystemIds = new Set(ownedSystems.map((s) => s.systemId));
        const userSystemAccess = [
          ...ownedSystems,
          ...additionalAccess.filter((s) => !ownedSystemIds.has(s.systemId)),
        ];

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
          systems: userSystemAccess,
          isPlatformAdmin,
        });
      } catch (err) {
        console.error(`Failed to fetch Clerk user ${clerkUserId}:`, err);
        // Include user even if Clerk fetch fails

        // Get all systems this user owns
        const ownedSystems = allSystems
          .filter((s) => s.ownerClerkUserId === clerkUserId)
          .map((s) => mapSystemAccess(s, "owner"));

        // Get all systems this user has access to via userSystems table
        const additionalAccess = allUserSystems
          .filter((us) => us.user_systems.clerkUserId === clerkUserId)
          .map((us) =>
            mapSystemAccess(
              us.systems,
              us.user_systems.role as "owner" | "viewer",
            ),
          );

        // Combine and deduplicate (owned systems take precedence)
        const ownedSystemIds = new Set(ownedSystems.map((s) => s.systemId));
        const userSystemAccess = [
          ...ownedSystems,
          ...additionalAccess.filter((s) => !ownedSystemIds.has(s.systemId)),
        ];

        usersData.push({
          clerkUserId,
          email: undefined,
          firstName: undefined,
          lastName: undefined,
          createdAt: new Date().toISOString(),
          lastSignIn: undefined,
          systems: userSystemAccess,
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
