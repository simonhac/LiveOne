import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { kv, kvKey } from "@/lib/kv";

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

    // Step 3: Scan KV for all subscription keys
    // Pattern: {namespace}:subscriptions:system:*
    const pattern = kvKey("subscriptions:system:*");
    const keys = await kv.keys(pattern);

    // Step 4: Fetch all subscription lists
    const subscriptions: Record<string, number[]> = {};

    for (const key of keys) {
      // Extract system ID from key (e.g., "dev:subscriptions:system:6" -> "6")
      // Remove the namespace prefix first
      const namespace = process.env.KV_NAMESPACE || "dev";
      const withoutNamespace = key.replace(`${namespace}:`, "");
      const systemId = withoutNamespace.replace("subscriptions:system:", "");

      const subscribers = await kv.get<number[]>(key);

      if (subscribers && subscribers.length > 0) {
        subscriptions[systemId] = subscribers;
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
