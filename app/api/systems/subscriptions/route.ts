import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { kv, kvKey } from "@/lib/kv";
import {
  SubscriptionRegistryEntry,
  buildSubscriptionRegistry,
} from "@/lib/kv-cache-manager";
import { jsonResponse } from "@/lib/json";
import { getEnvironment } from "@/lib/env";

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
 *   "namespace": "dev",
 *   "subscriptions": {
 *     "1": {
 *       "pointSubscribers": {
 *         "1": ["5.0", "7.0"],
 *         "2": ["5.1"]
 *       },
 *       "lastUpdatedTimeMs": 1731627423000
 *     },
 *     "2": {
 *       "pointSubscribers": {
 *         "3": ["7.1", "7.2"]
 *       },
 *       "lastUpdatedTimeMs": 1731627423000
 *     }
 *   },
 *   "note": "Use ?action=build to force rebuild the registry from database"
 * }
 *
 * Requires admin access
 */
export async function GET(request: NextRequest) {
  try {
    // Authenticate and require admin access
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    // Check if rebuild is requested
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get("action");

    if (action === "build") {
      console.log(
        "Building subscription registry (requested via ?action=build)",
      );
      await buildSubscriptionRegistry();
    }

    // Scan KV for all subscription keys
    // Pattern: {namespace}:subscriptions:system:*
    const pattern = kvKey("subscriptions:system:*");
    const keys = await kv.keys(pattern);

    // Fetch all subscription lists with timestamps
    const subscriptions: Record<
      string,
      { pointSubscribers: Record<string, string[]>; lastUpdatedTimeMs: number }
    > = {};

    for (const key of keys) {
      // Extract system ID from key (e.g., "dev:subscriptions:system:6" -> "6")
      // Remove the namespace prefix first
      const namespace = getEnvironment();
      const withoutNamespace = key.replace(`${namespace}:`, "");
      const systemId = withoutNamespace.replace("subscriptions:system:", "");

      const entry = await kv.get<SubscriptionRegistryEntry>(key);

      if (entry && entry.pointSubscribers) {
        subscriptions[systemId] = {
          pointSubscribers: entry.pointSubscribers,
          lastUpdatedTimeMs: entry.lastUpdatedTimeMs,
        };
      }
    }

    // Return with automatic date formatting (lastUpdatedTimeMs -> lastUpdatedTime with ISO8601 format)
    return jsonResponse({
      namespace: getEnvironment(),
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
