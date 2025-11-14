import { NextRequest, NextResponse } from "next/server";
import { getUserIdByUsername } from "@/lib/user-cache";

/**
 * GET /api/test/cache
 *
 * Tests username cache performance by performing multiple lookups
 *
 * Query Parameters:
 * - count: Number of cache lookups to perform (default: 10, max: 1000)
 *
 * Returns statistics about lookup times in milliseconds:
 * {
 *   "count": 10,
 *   "first": 4936,    // First lookup (usually slower - cache miss or cold start)
 *   "min": 385,       // Fastest lookup
 *   "max": 4936,      // Slowest lookup
 *   "median": 446,    // Median lookup time
 *   "avg": 946.4,     // Average lookup time
 *   "note": "Use ?count=N to specify number of lookups (default 10, max 1000)"
 * }
 */
export async function GET(request: NextRequest) {
  const username = "simon";

  // Get count from query parameter, default to 10
  const searchParams = request.nextUrl.searchParams;
  const count = parseInt(searchParams.get("count") || "10", 10);
  const iterations = Math.max(1, Math.min(count, 1000)); // Clamp between 1 and 1000

  const times: number[] = [];

  // Run lookups
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await getUserIdByUsername(username);
    const duration = Date.now() - start;
    times.push(duration);
  }

  // Calculate statistics
  const min = Math.min(...times);
  const max = Math.max(...times);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const first = times[0];

  return NextResponse.json({
    count: iterations,
    first,
    min,
    max,
    median,
    avg: Math.round(avg * 10) / 10,
    note: "Use ?count=N to specify number of lookups (default 10, max 1000)",
  });
}
