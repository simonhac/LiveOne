import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

/**
 * Dev-seed sync endpoint — RETIRED in the Phase 5 decommission of the legacy store.
 *
 * This streamed the prod legacy SQLite store → local SQLite dev DB. With the legacy
 * store gone it no longer runs; re-point to seed dev from Postgres if the tool is
 * still wanted.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;
  return NextResponse.json(
    {
      success: false,
      retired: true,
      error:
        "legacy SQLite dev-seed retired in Phase 5 — re-point to seed dev from Postgres",
    },
    { status: 410 },
  );
}
