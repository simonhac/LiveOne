import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { kv, kvKey } from "@/lib/kv";
import {
  SubscriptionRegistryEntry,
  buildSubscriptionRegistry,
} from "@/lib/kv-cache-manager";
import { unixToFormattedAEST } from "@/lib/date-utils";

/**
 * GET /api/systems/subscriptions
 *
 * Returns all subscription mappings showing which source points are watched by composite points
 *
 * Query Parameters:
 * - action=build: Force rebuild of subscription registry before returning results
 *
 * Returns:
 * {
 *   "subscriptions": {
 *     "1": {
 *       "pointSubscribers": {
 *         "1": ["5.0", "7.0"],
 *         "2": ["5.1"]
 *       },
 *       "lastUpdated": "2025-11-14T23:45:00+10:00"
 *     },
 *     "2": {
 *       "pointSubscribers": {
 *         "3": ["7.1", "7.2"]
 *       },
 *       "lastUpdated": "2025-11-14T23:45:00+10:00"
 *     }
 *   },
 *   "note": "Use ?action=build to force rebuild the registry from database"
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

    // Step 3: Check if rebuild is requested
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get("action");

    if (action === "build") {
      console.log(
        "Building subscription registry (requested via ?action=build)",
      );
      await buildSubscriptionRegistry();
    }

    // Step 4: Scan KV for all subscription keys
    // Pattern: {namespace}:subscriptions:system:*
    const pattern = kvKey("subscriptions:system:*");
    const keys = await kv.keys(pattern);

    // Step 5: Fetch all subscription lists with timestamps
    const subscriptions: Record<
      string,
      { pointSubscribers: Record<string, string[]>; lastUpdated: string }
    > = {};

    for (const key of keys) {
      // Extract system ID from key (e.g., "dev:subscriptions:system:6" -> "6")
      // Remove the namespace prefix first
      const namespace = process.env.KV_NAMESPACE || "dev";
      const withoutNamespace = key.replace(`${namespace}:`, "");
      const systemId = withoutNamespace.replace("subscriptions:system:", "");

      const entry = await kv.get<SubscriptionRegistryEntry>(key);

      if (entry && entry.pointSubscribers) {
        subscriptions[systemId] = {
          pointSubscribers: entry.pointSubscribers,
          lastUpdated: unixToFormattedAEST(entry.lastUpdatedMs, true),
        };
      }
    }

    return NextResponse.json({
      subscriptions,
      note: "Use ?action=build to force rebuild the registry from database",
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
