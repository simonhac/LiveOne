import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { makeTimer, serverTimingHeaders } from "@/lib/server-timing";

export const dynamic = "force-dynamic";

/**
 * Liveness check against the Postgres store (the sole store after the Phase 5
 * decommission of the legacy store).
 *
 * Also the CONTROL for the Server-Timing latency investigation (public route, no Clerk
 * `auth.protect()` at the edge): its client-observed duration minus `mw`+`total` approximates pure
 * function-invocation + network cost, against which the authed routes' gap is compared.
 */
export async function GET(request: NextRequest) {
  const t = makeTimer(request);
  try {
    await t.time("db", () => requirePlanetscaleDb().execute(sql`SELECT 1`));
    return NextResponse.json(
      { status: "ok", database: "postgres" },
      { headers: serverTimingHeaders(t) },
    );
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
