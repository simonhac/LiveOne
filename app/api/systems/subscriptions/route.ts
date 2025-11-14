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
 * Returns all subscription mappings showing which source systems are watched by composite systems
 *
 * Query Parameters:
 * - build=true: Force rebuild of subscription registry before returning results
 *
 * Returns:
 * {
 *   "subscriptions": {
 *     "1": {
 *       "subscribers": [2, 3, 5],
 *       "lastUpdated": "2025-11-14T23:45:00+10:00"
 *     },
 *     "2": {
 *       "subscribers": [5, 6],
 *       "lastUpdated": "2025-11-14T23:45:00+10:00"
 *     }
 *   },
 *   "note": "Use ?build=true to force rebuild the registry from database"
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
    const shouldBuild = searchParams.get("build") === "true";

    if (shouldBuild) {
      console.log("Building subscription registry (requested via ?build=true)");
      await buildSubscriptionRegistry();
    }

    // Step 4: Scan KV for all subscription keys
    // Pattern: {namespace}:subscriptions:system:*
    const pattern = kvKey("subscriptions:system:*");
    const keys = await kv.keys(pattern);

    // Step 5: Fetch all subscription lists with timestamps
    const subscriptions: Record<
      string,
      { subscribers: number[]; lastUpdated: string }
    > = {};

    for (const key of keys) {
      // Extract system ID from key (e.g., "dev:subscriptions:system:6" -> "6")
      // Remove the namespace prefix first
      const namespace = process.env.KV_NAMESPACE || "dev";
      const withoutNamespace = key.replace(`${namespace}:`, "");
      const systemId = withoutNamespace.replace("subscriptions:system:", "");

      const entry = await kv.get<SubscriptionRegistryEntry>(key);

      if (entry && entry.subscribers && entry.subscribers.length > 0) {
        subscriptions[systemId] = {
          subscribers: entry.subscribers,
          lastUpdated: unixToFormattedAEST(entry.lastUpdatedMs, true),
        };
      }
    }

    return NextResponse.json({
      subscriptions,
      note: "Use ?build=true to force rebuild the registry from database",
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
