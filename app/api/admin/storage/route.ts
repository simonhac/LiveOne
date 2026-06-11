import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

/**
 * Storage breakdown.
 *
 * The Turso-era implementation read SQLite `dbstat`/page sizes and the
 * `TURSO_DATABASE_URL` — removed in the Phase 5 Turso decommission. Postgres
 * size info is available via `pg_total_relation_size`/`pg_database_size` if a
 * PG-native breakdown is needed later.
 */
async function handleRequest(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;
  return NextResponse.json({
    success: true,
    retired: true,
    message: "storage stats retired in Phase 5 (Turso SQLite-specific).",
  });
}

export async function GET(request: NextRequest) {
  return handleRequest(request);
}
export async function POST(request: NextRequest) {
  return handleRequest(request);
}
