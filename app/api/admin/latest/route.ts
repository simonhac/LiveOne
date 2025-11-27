import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { kv, kvKey } from "@/lib/kv";
import {
  getAllSystemSummaries,
  getSystemSummary,
} from "@/lib/system-summary-store";
import { jsonResponse } from "@/lib/json";

/**
 * GET /api/admin/latest
 *
 * - GET /api/admin/latest - Returns all system summaries
 * - GET /api/admin/latest?systemId=1 - Returns single system summary
 * - GET /api/admin/latest?action=clear - Clears latest values cache
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");

    // Handle clear action - scan KV for matching keys and delete them
    if (action === "clear") {
      const pattern = kvKey("latest:system:*");
      let cursor = 0;
      let clearedCount = 0;

      do {
        const [nextCursor, keys] = await kv.scan(cursor, {
          match: pattern,
          count: 100,
        });
        cursor = Number(nextCursor);

        if (keys.length > 0) {
          await kv.del(...keys);
          clearedCount += keys.length;
        }
      } while (cursor !== 0);

      console.log(`[Admin] Cleared ${clearedCount} latest readings cache keys`);
      return NextResponse.json({
        success: true,
        message: `Cleared ${clearedCount} latest readings cache keys`,
        keysCleared: clearedCount,
      });
    }

    const systemIdParam = searchParams.get("systemId");

    if (systemIdParam) {
      const systemId = parseInt(systemIdParam, 10);
      if (isNaN(systemId)) {
        return NextResponse.json(
          { error: "Invalid systemId parameter" },
          { status: 400 },
        );
      }
      const summary = await getSystemSummary(systemId);
      return jsonResponse({ success: true, systemId, summary });
    }

    const summaries = await getAllSystemSummaries();
    return jsonResponse({
      success: true,
      summaries,
      count: Object.keys(summaries).length,
    });
  } catch (error) {
    console.error("Error fetching system summaries:", error);
    return NextResponse.json(
      { error: "Failed to fetch system summaries" },
      { status: 500 },
    );
  }
}
