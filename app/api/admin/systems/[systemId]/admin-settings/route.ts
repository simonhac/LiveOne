import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { systems, userSystems } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";

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

    // Get the system to find the owner
    const [system] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, systemId));

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Get all viewers from userSystems table
    const viewerRecords = await db
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

    // Verify system exists
    const [system] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, systemId));

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Update owner if changed
    if (ownerClerkUserId !== undefined) {
      await db
        .update(systems)
        .set({
          ownerClerkUserId: ownerClerkUserId || null,
          updatedAt: new Date(),
        })
        .where(eq(systems.id, systemId));
    }

    // Update viewers
    if (viewers !== undefined && Array.isArray(viewers)) {
      // Get current viewer records
      const currentViewers = await db
        .select()
        .from(userSystems)
        .where(
          and(
            eq(userSystems.systemId, systemId),
            eq(userSystems.role, "viewer"),
          ),
        );

      const currentViewerIds = new Set(
        currentViewers.map((v) => v.clerkUserId),
      );
      const newViewerIds = new Set(viewers.map((v: any) => v.clerkUserId));

      // Remove viewers that are no longer in the list
      for (const currentViewer of currentViewers) {
        if (!newViewerIds.has(currentViewer.clerkUserId)) {
          await db
            .delete(userSystems)
            .where(
              and(
                eq(userSystems.systemId, systemId),
                eq(userSystems.clerkUserId, currentViewer.clerkUserId),
                eq(userSystems.role, "viewer"),
              ),
            );
        }
      }

      // Add new viewers
      for (const viewer of viewers) {
        if (!currentViewerIds.has(viewer.clerkUserId)) {
          await db.insert(userSystems).values({
            clerkUserId: viewer.clerkUserId,
            systemId: systemId,
            role: "viewer",
          });
        }
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
