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

/** config-v4 mirror completeness (guardrail C7). `commissioned:false` ⇒ registry-sync has not run yet. */
export interface V4MirrorState {
  commissioned: boolean;
  pointsMissing: number; // point_info rows with no `points` row
  devicesMissing: number; // systems rows with no `devices` row
  complete: boolean;
}

/**
 * Standing C7 invariant: once the v4 registries are populated they must stay COMPLETE.
 *
 * The cutover's hot tables carry `FK point_rid → points(rid) NOT VALID`, which still enforces on new
 * inserts — so a `point_info` row without a `points` row is a reading that will fail to materialise and
 * be retried forever by QStash. `lib/registry/v4-mirror.ts` makes that structurally impossible at mint
 * time; this is the alarm that proves it, continuously, for the whole pre-window period.
 *
 * `commissioned` means the DEVICE registry is fully populated (at least one row, and no `systems` row
 * without one) — i.e. registry-sync has run. The check is silent until then, and arms itself
 * automatically afterwards. A single incidental `devices` row (the mirror creating one on a point mint)
 * deliberately does NOT arm it; requiring `devicesMissing === 0` is what makes the signal trustworthy.
 * `DeviceWriter.createSystem` (the surviving `systems` writer) mirrors into `devices` too, so a new
 * system cannot silently disarm it.
 */
async function readV4Mirror(): Promise<V4MirrorState> {
  const result = (await requirePlanetscaleDb().execute(sql`
    SELECT
      (SELECT count(*)::int FROM devices) AS device_rows,
      (SELECT count(*)::int FROM point_info pi
         WHERE NOT EXISTS (SELECT 1 FROM points p WHERE p.id = pi.point_uid)) AS points_missing,
      (SELECT count(*)::int FROM systems s
         WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = s.id)) AS devices_missing
  `)) as unknown as {
    rows: {
      device_rows: number | string;
      points_missing: number | string;
      devices_missing: number | string;
    }[];
  };
  const row = result.rows[0];
  const pointsMissing = Number(row?.points_missing ?? 0);
  const devicesMissing = Number(row?.devices_missing ?? 0);
  const commissioned =
    Number(row?.device_rows ?? 0) > 0 && devicesMissing === 0;
  return {
    commissioned,
    pointsMissing,
    devicesMissing,
    complete: pointsMissing === 0 && devicesMissing === 0,
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
      v4Mirror?: V4MirrorState | { error: string };
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
    // Opt-in (`?v4mirror=1`): the standing C7 completeness probe. Same best-effort contract — the
    // cutover-prep invariant must never turn liveness red.
    if (request.nextUrl.searchParams.get("v4mirror") === "1") {
      try {
        body.v4Mirror = await t.time("v4m", () => readV4Mirror());
      } catch (e) {
        body.v4Mirror = { error: e instanceof Error ? e.message : String(e) };
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
