import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";

// Force Node.js runtime (kept for parity with the prior long-running job).
export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * Database size statistics.
 *
 * The Turso-era implementation scanned SQLite `dbstat` and wrote
 * `db_growth_snapshots` — both SQLite-specific and removed in the Phase 5 Turso
 * decommission. Postgres exposes native stats (`pg_stat_user_tables`,
 * `pg_total_relation_size`, `pg_database_size`); a Postgres snapshot job can be
 * added later if the growth dashboard is still wanted.
 */
async function handleRequest(request: NextRequest) {
  const authResult = await requireCronOrAdmin(request);
  if (authResult instanceof NextResponse) return authResult;
  return NextResponse.json({
    success: true,
    retired: true,
    message:
      "db-stats retired in Phase 5 (Turso dbstat/db_growth_snapshots removed); Postgres has native stats.",
  });
}

export const GET = handleRequest;
export async function POST(request: NextRequest) {
  return handleRequest(request);
}
