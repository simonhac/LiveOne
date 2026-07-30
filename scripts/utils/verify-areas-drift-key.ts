#!/usr/bin/env tsx
/**
 * Verify the `areas` idDrift leg still DETECTS cross-environment id drift.
 *
 *   npx tsx --env-file=.env.local scripts/utils/verify-areas-drift-key.ts
 *
 * Dev-only, repeatable, and safe to re-run: it seeds two synthetic areas in a reserved handle band
 * (9000001/9000002), drives the real sync SQL over them, asserts, and deletes them in a `finally`.
 * It writes ONLY to liveone-dev and refuses to run against a connection carrying the prod branch id.
 *
 * Originally config-v4 Phase 13 PR 5's positive drift-detection proof — kept because the property it
 * checks is permanently invisible to every other kind of test (see below), and since PR 6 it is the ONLY
 * instrument that can see it at all: `areas_legacy_system_unique` used to abort the sync when the key
 * missed, and migration 0052 dropped that index along with the column.
 *
 * Why this exists. PR 5 moved the `areas` idDrift leg's cross-ENVIRONMENT identity off
 * `areas.legacy_system_id` (dropped by migration 0052 in PR 6) onto a CROSS-TABLE key,
 * `legacy_handles.handle`.
 * A drift key that has silently stopped matching produces a sync that exits 0 having done nothing —
 * indistinguishable from a clean run. So "the sync passed" is NOT evidence; only a deliberately
 * drifted area that is actually REALIGNED is.
 *
 * How it avoids needing prod. `syncTable` takes the prod client as a plain `Client` and uses it ONLY
 * for `COPY … TO STDOUT`. So a fake prod client that emits hand-authored COPY text drives the REAL
 * generated SQL (the `_xkey_` staging, the EXISTS correlation, neutralize → upsert → repoint → delete)
 * against the REAL dev Postgres. That catches the 42703-class failure that string assertions cannot,
 * and unlike a live run it is repeatable and safe to keep.
 *
 * The discriminating detail: BOTH synthetic areas carry a NULL slug. `["owner_user_id","slug"]` is
 * therefore incapable of matching them (NULL = NULL never does), so a realignment here can ONLY have
 * come from the cross-table handle key. That is what makes this a proof rather than a smoke test.
 *
 * Writes ONLY to liveone-dev, only to its own synthetic rows, and cleans up in a finally block.
 */
import { Client } from "pg";
import { Readable } from "node:stream";
import { syncTable, prodDevSyncManifest } from "@/lib/readings/prod-dev-sync";

const HANDLE_DRIFT = 9_000_001; // realigns: same handle, different uuid
const HANDLE_CLEAN = 9_000_002; // control: same handle, SAME uuid -> must NOT be touched
const DEV_UUID_DRIFT = "9d000001-0000-4000-8000-000000000001";
const PROD_UUID_DRIFT = "9d000001-0000-4000-8000-0000000000ff";
const UUID_CLEAN = "9d000002-0000-4000-8000-000000000002";
const ALL_UUIDS = [DEV_UUID_DRIFT, PROD_UUID_DRIFT, UUID_CLEAN];
const ALL_HANDLES = [HANDLE_DRIFT, HANDLE_CLEAN];

const fail = (msg: string): never => {
  throw new Error(`ASSERTION FAILED: ${msg}`);
};

async function main() {
  // Connect straight to liveone-dev with the runtime URL. `pg` needs the PlanetScale ssl params
  // stripped, exactly as getPoolConfig does for the pool.
  const raw = process.env.PLANETSCALE_DATABASE_URL;
  if (!raw) throw new Error("set PLANETSCALE_DATABASE_URL");
  const u = new URL(raw);
  u.searchParams.delete("sslmode");
  u.searchParams.delete("sslcert");
  u.searchParams.delete("sslkey");
  u.searchParams.delete("sslrootcert");
  const dev = new Client({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await dev.connect();

  // Refuse to run anywhere that is not the shared dev database.
  const who = await dev.query("select current_user, current_database()");
  const user = String(who.rows[0].current_user);
  if (
    process.env.PLANETSCALE_PROD_BRANCH_ID &&
    user
      .toLowerCase()
      .includes(process.env.PLANETSCALE_PROD_BRANCH_ID.toLowerCase())
  ) {
    throw new Error(
      `refusing to run: connection carries the PROD branch id (${user})`,
    );
  }
  console.log(`target: ${who.rows[0].current_database} as ${user}`);

  // Real column list + PK, exactly as the live sync derives them.
  const colsRes = await dev.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='areas' ORDER BY ordinal_position`,
  );
  const cols: string[] = colsRes.rows.map((r) => String(r.column_name));
  const colsByTable = new Map([["areas", cols]]);
  const pkByTable = new Map([["areas", ["id"]]]);
  const areasLeg = prodDevSyncManifest().find((t) => t.name === "areas")!;

  const rowFor = (uuid: string, handle: number, name: string) =>
    cols
      .map((c) => {
        switch (c) {
          case "id":
            return uuid;
          case "owner_user_id":
            return "\\N"; // NULL
          case "slug":
            return "\\N"; // NULL — see header: disables the owner+slug key
          case "name":
            return name;
          case "timezone_offset_min":
          case "day_offset_min":
            return "600";
          case "display_timezone":
            return "Australia/Sydney";
          case "status":
            return "active";
          case "created_at":
          case "updated_at":
            return "2026-01-01 00:00:00";
          default:
            return "\\N";
        }
      })
      .join("\t");

  const seed = async () => {
    for (const [uuid, handle, name] of [
      [DEV_UUID_DRIFT, HANDLE_DRIFT, "PR5 proof · drifted"],
      [UUID_CLEAN, HANDLE_CLEAN, "PR5 proof · control"],
    ] as [string, number, string][]) {
      // No `legacy_system_id`: migration 0052 dropped it. The handle lives ONLY in the
      // `legacy_handles` row below — which is precisely the relation the cross-table key reads.
      await dev.query(
        `INSERT INTO areas (id, name, slug, timezone_offset_min, day_offset_min,
                            display_timezone, status)
         VALUES ($1,$2,NULL,600,600,'Australia/Sydney','active')`,
        [uuid, name],
      );
      await dev.query(
        `INSERT INTO legacy_handles (handle, area_id) VALUES ($1,$2)`,
        [handle, uuid],
      );
    }
  };

  // Fake prod: dispatch on the COPY text the sync generates.
  const fakeProd = {
    query(command: unknown) {
      const text = String((command as { text?: string }).text ?? "");
      if (
        text.includes("_xkey") ||
        text.includes("FROM public.legacy_handles")
      ) {
        // prod's satellite slice: (area_id, handle) — prod maps HANDLE_DRIFT to a DIFFERENT uuid
        return Readable.from([
          `${PROD_UUID_DRIFT}\t${HANDLE_DRIFT}\n`,
          `${UUID_CLEAN}\t${HANDLE_CLEAN}\n`,
        ]);
      }
      return Readable.from([
        rowFor(PROD_UUID_DRIFT, HANDLE_DRIFT, "PR5 proof · drifted") + "\n",
        rowFor(UUID_CLEAN, HANDLE_CLEAN, "PR5 proof · control") + "\n",
      ]);
    },
  } as unknown as Client;

  // Exhaustive on purpose: the sync UPSERTS prod's rows into dev, so after a run the synthetic set can
  // include uuids this script never seeded. Match on the synthetic handle band and name prefix too.
  const cleanup = async () => {
    // The `OR legacy_system_id = ANY(...)` disjuncts are gone with the column (migration 0052); the
    // handle band is still reachable via `legacy_handles`, which is deleted first, so `areas` is matched
    // on the synthetic uuids + the name prefix.
    await dev.query(
      `DELETE FROM legacy_handles WHERE handle = ANY($1::int[])
         OR area_id IN (SELECT id FROM areas WHERE name LIKE 'PR5 proof%')`,
      [ALL_HANDLES],
    );
    await dev.query(
      `DELETE FROM areas WHERE id = ANY($1::uuid[]) OR name LIKE 'PR5 proof%'`,
      [ALL_UUIDS],
    );
  };

  try {
    await cleanup();
    await seed();
    const before = await dev.query(
      `SELECT a.id, lh.handle FROM areas a JOIN legacy_handles lh ON lh.area_id = a.id
        WHERE lh.handle = ANY($1::int[]) ORDER BY lh.handle`,
      [ALL_HANDLES],
    );
    console.log("\nseeded dev state:");
    for (const r of before.rows) console.log(`  handle ${r.handle} -> ${r.id}`);
    if (
      before.rows.find((r) => r.handle === HANDLE_DRIFT)?.id !== DEV_UUID_DRIFT
    )
      fail("seed did not take");

    await dev.query(`DROP SCHEMA IF EXISTS sync_staging CASCADE`);
    const res = await syncTable(
      fakeProd,
      dev,
      areasLeg,
      colsByTable,
      pkByTable,
    );
    console.log(`\nsyncTable(areas) -> staged ${res.rows} rows`);

    const after = await dev.query(
      `SELECT a.id, lh.handle FROM areas a
         JOIN legacy_handles lh ON lh.area_id = a.id
        WHERE lh.handle = ANY($1::int[]) ORDER BY lh.handle`,
      [ALL_HANDLES],
    );
    console.log("post-sync dev state:");
    for (const r of after.rows) console.log(`  handle ${r.handle} -> ${r.id}`);

    // ---- THE PROOF ----
    const drifted = await dev.query(`SELECT 1 FROM areas WHERE id = $1`, [
      DEV_UUID_DRIFT,
    ]);
    const adopted = await dev.query(`SELECT 1 FROM areas WHERE id = $1`, [
      PROD_UUID_DRIFT,
    ]);
    const control = await dev.query(`SELECT 1 FROM areas WHERE id = $1`, [
      UUID_CLEAN,
    ]);

    if (adopted.rowCount !== 1)
      fail("dev did NOT adopt prod's uuid — DRIFT WENT UNDETECTED");
    if (drifted.rowCount !== 0)
      fail("the drifted dev row survived — realignment did not complete");
    if (control.rowCount !== 1)
      fail("the non-drifted control row was destroyed");

    console.log(
      "\n✓ DRIFT DETECTED AND REALIGNED via the cross-table legacy_handles key",
    );
    console.log("  - dev adopted prod's uuid for handle 9000001");
    console.log("  - the drifted dev row is gone");
    console.log(
      "  - the non-drifted control (handle 9000002) was left untouched",
    );
    console.log(
      "  - both areas have a NULL slug, so owner_user_id+slug CANNOT have matched them:",
    );
    console.log(
      "    the cross-table handle key is the only thing that could have fired.",
    );

    // Untouched-real-data check: the 22 production-mirrored areas must be unchanged.
    const real = await dev.query(
      `SELECT count(*)::int n FROM areas WHERE id <> ALL($1::uuid[])`,
      [ALL_UUIDS],
    );
    console.log(`\nreal areas still present: ${real.rows[0].n} (expected 22)`);
    if (real.rows[0].n !== 22)
      fail(`real area count changed: ${real.rows[0].n}`);

    // ---- NEGATIVE CONTROL: does this test actually have teeth? ----
    // Re-run the identical scenario with `crossKeys` STRIPPED, i.e. the manifest as it would be if the
    // handle key were dropped without a replacement. Drift must then go UNDETECTED. Without this, a
    // passing test above proves only that the sync ran — not that the new key is what made it work.
    await cleanup();
    await seed();
    await dev.query(`DROP SCHEMA IF EXISTS sync_staging CASCADE`);
    const stripped = JSON.parse(JSON.stringify(areasLeg));
    delete stripped.idDrift.crossKeys;
    let controlErr: string | null = null;
    try {
      await syncTable(fakeProd, dev, stripped, colsByTable, pkByTable);
    } catch (e) {
      controlErr = e instanceof Error ? e.message : String(e);
    }
    const stillDrifted = await dev.query(`SELECT 1 FROM areas WHERE id = $1`, [
      DEV_UUID_DRIFT,
    ]);
    const notAdopted = await dev.query(`SELECT 1 FROM areas WHERE id = $1`, [
      PROD_UUID_DRIFT,
    ]);
    if (stillDrifted.rowCount !== 1)
      fail("control invalid: drift was realigned even WITHOUT the cross key");
    if (notAdopted.rowCount !== 0)
      fail("control invalid: prod's uuid landed without the cross key");
    console.log(
      "\n✓ NEGATIVE CONTROL: with crossKeys removed, the SAME drift is not realigned.",
    );
    console.log(
      "  the drifted dev row survives and prod's uuid never lands, so the realignment",
    );
    console.log(
      "  above is attributable specifically to the cross-table legacy_handles key.",
    );
    if (controlErr) {
      console.log(
        `\n  NOTE — it did not fail quietly, it ABORTED: ${controlErr}`,
      );
      console.log(
        "  UNEXPECTED post-0052: `areas_legacy_system_unique` was the backstop that made a missed",
      );
      console.log(
        "  key abort, and it is gone. Some OTHER constraint is standing in for it — worth knowing,",
      );
      console.log("  but do not rely on it.");
    } else {
      console.log(
        "\n  NOTE: it failed SILENTLY (exit 0, nothing realigned) — the invisible mode, and the",
      );
      console.log(
        "  EXPECTED post-0052 behaviour. `areas_legacy_system_unique` used to abort the sync on a",
      );
      console.log(
        "  missed key; migration 0052 dropped it with the column, so this script is now the ONLY",
      );
      console.log(
        "  instrument that can tell a working drift key from a broken one. Run it after any change",
      );
      console.log("  to the `areas` idDrift leg.");
    }
  } finally {
    await cleanup();
    await dev
      .query(`DROP SCHEMA IF EXISTS sync_staging CASCADE`)
      .catch(() => {});
    await dev.end();
    console.log("cleaned up synthetic rows");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
