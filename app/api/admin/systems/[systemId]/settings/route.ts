import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/turso";
import { systems } from "@/lib/db/turso/schema";
import { eq, and, ne } from "drizzle-orm";
import { requireAdmin, requireSystemAccess } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { isValidTimezone } from "@/lib/timezones";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    return NextResponse.json({
      success: true,
      settings: {
        displayName: authResult.system.displayName,
        alias: authResult.system.alias,
        displayTimezone: authResult.system.displayTimezone,
      },
    });
  } catch (error) {
    console.error("Error fetching system settings:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch system settings",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    // Get the updates from request body
    const body = await request.json();
    const { displayName, alias, displayTimezone } = body;

    // Log the settings update request
    console.log("Settings update:", {
      systemId,
      displayName,
      alias,
      displayTimezone,
    });

    // Validate that at least one field is being updated
    if (
      displayName === undefined &&
      alias === undefined &&
      displayTimezone === undefined
    ) {
      return NextResponse.json(
        { error: "At least one field must be provided" },
        { status: 400 },
      );
    }

    // Validate displayName if provided
    if (displayName !== undefined) {
      if (typeof displayName !== "string") {
        return NextResponse.json(
          { error: "Display name must be a string" },
          { status: 400 },
        );
      }

      if (displayName.trim().length === 0) {
        return NextResponse.json(
          { error: "Display name cannot be empty" },
          { status: 400 },
        );
      }

      if (displayName.length > 100) {
        return NextResponse.json(
          { error: "Display name is too long (max 100 characters)" },
          { status: 400 },
        );
      }
    }

    // Validate alias if provided
    if (alias !== undefined && alias !== null) {
      if (typeof alias !== "string") {
        return NextResponse.json(
          { error: "Short name must be a string" },
          { status: 400 },
        );
      }

      // Empty string is treated as null (removing the short name)
      if (alias.trim().length > 0) {
        if (!/^[a-zA-Z0-9_]+$/.test(alias)) {
          return NextResponse.json(
            {
              error:
                "Short name can only contain letters, digits, and underscores",
            },
            { status: 400 },
          );
        }

        if (alias.length > 200) {
          return NextResponse.json(
            { error: "Short name is too long (max 200 characters)" },
            { status: 400 },
          );
        }
      }
    }

    // Validate displayTimezone if provided
    if (displayTimezone !== undefined) {
      if (displayTimezone === null || typeof displayTimezone !== "string") {
        return NextResponse.json(
          { error: "Display timezone must be a string (cannot be null)" },
          { status: 400 },
        );
      }

      if (displayTimezone.trim().length === 0) {
        return NextResponse.json(
          { error: "Display timezone cannot be empty" },
          { status: 400 },
        );
      }

      if (!isValidTimezone(displayTimezone)) {
        return NextResponse.json(
          { error: "Invalid timezone. Must be a valid IANA timezone string" },
          { status: 400 },
        );
      }
    }

    // Build the update object
    const updates: {
      displayName?: string;
      alias?: string | null;
      displayTimezone?: string;
      updatedAt: Date;
    } = {
      updatedAt: new Date(),
    };

    if (displayName !== undefined) {
      updates.displayName = displayName.trim();
    }

    if (alias !== undefined) {
      updates.alias =
        alias === null || alias.trim().length === 0 ? null : alias.trim();
    }

    if (displayTimezone !== undefined) {
      // displayTimezone is NOT NULL in schema, so we only set it if it's valid
      // Validation above ensures it's a non-empty string at this point
      updates.displayTimezone = displayTimezone.trim();
    }

    // Check if alias is already taken by another system
    if (updates.alias) {
      const existing = await db
        .select()
        .from(systems)
        .where(and(eq(systems.alias, updates.alias), ne(systems.id, systemId)))
        .limit(1);

      if (existing.length > 0) {
        return NextResponse.json(
          {
            error: `Short name "${updates.alias}" is already in use by ${existing[0].displayName}`,
          },
          { status: 409 },
        );
      }
    }

    // Confirm the system exists before updating (preserves the prior 404 that the
    // .returning() row count provided — updateSystem returns void).
    const [existingSystem] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, systemId))
      .limit(1);

    if (!existingSystem) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Update the system. updateSystem honours CONFIG_WRITES_TO_PG and already
    // invalidates the SystemsManager cache, so the explicit invalidateCache call
    // here is no longer needed.
    await SystemsManager.getInstance().updateSystem(systemId, updates);

    // Revalidate dashboard paths to refresh server-side data
    revalidatePath("/dashboard", "layout");

    return NextResponse.json({
      success: true,
      message: "System updated successfully",
      system: {
        id: systemId,
        displayName: updates.displayName ?? existingSystem.displayName,
        alias:
          updates.alias !== undefined ? updates.alias : existingSystem.alias,
        displayTimezone:
          updates.displayTimezone ?? existingSystem.displayTimezone,
      },
    });
  } catch (error) {
    console.error("Error updating system:", error);

    // Check for unique constraint violation on alias
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed")
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Short name must be unique across all systems",
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Failed to update system",
      },
      { status: 500 },
    );
  }
}
