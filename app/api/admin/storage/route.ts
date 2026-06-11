import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

/**
 * Storage breakdown.
 *
 * The legacy SQLite implementation read `dbstat`/page sizes — removed in the
 * Phase 5 decommission of the legacy store. Postgres size info is available via
 * `pg_total_relation_size`/`pg_database_size` if a PG-native breakdown is needed
 * later.
 */
async function handleRequest(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;
  return NextResponse.json({
    success: true,
    retired: true,
    message: "storage stats retired in Phase 5 (legacy SQLite-specific).",
  });
}

export async function GET(request: NextRequest) {
  return handleRequest(request);
}
export async function POST(request: NextRequest) {
  return handleRequest(request);
}
