#!/usr/bin/env tsx
/**
 * config-v4 cutover transform driver (Phase 7 rehearsal harness).
 *
 * Runs the Phase 8 cutover transform end-to-end on a THROWAWAY prod-snapshot PlanetScale branch, so the
 * parity + window-fit checks can be exercised before the real window. This same script becomes the real
 * Phase 8 transform verbatim. It NEVER runs against prod or the shared liveone-dev DB — see the target
 * guard below (fail-closed).
 *
 * Stages (mirror docs/plans/config-v4-execution-plan.md Phase 8; docs/plans/config-v4-phase7-rehearsal-harness.md):
 *   1. DDL          — apply scripts/config-v4/cutover.sql (devices/points/area_members/device_state + device_rid_seq)
 *   2. Registries   — populate devices, mint areas-of-one, primary_area_id, areas carryover, area_members,
 *                     device_state, points; seed device_rid_seq; wire deferred FKs; row-count guards
 *   4. Hot rewrite  — the window-critical step: (point_rid, time) twins → batched copy via point_info.rid →
 *                     indexes/PK/NOT-VALID FKs AFTER load → bounded rename-swap keeping _old (timed per stage)
 *   5. Config       — bindings→pt_ uuid, derivations (run-detector + HWS), dashboards doc v3→v4 + int→uuid
 *                     PK swap (users/grants/tokens re-keyed). Validated; deferred items in the Phase-7 doc.
 *
 * Usage (on a rehearsal branch — see the runbook in the Phase-7 doc):
 *   PLANETSCALE_DATABASE_URL="<branch url>" REHEARSAL_BRANCH_ID="<branch id in the conn username>" \
 *     npx tsx scripts/config-v4/config-transform.ts            # dry-run: plan + guards only
 *   PLANETSCALE_DATABASE_URL="<branch url>" REHEARSAL_BRANCH_ID="<branch id>" \
 *     npx tsx scripts/config-v4/config-transform.ts --commit   # execute
 *
 * Flags: --commit (write; default dry-run) · --skip-hot (skip stage 4's 15M copy for fast structural iteration)
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { Dashboard } from "@/lib/ids";
import { assertRehearsalTarget, copyPoolConfig } from "./guard";
import { populateRegistries, type RowsExec } from "./registry-populate";

const BATCH = Number(process.env.CONFIG_V4_COPY_BATCH ?? 1_000_000);
const commit = process.argv.includes("--commit");
const skipHot = process.argv.includes("--skip-hot");

// ── timing ledger ────────────────────────────────────────────────────────────
const timings: { stage: string; ms: number }[] = [];
async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  timings.push({ stage, ms });
  console.log(`  ⏱  ${stage}: ${(ms / 1000).toFixed(1)}s`);
  return out;
}

async function main() {
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const db = requirePlanetscaleDb(); // getPool() already refuses the PROD db (assertDbEnvironmentMatches)
  const rows = async (text: string) =>
    (await db.execute(sql.raw(text))).rows as Record<string, unknown>[];
  const exec = (text: string) => db.execute(sql.raw(text));
  const one = async (text: string) => (await rows(text))[0];
  const scalar = async (text: string) =>
    Number(Object.values(await one(text))[0]);

  assertRehearsalTarget();

  // ── DRY RUN ────────────────────────────────────────────────────────────────
  if (!commit) {
    const systems = await scalar("SELECT count(*) FROM systems");
    const pointInfo = await scalar("SELECT count(*) FROM point_info");
    const areaLess = await scalar(
      "SELECT count(*) FROM systems s WHERE NOT EXISTS (SELECT 1 FROM areas a WHERE a.legacy_system_id = s.id)",
    );
    const prMin = await scalar(
      "SELECT coalesce(min(id),0) FROM point_readings",
    );
    const prMax = await scalar(
      "SELECT coalesce(max(id),0) FROM point_readings",
    );
    const badStatus = await scalar(
      "SELECT count(*) FROM systems WHERE status NOT IN ('active','disabled','removed')",
    );
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          systems,
          pointInfo,
          areasOfOneToMint: areaLess,
          hotRewrite: { pointReadingsIdRange: [prMin, prMax], batch: BATCH },
          preflight: {
            systemsWithUnmappableStatus: badStatus, // must be 0 (devices_status_check)
          },
        },
        null,
        2,
      ),
    );
    console.log("Dry-run only; rerun with --commit to execute.");
    return;
  }

  // ── STAGE 1: DDL ─────────────────────────────────────────────────────────────
  await timed("stage1:ddl", async () => {
    const ddl = readFileSync(join(__dirname, "cutover.sql"), "utf8");
    // Execute via the raw pg client's SIMPLE query protocol (like psql -f): runs all statements in one
    // shot and tolerates comment blocks. drizzle's db.execute uses the extended protocol (prepared),
    // which rejects multi-statement text and chokes on the header comment.
    const pool = new Pool({ ...copyPoolConfig(), max: 1 });
    try {
      await pool.query(ddl);
    } finally {
      await pool.end();
    }
  });

  // ── STAGE 2: registries ──────────────────────────────────────────────────────
  await timed("stage2:registries", async () => {
    // The additive population (2a–2c, 2f–2h + areas-of-one + day_offset_min) is single-sourced in
    // registry-populate.ts, shared VERBATIM with registry-sync.ts (which runs it dark at T-7d and as a
    // window top-up). Single-sourcing is what stops the two from drifting again — the live proof of past
    // drift was device_state's DO NOTHING here vs the DO UPDATE refresh in registry-sync.
    //
    // Wrapped in ONE transaction (stage 2 used to be a run of autocommitting statements): a mid-stage abort
    // can no longer strand prod with the areas renames applied but the registries half-populated.
    await db.transaction(async (tx) => {
      const exec2: RowsExec = async (q) =>
        (
          (await tx.execute(q)) as unknown as {
            rows: Record<string, unknown>[];
          }
        ).rows;
      const txRaw = (t: string) => tx.execute(sql.raw(t));
      await populateRegistries(exec2);

      // 2e. areas carryover RENAMES — IN-WINDOW ONLY (they break the deployed build), so they stay OUT of
      // the shared additive function. legacy_system_id + timezone_offset_min are RETAINED through the drain
      // (used as mapping keys); dropped in Phase 9. (2i's composite-delete was defect D-d → moved to
      // scripts/config-v4/retire-empty-composites.ts, a daylight cleanup; it is a prerequisite for nothing.)
      await renameColumnIfExists(
        txRaw,
        "areas",
        "owner_clerk_user_id",
        "owner_user_id",
      );
      await renameColumnIfExists(txRaw, "areas", "display_name", "name");
      await renameColumnIfExists(txRaw, "areas", "alias", "slug");
    });
  });

  // ── STAGE 4: hot-table rewrite ────────────────────────────────────────────────
  if (skipHot) {
    console.log("stage4:hot — SKIPPED (--skip-hot)");
  } else {
    await runHotRewrite();
  }

  // ── STAGE 5: config transform ────────────────────────────────────────────────
  await timed("stage5:config", async () => {
    // 5a. area_bindings → point_id uuid (FK → points). Rename the legacy int point_id → point_id_legacy,
    // add the uuid, backfill from (point_system_id, point_id_legacy) → point_info.point_uid. priority + role
    // CHECK already exist (0034/0032). The int pair + old FK die in Phase 9.
    await renameColumnIfExists(
      exec,
      "area_bindings",
      "point_id",
      "point_id_legacy",
    );
    await exec(
      "ALTER TABLE area_bindings ADD COLUMN IF NOT EXISTS point_id uuid",
    );
    await exec(`UPDATE area_bindings ab SET point_id = pi.point_uid
      FROM point_info pi WHERE pi.system_id = ab.point_system_id AND pi.id = ab.point_id_legacy AND ab.point_id IS NULL`);
    if (
      (await scalar(
        "SELECT count(*) FROM area_bindings WHERE point_id IS NULL",
      )) > 0
    )
      throw new Error("area_bindings.point_id NULL after backfill");
    await exec("ALTER TABLE area_bindings ALTER COLUMN point_id SET NOT NULL");
    await exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='area_bindings_point_id_points_fk') THEN
        ALTER TABLE area_bindings ADD CONSTRAINT area_bindings_point_id_points_fk FOREIGN KEY (point_id) REFERENCES points(id);
      END IF; END $$`);

    // 5b. device_trackers → derivations (run-detector, output=intervals; source points by uuid); then
    // device_run_periods → derived_intervals, re-keyed (system_id, role) → its area-of-one's derivation.
    await exec(`
      INSERT INTO derivations (id, area_id, kind, role, name, enabled, output, params, source_points, detector_version, created_at, updated_at)
      SELECT gen_random_uuid(),
             coalesce(t.area_id, (SELECT a.id FROM areas a WHERE a.legacy_system_id = t.system_id)),
             'run-detector', t.role, t.display_name, t.enabled, 'intervals',
             jsonb_strip_nulls(jsonb_build_object('signalKind', t.signal_kind, 'lowerW', t.lower_w, 'upperW', t.upper_w,
               'hysteresisW', t.hysteresis_w, 'delayOnSeconds', t.delay_on_seconds, 'delayOffSeconds', t.delay_off_seconds)),
             jsonb_strip_nulls(jsonb_build_object(
               'signal', (SELECT pi.point_uid FROM point_info pi WHERE pi.system_id=t.signal_system_id AND pi.id=t.signal_point_id),
               'energy', (SELECT pi.point_uid FROM point_info pi WHERE pi.system_id=t.energy_system_id AND pi.id=t.energy_point_id))),
             t.detector_version, t.created_at, t.updated_at
      FROM device_trackers t
      WHERE NOT EXISTS (SELECT 1 FROM derivations d
        WHERE d.role = t.role AND d.area_id = coalesce(t.area_id, (SELECT a.id FROM areas a WHERE a.legacy_system_id = t.system_id)))`);
    await exec(`
      INSERT INTO derived_intervals (derivation_id, start_time, end_time, duration_seconds, energy_kwh, max_power_w, min_power_w, avg_power_w, sample_count, detector_version, created_at, updated_at)
      SELECT d.id, rp.start_time, rp.end_time, rp.duration_seconds, rp.energy_kwh, rp.max_power_w, rp.min_power_w, rp.avg_power_w, rp.sample_count, rp.detector_version, rp.created_at, rp.updated_at
      FROM device_run_periods rp
      JOIN areas a ON a.legacy_system_id = rp.system_id
      JOIN derivations d ON d.area_id = a.id AND d.role = rp.role
      ON CONFLICT DO NOTHING`);
    // HWS-model derivation (output='point'): the modelled `load.hws/temperature` point is a normal
    // point_info row (already in `points`), produced from its sibling `load.hws/power`. One derivation per
    // temperature point, output_point_id = that point; source_points.power = the power point.
    await exec(`
      INSERT INTO derivations (id, area_id, kind, role, name, enabled, output, output_point_id, params, source_points, detector_version, created_at, updated_at)
      SELECT gen_random_uuid(), (SELECT a.id FROM areas a WHERE a.legacy_system_id = temp.system_id),
             'hws-model', NULL, 'Hot Water', true, 'point', temp.point_uid, '{}'::jsonb,
             jsonb_build_object('power', (SELECT p.point_uid FROM point_info p
               WHERE p.system_id=temp.system_id AND p.logical_path_stem='load.hws' AND p.metric_type='power' AND p.active LIMIT 1)),
             1, now(), now()
      FROM point_info temp
      WHERE temp.logical_path_stem='load.hws' AND temp.metric_type='temperature'
        AND NOT EXISTS (SELECT 1 FROM derivations d WHERE d.output_point_id = temp.point_uid)`);
    // wire the deferred derivations.output_point_id FK now that points + derivations rows exist (null-ok).
    await exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='derivations_output_point_id_points_fk') THEN
        ALTER TABLE derivations ADD CONSTRAINT derivations_output_point_id_points_fk FOREIGN KEY (output_point_id) REFERENCES points(id);
      END IF; END $$`);

    // 5c. dashboards: capture legacy_id, mint uuid, rewrite descriptor → v4 doc (TS rewriteV3ToV4), snapshot
    // revision 1. The int→uuid PK swap across users/grants/tokens is mechanical DDL — deferred to the next
    // tranche; the risky part (rewriting every real dashboard) is validated here.
    await exec(
      "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS legacy_id integer",
    );
    await exec("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS new_id uuid");
    await exec("UPDATE dashboards SET legacy_id = id WHERE legacy_id IS NULL");
    const { rewriteV3ToV4, pureAreaRef } = await import(
      "@/lib/dashboard/v3-to-v4"
    );
    const { DeviceRegistry } = await import("@/lib/registry");
    const dashRows = (
      await db.execute(
        sql.raw(
          "SELECT id, clerk_user_id AS owner, descriptor FROM dashboards WHERE doc IS NULL OR new_id IS NULL",
        ),
      )
    ).rows as Array<{ id: number; owner: string; descriptor: unknown }>;
    let rewritten = 0;
    const failures: string[] = [];
    for (const d of dashRows) {
      try {
        const v3 = d.descriptor as {
          sections?: Array<{
            cards?: Array<{
              deviceSystemId?: number;
              tiles?: Array<{ deviceSystemId?: number }>;
            }>;
          }>;
        };
        const pins = new Set<number>();
        for (const s of v3.sections ?? [])
          for (const c of s.cards ?? []) {
            if (c.deviceSystemId != null) pins.add(c.deviceSystemId);
            for (const t of c.tiles ?? [])
              if (t.deviceSystemId != null) pins.add(t.deviceSystemId);
          }
        const mapped = await DeviceRegistry.addrsForHandles([...pins]);
        const missing = [...pins].filter((p) => !mapped.has(p));
        if (missing.length)
          throw new Error(`missing device mapping: ${missing.join(",")}`);
        const resolver = {
          areaRef: pureAreaRef,
          deviceRef: (h: number) => mapped.get(h)!.deviceId,
        };
        const doc = rewriteV3ToV4(
          d.descriptor as Parameters<typeof rewriteV3ToV4>[0],
          resolver,
        );
        const uuid = Dashboard.toUuid(Dashboard.generate());
        await db.execute(
          sql`UPDATE dashboards SET doc = ${doc as object}, new_id = ${uuid} WHERE id = ${d.id}`,
        );
        await db.execute(sql`
          INSERT INTO dashboard_revisions (dashboard_id, revision, doc, saved_by, saved_at)
          VALUES (${uuid}, 1, ${doc as object}, ${d.owner}, now()) ON CONFLICT DO NOTHING`);
        rewritten++;
      } catch (e) {
        failures.push(
          `dashboard ${d.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    console.log(
      `     dashboards: ${rewritten} rewritten, ${failures.length} failed`,
    );
    if (failures.length)
      throw new Error(`dashboard rewrite failures:\n${failures.join("\n")}`);
  });

  // ── STAGE 5d: dashboards int→uuid PK swap + re-key dependents (mechanical DDL) ─────────────────────
  await timed("stage5:dash-swap", async () => {
    // Re-key each dependent's dashboard ref to the new uuid (via dashboards.legacy_id → new_id).
    await exec(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS default_dashboard_id_uuid uuid",
    );
    await exec(
      "UPDATE users u SET default_dashboard_id_uuid = d.new_id FROM dashboards d WHERE d.legacy_id = u.default_dashboard_id",
    );
    await exec(
      "ALTER TABLE dashboard_grants ADD COLUMN IF NOT EXISTS dashboard_id_uuid uuid",
    );
    await exec(
      "UPDATE dashboard_grants g SET dashboard_id_uuid = d.new_id FROM dashboards d WHERE d.legacy_id = g.dashboard_id",
    );

    // Unify share_tokens: fold dashboard_share_tokens 1:1 (dashboard_id uuid + epoch-ms→timestamptz). Legacy
    // owner-scoped tokens stay dashboard_id NULL through the fold; they are re-pointed at an auto-created
    // dashboard AFTER the PK swap below (which needs dashboards.id to be uuid first), then dashboard_id is
    // flipped NOT NULL. (Dropping owner_clerk_user_id + the *_ms columns is still Phase 9.)
    for (const c of [
      "dashboard_id uuid",
      "created_at timestamp",
      "expires_at timestamp",
      "revoked_at timestamp",
      "last_used_at timestamp",
    ])
      await exec(`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS ${c}`);
    await exec(`UPDATE share_tokens SET created_at=to_timestamp(created_at_ms/1000.0),
      expires_at=to_timestamp(expires_at_ms/1000.0), revoked_at=to_timestamp(revoked_at_ms/1000.0),
      last_used_at=to_timestamp(last_used_at_ms/1000.0) WHERE created_at IS NULL AND created_at_ms IS NOT NULL`);
    // The unified table drops owner_clerk_user_id + the epoch-ms columns; the legacy table still marks
    // owner_clerk_user_id + created_at_ms NOT NULL, which the owner-less/timestamptz fold can't satisfy.
    // Retire those NOT NULLs (the columns themselves die in Phase 9).
    await exec(
      "ALTER TABLE share_tokens ALTER COLUMN owner_clerk_user_id DROP NOT NULL",
    );
    await exec(
      "ALTER TABLE share_tokens ALTER COLUMN created_at_ms DROP NOT NULL",
    );
    await exec(`INSERT INTO share_tokens (token, dashboard_id, label, created_at, expires_at, revoked_at, last_used_at)
      SELECT dst.token, d.new_id, dst.label, to_timestamp(dst.created_at_ms/1000.0),
             to_timestamp(dst.expires_at_ms/1000.0), to_timestamp(dst.revoked_at_ms/1000.0), to_timestamp(dst.last_used_at_ms/1000.0)
      FROM dashboard_share_tokens dst JOIN dashboards d ON d.legacy_id = dst.dashboard_id
      ON CONFLICT (token) DO NOTHING`);

    // Drop every FK referencing dashboards (drizzle-generated names vary) → swap the PK int→uuid → re-wire.
    await exec(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT conname, conrelid::regclass AS tbl FROM pg_constraint WHERE contype='f' AND confrelid='dashboards'::regclass LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
      END LOOP; END $$`);
    await exec(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dashboards' AND column_name='id' AND data_type='integer') THEN
        ALTER TABLE dashboards DROP CONSTRAINT dashboards_pkey;
        ALTER TABLE dashboards DROP COLUMN id;
        ALTER TABLE dashboards RENAME COLUMN new_id TO id;
        ALTER TABLE dashboards ADD PRIMARY KEY (id);
        -- D-a: new_id is a plain uuid column, so the promoted PK inherits NO default. createDashboard
        -- (lib/dashboard/dashboards.ts) inserts without an id, which would be 23502 on the first POST
        -- after the window. No parity check covered this.
        ALTER TABLE dashboards ALTER COLUMN id SET DEFAULT gen_random_uuid();
        ALTER TABLE dashboards ADD CONSTRAINT dashboards_legacy_id_unique UNIQUE (legacy_id);
        ALTER TABLE dashboards ALTER COLUMN doc SET NOT NULL;
      END IF; END $$`);
    await renameColumnIfExists(
      exec,
      "dashboards",
      "clerk_user_id",
      "owner_user_id",
    );
    await renameColumnIfExists(exec, "dashboards", "display_name", "name");
    await renameColumnIfExists(exec, "dashboards", "alias", "slug");

    // Finalize dependents: swap the uuid column in + re-add the FK → dashboards(id).
    // D-b: `DROP COLUMN` silently takes the indexes that column participated in with it.
    // `users_default_dashboard_idx` (0016) and `dashboard_grants_dashboard_user_unique` (0012) both die
    // here and MUST be recreated — the latter is the arbiter of createGrant's onConflictDoUpdate, so
    // without it grant creation is 42P10 and duplicate grants become insertable. No parity check covered
    // this either; both are recreated below against the new uuid column.
    await exec(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='default_dashboard_id' AND data_type='integer') THEN
        ALTER TABLE users DROP COLUMN default_dashboard_id;
        ALTER TABLE users RENAME COLUMN default_dashboard_id_uuid TO default_dashboard_id;
        ALTER TABLE users ADD CONSTRAINT users_default_dashboard_id_dashboards_fk FOREIGN KEY (default_dashboard_id) REFERENCES dashboards(id) ON DELETE SET NULL;
      END IF; END $$`);
    await exec(
      `CREATE INDEX IF NOT EXISTS users_default_dashboard_idx ON users (default_dashboard_id)`,
    );
    await exec(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dashboard_grants' AND column_name='dashboard_id' AND data_type='integer') THEN
        ALTER TABLE dashboard_grants DROP COLUMN dashboard_id;
        ALTER TABLE dashboard_grants RENAME COLUMN dashboard_id_uuid TO dashboard_id;
        ALTER TABLE dashboard_grants ADD CONSTRAINT dashboard_grants_dashboard_id_dashboards_fk FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE;
      END IF; END $$`);
    await exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS dashboard_grants_dashboard_user_unique
         ON dashboard_grants (dashboard_id, clerk_user_id)`,
    );
    await exec(
      `CREATE INDEX IF NOT EXISTS dashboard_grants_user_idx ON dashboard_grants (clerk_user_id)`,
    );
    // dashboard_revisions.dashboard_id is already uuid (0033) — wire its deferred FK; and share_tokens'.
    await exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dashboard_revisions_dashboard_id_dashboards_fk') THEN
        ALTER TABLE dashboard_revisions ADD CONSTRAINT dashboard_revisions_dashboard_id_dashboards_fk FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='share_tokens_dashboard_id_dashboards_fk') THEN
        ALTER TABLE share_tokens ADD CONSTRAINT share_tokens_dashboard_id_dashboards_fk FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE;
      END IF; END $$`);
    // ── Grant reshape (clean-sheet §4.6): role CHECK(admin/viewer) + user_id + timestamptz + composite PK. ──
    // owner→admin FIRST (Simon's decision — no access loss), so the CHECK below can't fail on a legacy row.
    // Idempotent: 0 owner rows on a re-run.
    await exec(
      "UPDATE dashboard_grants SET role = 'admin' WHERE role = 'owner'",
    );
    await exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_grants_role_check') THEN
        ALTER TABLE dashboard_grants ADD CONSTRAINT dashboard_grants_role_check CHECK (role IN ('admin','viewer'));
      END IF; END $$`);
    // clerk_user_id → user_id (the unique + user indexes recreated above auto-track the column rename).
    await renameColumnIfExists(
      exec,
      "dashboard_grants",
      "clerk_user_id",
      "user_id",
    );
    // created_at_ms (bigint) → created_at (timestamptz), mirroring the share_tokens fold. The _ms column
    // dies in Phase 9; drop its NOT NULL so the timestamptz is the source of truth.
    await exec(
      "ALTER TABLE dashboard_grants ADD COLUMN IF NOT EXISTS created_at timestamp",
    );
    await exec(`UPDATE dashboard_grants SET created_at = to_timestamp(created_at_ms/1000.0)
      WHERE created_at IS NULL AND created_at_ms IS NOT NULL`);
    await exec(
      "ALTER TABLE dashboard_grants ALTER COLUMN created_at SET NOT NULL",
    );
    await exec(
      "ALTER TABLE dashboard_grants ALTER COLUMN created_at_ms DROP NOT NULL",
    );
    // PK reshape → (dashboard_id, user_id): promote the recreated unique index (now on the renamed columns)
    // straight into the PK — no rebuild, and it stays the arbiter of createGrant's onConflictDoUpdate.
    // (ADD CONSTRAINT … USING INDEX renames the index to the constraint name dashboard_grants_pk.)
    await exec(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dashboard_grants' AND column_name='id') THEN
        ALTER TABLE dashboard_grants ALTER COLUMN dashboard_id SET NOT NULL;
        ALTER TABLE dashboard_grants ALTER COLUMN user_id SET NOT NULL;
        ALTER TABLE dashboard_grants DROP CONSTRAINT dashboard_grants_pkey;
        ALTER TABLE dashboard_grants DROP COLUMN id;
        ALTER TABLE dashboard_grants
          ADD CONSTRAINT dashboard_grants_pk PRIMARY KEY USING INDEX dashboard_grants_dashboard_user_unique;
      END IF; END $$`);

    // ── Owner-token auto-create: unify the last legacy owner-scoped share_token onto a dashboard. ──
    // The fold above re-pointed every dashboard-scoped token 1:1; a legacy OWNER-scoped token (owner_clerk_
    // user_id set, dashboard_id still NULL) granted read of ALL the owner's systems. Re-point it at an
    // auto-created dashboard whose sections are the owner's areas (every device now has an area-of-one), so
    // the token's owner-wide scope is preserved. Runs AFTER the PK swap so dashboards.id is uuid.
    // Idempotent: the predicate + deterministic slug + ON CONFLICT converge on a re-run.
    // SCOPE (decided): the token is OWNER-scoped ("all the owner's systems"), so the faithful re-point is a
    // dashboard over ALL the owner's areas — this preserves (never narrows) the grant. Narrowing to what the
    // sole live consumer (the owner-scoped /labs/kinkora-hws page, which reads the retained legacy row until
    // Group B) happens to show would conflate the token's grant with one consumer's use, and risk a lockout.
    // authz-check AC2d asserts the kinkora load.hws scope survives. To narrow instead, filter `areas` here.
    const { rewriteV3ToV4, pureAreaRef } = await import(
      "@/lib/dashboard/v3-to-v4"
    );
    const ownerTokenRows = (
      await db.execute(
        sql.raw(
          "SELECT token, owner_clerk_user_id AS owner FROM share_tokens WHERE dashboard_id IS NULL AND owner_clerk_user_id IS NOT NULL",
        ),
      )
    ).rows as Array<{ token: string; owner: string }>;
    for (const t of ownerTokenRows) {
      await db.transaction(async (tx) => {
        const areas = (
          await tx.execute(
            sql`SELECT id FROM areas WHERE owner_user_id = ${t.owner} ORDER BY id`,
          )
        ).rows as Array<{ id: string }>;
        const v3 = {
          version: 3 as const,
          sections: areas.map((a) => ({ areaId: a.id, cards: [] })),
        };
        const doc = rewriteV3ToV4(v3, {
          areaRef: pureAreaRef,
          deviceRef: () => {
            throw new Error(
              "owner-token dashboard has no device-pinned cards — deviceRef must not be called",
            );
          },
        });
        const slug = `legacy-share-${t.token}`;
        await tx.execute(sql`
          INSERT INTO dashboards (owner_user_id, name, slug, descriptor, doc, revision, created_at, updated_at)
          VALUES (${t.owner}, 'Shared view', ${slug}, ${v3 as object}, ${doc as object}, 1, now(), now())
          ON CONFLICT (owner_user_id, slug) DO NOTHING`);
        const dash = (
          await tx.execute(
            sql`SELECT id FROM dashboards WHERE owner_user_id = ${t.owner} AND slug = ${slug}`,
          )
        ).rows as Array<{ id: string }>;
        const dashId = dash[0].id;
        await tx.execute(sql`
          INSERT INTO dashboard_revisions (dashboard_id, revision, doc, saved_by, saved_at)
          VALUES (${dashId}, 1, ${doc as object}, ${t.owner}, now()) ON CONFLICT DO NOTHING`);
        await tx.execute(
          sql`UPDATE share_tokens SET dashboard_id = ${dashId} WHERE token = ${t.token} AND dashboard_id IS NULL`,
        );
      });
    }
    if (ownerTokenRows.length)
      console.log(
        `     re-pointed ${ownerTokenRows.length} legacy owner-scoped share_token(s) at auto-created dashboard(s)`,
      );

    // Every token now maps to a dashboard → flip NOT NULL. The explicit guard names the cause (like the
    // 0030/0032 RAISE-EXCEPTION pre-checks) rather than surfacing a raw 23502.
    const stillNull = await scalar(
      "SELECT count(*) FROM share_tokens WHERE dashboard_id IS NULL",
    );
    if (stillNull > 0)
      throw new Error(
        `${stillNull} share_token(s) still have NULL dashboard_id — owner-token auto-create incomplete`,
      );
    await exec(
      "ALTER TABLE share_tokens ALTER COLUMN dashboard_id SET NOT NULL",
    );

    // NOTE deferred (Phase 9 teardown): drop descriptor + the legacy *_ms / owner_clerk_user_id columns
    // + the _old hot tables + the backlog-drain address map.
  });

  console.log("\n=== timing summary ===");
  for (const t of timings)
    console.log(`  ${t.stage.padEnd(22)} ${(t.ms / 1000).toFixed(1)}s`);
  const totalMs = timings.reduce((a, t) => a + t.ms, 0);
  console.log(`  ${"TOTAL".padEnd(22)} ${(totalMs / 1000).toFixed(1)}s`);
  // persist for window-report.ts (the go/no-go verdict reads this).
  const timingsFile =
    process.env.CONFIG_V4_TIMINGS_FILE ??
    join(process.cwd(), ".context", "config-v4-timings.json");
  try {
    mkdirSync(dirname(timingsFile), { recursive: true });
    writeFileSync(
      timingsFile,
      JSON.stringify({ timings, totalMs, skipHot }, null, 2),
    );
    console.log(`  (timings → ${timingsFile})`);
  } catch {
    /* best-effort */
  }

  // ── stage 4 body (dedicated single connection: pins synchronous_commit/maintenance_work_mem across the copy) ──
  async function runHotRewrite() {
    const pool = new Pool({ ...copyPoolConfig(), max: 1 });
    const c = await pool.connect();
    try {
      await c.query("SET synchronous_commit = off");
      await c.query("SET statement_timeout = 0"); // 15M-row index builds are long; don't let a default timeout kill them
      // PS-5 (prod's size) has only 512MB RAM — a 512MB maintenance_work_mem OOMs the backend (57P01).
      // A modest value spills the index sort to disk (slower) but survives. This is a real prod constraint.
      await c.query(
        `SET maintenance_work_mem = '${process.env.CONFIG_V4_MAINT_WORK_MEM ?? "96MB"}'`,
      );

      await timed("stage4:create-twins", async () => {
        await c.query(
          `DROP TABLE IF EXISTS point_readings_new, point_readings_agg_5m_new, point_readings_agg_1d_new`,
        );
        await c.query(`CREATE TABLE point_readings_new (
          point_rid integer NOT NULL, session_id text, measurement_time timestamp NOT NULL,
          received_time timestamp NOT NULL, value double precision, value_str text, error text,
          data_quality text NOT NULL DEFAULT 'good', created_at timestamp NOT NULL DEFAULT now())`);
        await c.query(`CREATE TABLE point_readings_agg_5m_new (
          point_rid integer NOT NULL, session_id text, interval_end timestamp NOT NULL,
          avg double precision, min double precision, max double precision, last double precision,
          delta double precision, value_str text, sample_count integer NOT NULL, error_count integer NOT NULL,
          data_quality text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())`);
        await c.query(`CREATE TABLE point_readings_agg_1d_new (
          point_rid integer NOT NULL, day text NOT NULL, avg double precision, min double precision,
          max double precision, last double precision, delta double precision, sample_count integer NOT NULL,
          error_count integer NOT NULL, created_at timestamp NOT NULL DEFAULT now(),
          updated_at timestamp NOT NULL DEFAULT now())`);
      });

      // point_readings: batched on the serial id (each batch a timing sample), JOIN point_info for rid.
      const { rows: rng } = await c.query(
        "SELECT coalesce(min(id),0) lo, coalesce(max(id),0) hi FROM point_readings",
      );
      const lo = Number(rng[0].lo),
        hi = Number(rng[0].hi);
      await timed("stage4:copy-raw", async () => {
        for (let b = lo; b <= hi; b += BATCH) {
          const t0 = Date.now();
          const res = await c.query(
            `INSERT INTO point_readings_new (point_rid, session_id, measurement_time, received_time, value, value_str, error, data_quality, created_at)
             SELECT pi.rid, pr.session_id, pr.measurement_time, pr.received_time, pr.value, pr.value_str, pr.error, pr.data_quality, pr.created_at
             FROM point_readings pr JOIN point_info pi ON pi.system_id = pr.system_id AND pi.id = pr.point_id
             WHERE pr.id >= $1 AND pr.id < $2`,
            [b, b + BATCH],
          );
          console.log(
            `       raw batch [${b}, ${b + BATCH}): ${res.rowCount} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
          );
        }
      });
      await timed("stage4:copy-5m", async () => {
        await c.query(`INSERT INTO point_readings_agg_5m_new
          (point_rid, session_id, interval_end, avg, min, max, last, delta, value_str, sample_count, error_count, data_quality, created_at, updated_at)
          SELECT pi.rid, a.session_id, a.interval_end, a.avg, a.min, a.max, a.last, a.delta, a.value_str, a.sample_count, a.error_count, a.data_quality, a.created_at, a.updated_at
          FROM point_readings_agg_5m a JOIN point_info pi ON pi.system_id = a.system_id AND pi.id = a.point_id`);
      });
      await timed("stage4:copy-1d", async () => {
        await c.query(`INSERT INTO point_readings_agg_1d_new
          (point_rid, day, avg, min, max, last, delta, sample_count, error_count, created_at, updated_at)
          SELECT pi.rid, a.day, a.avg, a.min, a.max, a.last, a.delta, a.sample_count, a.error_count, a.created_at, a.updated_at
          FROM point_readings_agg_1d a JOIN point_info pi ON pi.system_id = a.system_id AND pi.id = a.point_id`);
      });

      await timed("stage4:indexes", async () => {
        await c.query(
          `ALTER TABLE point_readings_new ADD CONSTRAINT point_readings_new_pkey PRIMARY KEY (point_rid, measurement_time)`,
        );
        await c.query(
          `CREATE INDEX pr_new_measurement_time_idx ON point_readings_new (measurement_time)`,
        );
        await c.query(
          `CREATE INDEX pr_new_created_at_idx ON point_readings_new (created_at)`,
        );
        await c.query(
          `ALTER TABLE point_readings_new ADD CONSTRAINT pr_new_point_fk FOREIGN KEY (point_rid) REFERENCES points(rid) NOT VALID`,
        );
        await c.query(
          `ALTER TABLE point_readings_new ADD CONSTRAINT pr_new_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) NOT VALID`,
        );
        await c.query(
          `ALTER TABLE point_readings_agg_5m_new ADD CONSTRAINT pr5m_new_pkey PRIMARY KEY (point_rid, interval_end)`,
        );
        await c.query(
          `CREATE INDEX pr5m_new_interval_end_idx ON point_readings_agg_5m_new (interval_end)`,
        );
        await c.query(
          `CREATE INDEX pr5m_new_created_at_idx ON point_readings_agg_5m_new (created_at)`,
        );
        await c.query(
          `CREATE INDEX pr5m_new_updated_at_idx ON point_readings_agg_5m_new (updated_at)`,
        ); // keep the sync watermark
        await c.query(
          `ALTER TABLE point_readings_agg_5m_new ADD CONSTRAINT pr5m_new_point_fk FOREIGN KEY (point_rid) REFERENCES points(rid) NOT VALID`,
        );
        await c.query(
          `ALTER TABLE point_readings_agg_1d_new ADD CONSTRAINT pr1d_new_pkey PRIMARY KEY (point_rid, day)`,
        );
        await c.query(
          `CREATE INDEX pr1d_new_day_idx ON point_readings_agg_1d_new (day)`,
        );
        await c.query(
          `ALTER TABLE point_readings_agg_1d_new ADD CONSTRAINT pr1d_new_point_fk FOREIGN KEY (point_rid) REFERENCES points(rid) NOT VALID`,
        );
      });

      // D-e: ANALYZE BEFORE the swap, while nothing reads the twins. Without it the serving path resumes
      // against ~21M rows of brand-new heap with ZERO planner statistics and will happily choose seq
      // scans — the most likely cause of a "the cutover worked but the site is dead" outcome. Invisible on
      // an idle rehearsal branch, which is exactly why it was missed. Also restores the `n_live_tup` that
      // the pg-backup restore drill's `min-row-ratio` compares against.
      await timed("stage4:analyze", async () => {
        await c.query(
          "ANALYZE point_readings_new, point_readings_agg_5m_new, point_readings_agg_1d_new",
        );
      });

      // rename-swap: bounded ACCESS EXCLUSIVE. lock_timeout so a long reader can't stall it into a read pile-up
      // (reads are NOT paused at the real cutover). Keep _old as the abort path + until parity is green (Phase 9 drops).
      //
      // D-f: bounded RETRY, not a bare rethrow. C8 asked for retry; the original aborted the whole run on
      // the first lock timeout, discarding the ~6-minute copy. On prod there ARE live readers (serving,
      // plus `/api/cron/run-periods` every minute), so losing the race once is likely, not exotic.
      // synchronous_commit is restored to `on` for THIS commit: it is off from the copy above, and this is
      // the one commit in the cutover we must not lose to an HA failover.
      //
      // NB the twins keep their `_new` index/constraint names (D-g). They CANNOT be renamed to canonical
      // here: `_old` is retained through Phase 8 and still owns `pr_point_time_unique`,
      // `pr_measurement_time_idx`, … — index names are schema-unique, so renaming inside this txn is 42P07
      // and would roll the swap back after the full copy. Phase 9 renames them once `_old` is dropped.
      await timed("stage4:swap", async () => {
        await c.query("SET synchronous_commit = on");
        await c.query("SET lock_timeout = '3s'");
        const MAX_ATTEMPTS = 10;
        for (let attempt = 1; ; attempt++) {
          await c.query("BEGIN");
          try {
            await c.query(
              "ALTER TABLE point_readings RENAME TO point_readings_old",
            );
            await c.query(
              "ALTER TABLE point_readings_new RENAME TO point_readings",
            );
            await c.query(
              "ALTER TABLE point_readings_agg_5m RENAME TO point_readings_agg_5m_old",
            );
            await c.query(
              "ALTER TABLE point_readings_agg_5m_new RENAME TO point_readings_agg_5m",
            );
            await c.query(
              "ALTER TABLE point_readings_agg_1d RENAME TO point_readings_agg_1d_old",
            );
            await c.query(
              "ALTER TABLE point_readings_agg_1d_new RENAME TO point_readings_agg_1d",
            );
            await c.query("COMMIT");
            if (attempt > 1) console.log(`     swap won on attempt ${attempt}`);
            return;
          } catch (e) {
            await c.query("ROLLBACK").catch(() => {});
            const code = (e as { code?: string }).code;
            // 55P03 lock_not_available / 40P01 deadlock_detected — both mean "someone else held it".
            const retryable = code === "55P03" || code === "40P01";
            if (!retryable || attempt >= MAX_ATTEMPTS) throw e;
            // Name the blocker so the operator can decide whether to terminate it.
            try {
              const { rows } = await c.query(
                `SELECT a.pid, a.state, now() - a.xact_start AS age, left(a.query, 120) AS query
                   FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
                  WHERE l.relation IN ('point_readings'::regclass, 'point_readings_agg_5m'::regclass,
                                       'point_readings_agg_1d'::regclass)
                    AND a.pid <> pg_backend_pid()`,
              );
              console.warn(
                `     swap attempt ${attempt}/${MAX_ATTEMPTS} blocked (${code}); holders:`,
                rows,
              );
            } catch {
              console.warn(`     swap attempt ${attempt} blocked (${code})`);
            }
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      });
    } finally {
      c.release();
      await pool.end();
    }
  }
}

// ── guards / helpers ───────────────────────────────────────────────────────────
// (row-count guards now live inside populateRegistries — registry-populate.ts — single-sourced with
// registry-sync.ts.)
async function renameColumnIfExists(
  exec: (t: string) => Promise<unknown>,
  table: string,
  from: string,
  to: string,
) {
  await exec(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='${table}' AND column_name='${from}')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='${table}' AND column_name='${to}') THEN
      ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to};
    END IF; END $$`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
