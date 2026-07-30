import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { kv } from "@/lib/kv";
import { subscriptionsKeyPattern } from "@/lib/kv-keys";
import {
  SubscriptionRegistryEntry,
  buildSubscriptionRegistry,
} from "@/lib/kv-cache-manager";
import { jsonResponse } from "@/lib/json";
import { getEnvironment } from "@/lib/env";

/**
 * GET /api/devices/subscriptions
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
 *     "dv_01k9…": {
 *       "pointSubscribers": {
 *         "0199a1…": ["ar_01ka…", "ar_01kb…"],
 *         "0199a2…": ["ar_01ka…"]
 *       },
 *       "lastUpdatedTimeMs": 1731627423000
 *     }
 *   },
 *   "note": "Use ?action=build to force rebuild the registry from database"
 * }
 *
 * config-v4 Phase 13 PR 3: the outer keys are the SOURCE DEVICE's `dv_` TypeID (was its integer handle)
 * and the subscriber refs are `ar_` TypeIDs (was `"{areaHandle}.{ordinal}"`).
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
    const keys = await kv.keys(subscriptionsKeyPattern());

    // Fetch all subscription lists with timestamps
    const subscriptions: Record<
      string,
      { pointSubscribers: Record<string, string[]>; lastUpdatedTimeMs: number }
    > = {};

    for (const key of keys) {
      // The source device's `dv_` TypeID is the last colon-separated segment of
      // "{namespace}:subscriptions:device:{dv_…}". Taken positionally rather than by stripping two
      // prefixes: the old code did `key.replace(namespace + ":", "")` then
      // `.replace("subscriptions:system:", "")`, which is two literal key fragments duplicated outside
      // `lib/kv-keys.ts` — exactly the split-brain this PR closed.
      const deviceId = key.slice(key.lastIndexOf(":") + 1);

      const entry = await kv.get<SubscriptionRegistryEntry>(key);

      if (entry && entry.pointSubscribers) {
        subscriptions[deviceId] = {
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
