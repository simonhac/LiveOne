import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { makeTimer, serverTimingHeaders } from "@/lib/server-timing";
import journal from "@/drizzle-planetscale/meta/_journal.json";

export const dynamic = "force-dynamic";

// Migrations this build ships (code truth) — from the drizzle journal bundled at build time.
const EXPECTED_MIGRATIONS = journal.entries.length;
const LATEST_MIGRATION_TAG =
  journal.entries[journal.entries.length - 1]?.tag ?? null;

interface Migrations {
  applied: number; // rows in drizzle.__drizzle_migrations (DB truth)
  expected: number; // migrations this build ships (code truth, from _journal.json)
  latestTag: string | null; // newest migration tag this build ships
  latestHash: string | null; // sha256 of the newest APPLIED migration (cross-env comparable)
  inSync: boolean; // applied >= expected (false ⇒ DB behind the deployed code)
}

/**
 * DB-applied migration state, for a cheap prod↔dev drift check via `/api/health`.
 *
 * Uses `count(*)`, NOT `max(id)`: the `drizzle.__drizzle_migrations` PK is a serial that gaps on any
 * row delete/re-apply (liveone-dev has a real gap at id 11), so `max(id)` drifts across envs while the
 * schema actually matches. `count(*)` + the newest migration's hash (drizzle stores `sha256` of the
 * `.sql` file, so it's identical across envs when in sync) are the stable comparators. Best-effort —
 * the caller keeps liveness green even if this throws.
 */
async function readMigrations(): Promise<Migrations> {
  const result = (await requirePlanetscaleDb().execute(sql`
    SELECT
      (SELECT count(*)::int FROM drizzle."__drizzle_migrations") AS applied,
      (SELECT hash FROM drizzle."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1) AS latest_hash
  `)) as unknown as {
    rows: { applied: number | string; latest_hash: string | null }[];
  };
  const row = result.rows[0];
  const applied = Number(row?.applied ?? 0);
  return {
    applied,
    expected: EXPECTED_MIGRATIONS,
    latestTag: LATEST_MIGRATION_TAG,
    latestHash: row?.latest_hash ?? null,
    inSync: applied >= EXPECTED_MIGRATIONS,
  };
}

/**
 * Liveness check against the Postgres store (the sole store after the Phase 5
 * decommission of the legacy store).
 *
 * Also the CONTROL for the Server-Timing latency investigation (public route, no Clerk
 * `auth.protect()` at the edge): its client-observed duration minus `mw`+`total` approximates pure
 * function-invocation + network cost, against which the authed routes' gap is compared. The `db`
 * timer stays a bare `SELECT 1` so that control is unpolluted; the migration probe is timed as `mig`.
 */
export async function GET(request: NextRequest) {
  const t = makeTimer(request);
  try {
    await t.time("db", () => requirePlanetscaleDb().execute(sql`SELECT 1`));
    const body: {
      status: string;
      database: string;
      migrations?: Migrations | { error: string };
    } = { status: "ok", database: "postgres" };
    // Opt-in (`?migrations=1`): the cheap prod↔dev migration-drift probe. Off by default so the
    // liveness path stays a single query and the `db` timing control stays clean. Best-effort — a
    // journal read must never turn liveness red.
    if (request.nextUrl.searchParams.get("migrations") === "1") {
      try {
        body.migrations = await t.time("mig", () => readMigrations());
      } catch (e) {
        body.migrations = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    return NextResponse.json(body, { headers: serverTimingHeaders(t) });
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
