import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { kv } from "@/lib/kv";
import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/systems/subscriptions
 *
 * Returns all subscription mappings showing which source systems are watched by composite systems
 *
 * Returns:
 * {
 *   "subscriptions": {
 *     "1": [2, 3, 5],    // System 1 is watched by composite systems 2, 3, and 5
 *     "2": [5, 6]        // System 2 is watched by composite systems 5 and 6
 *   }
 * }
 *
 * Requires admin access
 */
export async function GET(request: NextRequest) {
  try {
    // Step 1: Authenticate
    let userId: string;
    let isAdmin = false;

    if (
      process.env.NODE_ENV === "development" &&
      request.headers.get("x-claude") === "true"
    ) {
      userId = "claude-dev";
      isAdmin = true;
    } else {
      const authResult = await auth();
      if (!authResult.userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      userId = authResult.userId;
      isAdmin = await isUserAdmin(userId);
    }

    // Step 2: Check admin access (subscriptions are system-wide admin data)
    if (!isAdmin) {
      return NextResponse.json(
        { error: "Forbidden: Admin access required" },
        { status: 403 },
      );
    }

    // Step 3: Get all composite systems to know which systems might have subscriptions
    const compositeSystems = await db
      .select()
      .from(systems)
      .where(eq(systems.vendorType, "composite"));

    // Step 4: Collect all unique source system IDs from composite metadata
    const sourceSystemIds = new Set<number>();

    for (const system of compositeSystems) {
      if (
        !system.metadata ||
        typeof system.metadata !== "object" ||
        !("version" in system.metadata) ||
        system.metadata.version !== 2
      ) {
        continue;
      }

      const metadata = system.metadata as {
        version: number;
        mappings: Record<string, string[]>;
      };

      // Extract system IDs from point references (e.g., "6.17" -> system 6)
      for (const pointRefs of Object.values(metadata.mappings)) {
        for (const ref of pointRefs) {
          const systemId = parseInt(ref.split(".")[0]);
          if (!isNaN(systemId)) {
            sourceSystemIds.add(systemId);
          }
        }
      }
    }

    // Step 5: Query KV cache for subscription lists for each source system
    const subscriptions: Record<string, number[]> = {};

    for (const systemId of sourceSystemIds) {
      const subscribers = await kv.get<number[]>(
        `subscriptions:system:${systemId}`,
      );

      if (subscribers && subscribers.length > 0) {
        subscriptions[systemId.toString()] = subscribers;
      }
    }

    return NextResponse.json({
      subscriptions,
    });
  } catch (error) {
    console.error("Error fetching subscription registry:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 },
    );
  }
}
