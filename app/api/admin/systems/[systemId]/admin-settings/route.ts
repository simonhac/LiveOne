import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { userSystems } from "@/lib/db/planetscale/schema";
import { eq, and } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { grantUserSystem, revokeAllForSystem } from "@/lib/user-systems";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const params = await context.params;
    const systemId = parseInt(params.systemId);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    // Get the system to find the owner (read via SystemsManager → honours CONFIG_SERVE_FROM_PG)
    const system = await SystemsManager.getInstance().getSystem(systemId);

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Get all viewers from userSystems table
    const viewerRecords = await requirePlanetscaleDb()
      .select()
      .from(userSystems)
      .where(
        and(eq(userSystems.systemId, systemId), eq(userSystems.role, "viewer")),
      );

    // Fetch user details from Clerk for each viewer
    const viewers = [];
    for (const record of viewerRecords) {
      try {
        const client = await clerkClient();
        const clerkUser = await client.users.getUser(record.clerkUserId);

        viewers.push({
          clerkUserId: record.clerkUserId,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
          username: clerkUser.username,
        });
      } catch (error) {
        console.error(
          `Failed to fetch Clerk user ${record.clerkUserId}:`,
          error,
        );
        // Include viewer even if Clerk fetch fails
        viewers.push({
          clerkUserId: record.clerkUserId,
          email: undefined,
          firstName: undefined,
          lastName: undefined,
          username: undefined,
        });
      }
    }

    return NextResponse.json({
      success: true,
      ownerClerkUserId: system.ownerClerkUserId,
      viewers,
    });
  } catch (error) {
    console.error("Error fetching admin settings:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch admin settings",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const params = await context.params;
    const systemId = parseInt(params.systemId);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const body = await request.json();
    const { ownerClerkUserId, viewers } = body;

    // Verify system exists (read via SystemsManager → honours CONFIG_SERVE_FROM_PG)
    const system = await SystemsManager.getInstance().getSystem(systemId);

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Update owner if changed
    if (ownerClerkUserId !== undefined) {
      await SystemsManager.getInstance().updateSystem(systemId, {
        ownerClerkUserId: ownerClerkUserId || null,
      });
    }

    // Update viewers: revoke every membership for the system, then re-grant each
    // viewer. grantUserSystem upserts on (clerkUserId, systemId), so the final
    // state is the supplied viewer set — the same end state as the prior
    // incremental add/remove. Both writes honour CONFIG_WRITES_TO_PG.
    if (viewers !== undefined && Array.isArray(viewers)) {
      await revokeAllForSystem(systemId);

      for (const viewer of viewers) {
        await grantUserSystem(viewer.clerkUserId, systemId, "viewer");
      }
    }

    return NextResponse.json({
      success: true,
      message: "Admin settings updated successfully",
    });
  } catch (error) {
    console.error("Error updating admin settings:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to update admin settings",
      },
      { status: 500 },
    );
  }
}
