import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";

export const dynamic = "force-dynamic";

/**
 * Liveness check against the Postgres store (the sole store after the Phase 5
 * decommission of the legacy store).
 */
export async function GET() {
  try {
    await requirePlanetscaleDb().execute(sql`SELECT 1`);
    return NextResponse.json({ status: "ok", database: "postgres" });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
