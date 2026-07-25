#!/usr/bin/env tsx
/**
 * config-v4 parity check (Phase 7). Compares the pre-transform composite `_old` tables against the
 * rid-keyed twins + registry integrity, on a rehearsal branch. Non-zero exit on any red.
 *
 * Everything is a SERVER-SIDE aggregate: a per-column content check is `sum` of a per-row md5 hash
 * (order-independent, bounded memory — never materializes 15M rows client-side, so ~0 egress and no OOM
 * from a giant string_agg). The hash includes the mapped key (point_rid vs the old system_id/point_id →
 * point_info.rid), so it proves the rid re-key is correct row-by-row, not just that the multisets match.
 *
 * Usage (on the branch, AFTER config-transform.ts --commit):
 *   PLANETSCALE_DATABASE_URL="<branch url>" REHEARSAL_BRANCH_ID="<branch id>" \
 *     npx tsx scripts/config-v4/parity-check.ts
 *
 * TARGET MODES (guard.ts). `CONFIG_V4_TARGET` defaults to `rehearsal`; the branch-id var is the positive
 * proof of the mode. `PLANETSCALE_PROD_BRANCH_ID` is required in ALL modes (it is the only way to
 * recognise prod). Prod additionally needs `ALLOW_PROD_DB_IN_DEV=true`, because `@/lib/db/planetscale`
 * refuses a prod connection outside production BEFORE the guard ever runs:
 *   rehearsal:  REHEARSAL_BRANCH_ID="<branch id>"
 *   dev:        CONFIG_V4_TARGET=dev LIVEONE_DEV_BRANCH_ID="<branch id>"
 *   prod:       CONFIG_V4_TARGET=prod ALLOW_PROD_DB_IN_DEV=true   … --i-understand-this-is-prod
 *
 * `--quiescence` runs the PRE-stage-4 gate instead (hot tables static? see `quiescence()` at the foot of
 * this file) — the only automated detector of an incomplete materialization pause, and the only one that
 * fires BEFORE the irreversible swap rather than after it.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { assertRehearsalTarget } from "./guard";

// Order-independent, bounded-memory content checksum over the listed columns (returned as text for exact
// compare). `('x'||<16 hex>)::bit(64)::bigint` folds each row's md5 to a signed 64-bit int; sum() → numeric.
const CK = (cols: string) =>
  `sum(('x' || substr(md5(ROW(${cols})::text), 1, 16))::bit(64)::bigint)::text`;

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail: string }[] = [];

/** Quiescence hold, in SECONDS. The writers it watches run on a 60s cron cadence (vercel.json:
 *  `/api/cron/minutely` + `/api/cron/relay-outbox` are `* * * * *`), so the default is >2x that — a hold
 *  equal to the cadence cannot tell "paused" from "between ticks". */
const DEFAULT_QUIESCE_SEC = 150;
const MIN_QUIESCE_SEC = 120;

async function main() {
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const db = requirePlanetscaleDb();
  assertRehearsalTarget();
  const scalar = async (text: string) => {
    const rows = (await db.execute(sql.raw(text))).rows as Record<
      string,
      unknown
    >[];
    return rows.length ? String(Object.values(rows[0])[0] ?? "∅") : "∅";
  };

  if (process.argv.includes("--quiescence")) return quiescence(scalar);

  // compare two scalar queries; SKIP (not FAIL) if a table is missing (e.g. run before the swap).
  const cmp = async (name: string, aSql: string, bSql: string) => {
    try {
      const [a, b] = [await scalar(aSql), await scalar(bSql)];
      results.push({
        name,
        status: a === b ? "PASS" : "FAIL",
        detail: a === b ? a : `old=${a} new=${b}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        name,
        status: /does not exist/.test(msg) ? "SKIP" : "FAIL",
        detail: msg.split("\n")[0],
      });
    }
  };
  const expect = async (name: string, aSql: string, want: string) => {
    try {
      const a = await scalar(aSql);
      results.push({
        name,
        status: a === want ? "PASS" : "FAIL",
        detail: a === want ? a : `got=${a} want=${want}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        name,
        status: /does not exist/.test(msg) ? "SKIP" : "FAIL",
        detail: msg.split("\n")[0],
      });
    }
  };

  // ── HOT: row counts + per-column content (P1 + C2), _old vs twin ───────────────
  const prNew =
    "point_rid, measurement_time, received_time, value, value_str, error, data_quality, session_id, created_at";
  const prOld =
    "pi.rid, pr.measurement_time, pr.received_time, pr.value, pr.value_str, pr.error, pr.data_quality, pr.session_id, pr.created_at";
  await cmp(
    "P1 point_readings rowcount",
    "SELECT count(*)::text FROM point_readings_old",
    "SELECT count(*)::text FROM point_readings",
  );
  await cmp(
    "C2 point_readings content",
    `SELECT ${CK(prOld)} FROM point_readings_old pr JOIN point_info pi ON pi.system_id=pr.system_id AND pi.id=pr.point_id`,
    `SELECT ${CK(prNew)} FROM point_readings`,
  );

  const a5New =
    "point_rid, interval_end, session_id, avg, min, max, last, delta, value_str, sample_count, error_count, data_quality, created_at, updated_at";
  const a5Old =
    "pi.rid, a.interval_end, a.session_id, a.avg, a.min, a.max, a.last, a.delta, a.value_str, a.sample_count, a.error_count, a.data_quality, a.created_at, a.updated_at";
  await cmp(
    "P1 agg_5m rowcount",
    "SELECT count(*)::text FROM point_readings_agg_5m_old",
    "SELECT count(*)::text FROM point_readings_agg_5m",
  );
  await cmp(
    "C2 agg_5m content",
    `SELECT ${CK(a5Old)} FROM point_readings_agg_5m_old a JOIN point_info pi ON pi.system_id=a.system_id AND pi.id=a.point_id`,
    `SELECT ${CK(a5New)} FROM point_readings_agg_5m`,
  );

  const a1New =
    "point_rid, day, avg, min, max, last, delta, sample_count, error_count, created_at, updated_at";
  const a1Old =
    "pi.rid, a.day, a.avg, a.min, a.max, a.last, a.delta, a.sample_count, a.error_count, a.created_at, a.updated_at";
  await cmp(
    "P1 agg_1d rowcount",
    "SELECT count(*)::text FROM point_readings_agg_1d_old",
    "SELECT count(*)::text FROM point_readings_agg_1d",
  );
  await cmp(
    "C2/P4 agg_1d content (incl. day)",
    `SELECT ${CK(a1Old)} FROM point_readings_agg_1d_old a JOIN point_info pi ON pi.system_id=a.system_id AND pi.id=a.point_id`,
    `SELECT ${CK(a1New)} FROM point_readings_agg_1d`,
  );

  // ── REGISTRY: counts + points non-key fidelity + rid-set match ─────────────────
  await cmp(
    "devices == systems",
    "SELECT count(*)::text FROM systems",
    "SELECT count(*)::text FROM devices",
  );
  await cmp(
    "points == point_info",
    "SELECT count(*)::text FROM point_info",
    "SELECT count(*)::text FROM points",
  );
  await cmp(
    "device_state == polling_status",
    "SELECT count(*)::text FROM polling_status",
    "SELECT count(*)::text FROM device_state",
  );
  await cmp(
    "area_members == area_devices(mapped)",
    "SELECT count(*)::text FROM area_devices ad JOIN legacy_handles lh ON lh.handle=ad.system_id AND lh.device_id IS NOT NULL",
    "SELECT count(*)::text FROM area_members",
  );
  // points carry point_info's attributes verbatim (rid + all non-key cols); proves transform/metric fidelity.
  const ptNew =
    "rid, physical_path, logical_path, metric_type, unit, name, default_name, subsystem, transform, active";
  const ptOld =
    "rid, physical_path_tail, logical_path_stem, metric_type, metric_unit, display_name, point_name, subsystem, transform, active";
  await cmp(
    "C9 points attribute fidelity",
    `SELECT ${CK(ptOld)} FROM point_info`,
    `SELECT ${CK(ptNew)} FROM points`,
  );
  await cmp(
    "points.rid set == point_info.rid",
    "SELECT sum(rid)::text FROM point_info",
    "SELECT sum(rid)::text FROM points",
  );
  await expect(
    "every device has an area-of-one",
    "SELECT count(*)::text FROM devices WHERE primary_area_id IS NULL",
    "0",
  );

  // ── CONFIG (stage 5) — SKIP cleanly until stage 5 lands ────────────────────────
  // 5a is ADDITIVE: `point_uid` is the new dark uuid, `point_id` stays the live int. Both halves are
  // asserted — the second is the regression guard for that decision. Putting the uuid IN `point_id` (an
  // earlier draft) is a silent type flip: schema.ts declares it `integer`, so every drizzle reader keeps
  // compiling and returns a uuid string, breaking area point-resolution (swallowed by access.ts's
  // catch) and poisoning the KV subscription registry — with nothing anywhere to detect it.
  await expect(
    "5a area_bindings.point_uid backfilled",
    "SELECT count(*)::text FROM area_bindings WHERE point_uid IS NULL",
    "0",
  );
  await expect(
    "5a area_bindings.point_id still integer (no silent type flip)",
    "SELECT coalesce((SELECT data_type='integer' FROM information_schema.columns WHERE table_name='area_bindings' AND column_name='point_id'), false)::text",
    "true",
  );
  // `point_uid` MUST stay nullable. schema.ts does not declare it, so neither INSERT site
  // (lib/areas/create.ts, lib/battery-provenance/register.ts) emits it — a NOT NULL here 23502s the first
  // binding write after resume, past the one-way door. Phase 9 tightens it with the writers.
  await expect(
    "5a area_bindings.point_uid is NULLABLE (writers don't emit it yet)",
    "SELECT coalesce((SELECT is_nullable='YES' FROM information_schema.columns WHERE table_name='area_bindings' AND column_name='point_uid'), false)::text",
    "true",
  );
  // The uuid must actually resolve to the point the int pair names — a NOT NULL count proves neither
  // correctness nor that the two columns agree.
  await expect(
    "5a area_bindings.point_uid agrees with (point_system_id, point_id)",
    `SELECT count(*)::text FROM area_bindings ab
       LEFT JOIN point_info pi ON pi.system_id = ab.point_system_id AND pi.id = ab.point_id
      WHERE pi.point_uid IS DISTINCT FROM ab.point_uid`,
    "0",
  );
  await expect(
    "5c dashboards.doc populated",
    "SELECT count(*)::text FROM dashboards WHERE doc IS NULL",
    "0",
  );
  await expect(
    "5d dashboards.id is uuid",
    "SELECT coalesce((SELECT data_type='uuid' FROM information_schema.columns WHERE table_name='dashboards' AND column_name='id'), false)::text",
    "true",
  );
  await expect(
    "5d users.default_dashboard_id is uuid",
    "SELECT coalesce((SELECT data_type='uuid' FROM information_schema.columns WHERE table_name='users' AND column_name='default_dashboard_id'), false)::text",
    "true",
  );
  await expect(
    "5d dashboard_grants.dashboard_id is uuid",
    "SELECT coalesce((SELECT data_type='uuid' FROM information_schema.columns WHERE table_name='dashboard_grants' AND column_name='dashboard_id'), false)::text",
    "true",
  );
  // Folded subset only — since owner-scoped tokens now ALSO carry a dashboard_id (auto-created), the RHS
  // must count just the tokens that came from dashboard_share_tokens, not every non-null dashboard_id.
  await cmp(
    "5d dashboard_share_tokens folded 1:1",
    "SELECT count(*)::text FROM dashboard_share_tokens",
    "SELECT count(*)::text FROM share_tokens st WHERE EXISTS (SELECT 1 FROM dashboard_share_tokens dst WHERE dst.token = st.token)",
  );
  // P6: the ordinal→priority swap must NOT reorder any (area, role, metric) slot's series.
  await expect(
    "P6 series order: priority == ordinal",
    "SELECT count(*)::text FROM (SELECT row_number() OVER (PARTITION BY area_id, role, metric_type ORDER BY ordinal, id) AS o, row_number() OVER (PARTITION BY area_id, role, metric_type ORDER BY priority, id) AS p FROM area_bindings) t WHERE o <> p",
    "0",
  );

  await cmp(
    "5b run-detector derivations == trackers",
    "SELECT count(*)::text FROM device_trackers",
    "SELECT count(*)::text FROM derivations WHERE kind='run-detector'",
  );
  await cmp(
    "5b hws-model derivations == hws temp points",
    "SELECT count(*)::text FROM point_info WHERE logical_path_stem='load.hws' AND metric_type='temperature'",
    "SELECT count(*)::text FROM derivations WHERE kind='hws-model'",
  );
  await cmp(
    "5b derived_intervals == run_periods(mapped)",
    "SELECT count(*)::text FROM device_run_periods rp JOIN areas a ON a.legacy_system_id=rp.system_id JOIN derivations d ON d.area_id=a.id AND d.role=rp.role",
    "SELECT count(*)::text FROM derived_intervals",
  );

  // ── device_state CONTENT (not just count) — catches the 2g DO NOTHING/staleness class the count is
  //    blind to. device_state is a verbatim per-device copy of polling_status, so the row-hash multisets
  //    must match. (Order of columns inside ROW() is identical on both sides so the hashes align.) ────────
  {
    const dsCols =
      "last_poll_time, last_success_time, last_error_time, last_error, last_response, consecutive_errors, total_polls, successful_polls, updated_at";
    const dsColsPs = dsCols
      .split(", ")
      .map((c) => `ps.${c}`)
      .join(", ");
    const dsColsDs = dsCols
      .split(", ")
      .map((c) => `ds.${c}`)
      .join(", ");
    await cmp(
      "device_state content == polling_status",
      `SELECT ${CK(dsColsPs)} FROM polling_status ps JOIN legacy_handles lh ON lh.handle=ps.system_id AND lh.device_id IS NOT NULL`,
      `SELECT ${CK(dsColsDs)} FROM device_state ds`,
    );
  }

  // ── share_tokens unification finished (owner-token auto-create + NOT NULL) ──────
  await expect(
    "5d share_tokens all mapped (dashboard_id NOT NULL)",
    "SELECT count(*)::text FROM share_tokens WHERE dashboard_id IS NULL",
    "0",
  );
  await expect(
    "5d share_tokens.dashboard_id is NOT NULL (schema)",
    "SELECT coalesce((SELECT is_nullable='NO' FROM information_schema.columns WHERE table_name='share_tokens' AND column_name='dashboard_id'), false)::text",
    "true",
  );

  // ── grant reshape (role CHECK / user_id / created_at timestamp / composite PK) ──────────
  await expect(
    "5d grants role ∈ {admin,viewer}",
    "SELECT count(*)::text FROM dashboard_grants WHERE role NOT IN ('admin','viewer')",
    "0",
  );
  await expect(
    "5d grants role CHECK exists",
    "SELECT (count(*)>0)::text FROM pg_constraint WHERE conrelid='dashboard_grants'::regclass AND contype='c' AND conname='dashboard_grants_role_check'",
    "true",
  );
  await expect(
    "5d grants user_id column present",
    "SELECT coalesce((SELECT true FROM information_schema.columns WHERE table_name='dashboard_grants' AND column_name='user_id'), false)::text",
    "true",
  );
  // This check used to be named "…is timestamptz" and assert `data_type LIKE 'timestamp%'` — which
  // matches BOTH timestamp types, so it could not fail on the thing it was named after. The columns are
  // (correctly) naive `timestamp`, per the repo-wide UTC storage convention; assert that exactly, so the
  // check can catch a drift back to timestamptz (or an implicit session-TimeZone cast — see msToTs in
  // config-transform.ts).
  await expect(
    "5d grants created_at is timestamp (no tz)",
    "SELECT coalesce((SELECT data_type='timestamp without time zone' FROM information_schema.columns WHERE table_name='dashboard_grants' AND column_name='created_at'), false)::text",
    "true",
  );
  await expect(
    "5d share_tokens folded times are timestamp (no tz)",
    `SELECT count(*)::text FROM information_schema.columns
      WHERE table_name='share_tokens' AND column_name IN ('created_at','expires_at','revoked_at','last_used_at')
        AND data_type <> 'timestamp without time zone'`,
    "0",
  );
  // The conversion itself, not just the column type: a session-TimeZone-dependent cast would shift every
  // value by the offset while leaving data_type untouched. Re-derive from the epoch-ms source.
  //
  // TWO queries, because the two populations have different sources. Legacy owner-scoped tokens keep
  // their own `share_tokens.created_at_ms`; tokens FOLDED from `dashboard_share_tokens` do not — the fold
  // INSERT lists no `_ms` columns, so `created_at_ms IS NOT NULL` silently excludes exactly the rows the
  // fold wrote, i.e. the whole population D-j was about. Their source is the legacy table.
  await expect(
    "5d share_tokens (legacy) created_at == created_at_ms (UTC, no offset drift)",
    `SELECT count(*)::text FROM share_tokens
      WHERE created_at_ms IS NOT NULL
        AND created_at IS DISTINCT FROM (to_timestamp(created_at_ms/1000.0) AT TIME ZONE 'UTC')`,
    "0",
  );
  await expect(
    "5d share_tokens (folded) all 4 times == dashboard_share_tokens _ms (UTC)",
    `SELECT count(*)::text FROM share_tokens st JOIN dashboard_share_tokens dst ON dst.token = st.token
      WHERE st.created_at   IS DISTINCT FROM (to_timestamp(dst.created_at_ms/1000.0)   AT TIME ZONE 'UTC')
         OR st.expires_at   IS DISTINCT FROM (to_timestamp(dst.expires_at_ms/1000.0)   AT TIME ZONE 'UTC')
         OR st.revoked_at   IS DISTINCT FROM (to_timestamp(dst.revoked_at_ms/1000.0)   AT TIME ZONE 'UTC')
         OR st.last_used_at IS DISTINCT FROM (to_timestamp(dst.last_used_at_ms/1000.0) AT TIME ZONE 'UTC')`,
    "0",
  );
  await expect(
    "5d grants created_at == created_at_ms (UTC, no offset drift)",
    `SELECT count(*)::text FROM dashboard_grants
      WHERE created_at_ms IS NOT NULL
        AND created_at IS DISTINCT FROM (to_timestamp(created_at_ms/1000.0) AT TIME ZONE 'UTC')`,
    "0",
  );
  await expect(
    "5d grants legacy int id dropped",
    "SELECT coalesce((SELECT false FROM information_schema.columns WHERE table_name='dashboard_grants' AND column_name='id'), true)::text",
    "true",
  );
  await expect(
    "5d grants PK == (dashboard_id, user_id)",
    `SELECT coalesce(string_agg(a.attname, ',' ORDER BY k.ord), '∅')
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
      WHERE c.conrelid='dashboard_grants'::regclass AND c.contype='p'`,
    "dashboard_id,user_id",
  );

  // ── DDL-correctness (D-a / D-b) — the defect class the content checksums are blind to ──────────────────
  await expect(
    "D-a dashboards.id DEFAULT gen_random_uuid()",
    `SELECT coalesce(pg_get_expr(ad.adbin, ad.adrelid), '∅')
       FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
      WHERE a.attrelid='dashboards'::regclass AND a.attname='id'`,
    "gen_random_uuid()",
  );
  await expect(
    "D-b users_default_dashboard_idx recreated",
    "SELECT (count(*)>0)::text FROM pg_indexes WHERE indexname='users_default_dashboard_idx'",
    "true",
  );
  await expect(
    "D-b dashboard_grants_user_idx recreated",
    "SELECT (count(*)>0)::text FROM pg_indexes WHERE indexname='dashboard_grants_user_idx'",
    "true",
  );
  // The 0012 unique index (createGrant's onConflict arbiter) was promoted into the composite PK by the
  // reshape (ADD CONSTRAINT … USING INDEX renames it to dashboard_grants_pk) — assert the PK, which is
  // itself unique, so the arbiter survives.
  await expect(
    "D-b grant uniqueness preserved as PK",
    "SELECT (count(*)>0)::text FROM pg_constraint WHERE conname='dashboard_grants_pk' AND contype='p'",
    "true",
  );

  // ── WRITABILITY — can the DEPLOYED app still INSERT into every table the transform touched? ────────────
  //
  // Every other check in this file reads. None attempts a write, and that blind spot is a defect factory:
  // a column the transform adds as NOT NULL-without-a-default is invisible to `schema.ts`, so drizzle
  // never emits it and the FIRST insert after resume dies with 23502 — past the one-way door, with every
  // check green. (That is exactly how an earlier draft of stage 5a's `point_uid` would have shipped.)
  //
  // Catalog-only, so it is safe to run against a live database: for each touched table, find every column
  // that Postgres REQUIRES a value for (NOT NULL, no default, not generated/identity) and confirm the
  // drizzle model actually knows about it. A required column the model has never heard of is a guaranteed
  // insert failure, whatever the data says.
  {
    const { getTableColumns } = await import("drizzle-orm");
    const schema = await import("@/lib/db/planetscale/schema");
    const TOUCHED: [string, keyof typeof schema][] = [
      ["area_bindings", "areaBindings"],
      ["areas", "areas"],
      ["dashboards", "dashboards"],
      ["dashboard_grants", "dashboardGrants"],
      ["share_tokens", "shareTokens"],
      ["devices", "devices"],
      ["points", "points"],
      ["area_members", "areaMembers"],
      ["device_state", "deviceState"],
    ];
    for (const [table, symbol] of TOUCHED) {
      const model = schema[symbol] as unknown;
      if (!model) {
        results.push({
          name: `W ${table} model present`,
          status: "FAIL",
          detail: `schema.ts exports no '${String(symbol)}'`,
        });
        continue;
      }
      const known = new Set(
        Object.values(
          getTableColumns(model as Parameters<typeof getTableColumns>[0]),
        ).map((c) => (c as { name: string }).name),
      );
      await expect(
        `W ${table} insertable by the app`,
        `SELECT coalesce(string_agg(a.attname, ',' ORDER BY a.attname), '∅')
           FROM pg_attribute a
           LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE a.attrelid = '${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attnotnull AND ad.adbin IS NULL AND a.attidentity = '' AND a.attgenerated = ''
            AND a.attname NOT IN (${[...known].map((c) => `'${c}'`).join(",") || "''"})`,
        "∅",
      );
    }
  }

  // ── report ─────────────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("\n=== config-v4 parity ===");
  for (const r of results) {
    const mark = r.status === "PASS" ? "✅" : r.status === "SKIP" ? "⚪" : "❌";
    console.log(`  ${mark} ${pad(r.name, 38)} ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log(
    `\n${results.length - failed.length - skipped.length} pass, ${failed.length} fail, ${skipped.length} skip`,
  );
  if (failed.length) process.exitCode = 1;
}

/**
 * `--quiescence`: the PRE-stage-4 gate (Phase-7 §4). Run it in the window immediately before the hot
 * rewrite, after `cutover-pause.ts set`.
 *
 * Stage 4 copies `point_readings` in batches over a `[min(id), max(id)]` range captured once at the
 * start, so any row the receiver writes during the ~6-minute copy is silently NOT copied — it lands in
 * what becomes `point_readings_old` and is gone. The only existing detector is the P1 row-count compare,
 * which runs AFTER the irreversible rename-swap: by the time it goes red you are already through the
 * one-way door with a known-lossy copy.
 *
 * The pause is deliberately PARTIAL — pollers keep running and buffering into `observations_outbox` — so
 * "is it safe to copy" is exactly "are the HOT TABLES static", not "is anything running". A GROWING
 * unpublished-outbox depth is the healthy signal that collection never stopped, so it is reported, not
 * asserted.
 */
async function quiescence(scalar: (text: string) => Promise<string>) {
  // The whole gate is "did these values move?", so the hold duration IS the sensitivity. Validate it:
  // `Number("")` is 0 and `Number("90s")` is NaN, and `setTimeout(r, NaN)` fires on the next tick — an
  // unvalidated env var silently collapses the hold to ~0 ms, makes before === after by construction, and
  // prints "safe to start stage 4" without observing anything. Fail loudly instead.
  const raw = process.env.CONFIG_V4_QUIESCE_SEC;
  const holdSec = raw === undefined ? DEFAULT_QUIESCE_SEC : Number(raw);
  if (!Number.isFinite(holdSec) || holdSec < MIN_QUIESCE_SEC)
    throw new Error(
      `CONFIG_V4_QUIESCE_SEC=${JSON.stringify(raw)} → ${holdSec}: must be a number of seconds >= ${MIN_QUIESCE_SEC} ` +
        `(the writers this gate watches run on a 60s cron cadence, so a shorter hold cannot distinguish ` +
        `"paused" from "between ticks"). Note the value is SECONDS — "90s"/"2m" are not accepted.`,
    );
  const probes: { name: string; sql: string }[] = [
    {
      name: "point_readings max(created_at)",
      sql: "SELECT coalesce(max(created_at)::text, '∅') FROM point_readings",
    },
    {
      name: "agg_5m max(updated_at)",
      sql: "SELECT coalesce(max(updated_at)::text, '∅') FROM point_readings_agg_5m",
    },
    {
      name: "agg_1d max(updated_at)",
      sql: "SELECT coalesce(max(updated_at)::text, '∅') FROM point_readings_agg_1d",
    },
  ];
  const outboxSql =
    "SELECT count(*)::text FROM observations_outbox WHERE published_at IS NULL";

  // THREE samples over two holds, not two over one. The writers run on a 60s Vercel cron cadence, so a
  // single interval can straddle a skipped or jittered tick and look static when it is not; two
  // consecutive quiet intervals over >= 2x the cadence is a materially stronger signal for the same
  // wall-clock cost the window already budgets.
  const samples: string[][] = [];
  const outbox: number[] = [];
  console.log(
    `\n=== quiescence gate === 3 samples over 2 holds of ${holdSec}s (CONFIG_V4_QUIESCE_SEC)`,
  );
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, holdSec * 1000));
    samples.push(await Promise.all(probes.map((p) => scalar(p.sql))));
    outbox.push(Number(await scalar(outboxSql)));
    console.log(`  · sample ${i + 1}/3: ${samples[i].join(" | ")}`);
  }
  const [before, , after] = samples;
  const outboxBefore = outbox[0];
  const outboxAfter = outbox[2];

  probes.forEach((p, i) => {
    const vals = samples.map((s) => s[i]);
    const stable = vals.every((v) => v === vals[0]);
    // An empty table cannot demonstrate quiescence — every sample is the '∅' sentinel and the check
    // passes by construction. That is the vacuous-pass shape this whole batch exists to eliminate, and on
    // a rehearsal branch restored from prod an empty hot table means the restore, not the pause, is wrong.
    const vacuous = vals[0] === "∅";
    results.push({
      name: `quiescence: ${p.name}`,
      status: vacuous ? "FAIL" : stable ? "PASS" : "FAIL",
      detail: vacuous
        ? "VACUOUS — table is empty, so 'unchanged' proves nothing"
        : stable
          ? vals[0]
          : `MOVED ${vals.join(" → ")} — materialization is NOT paused`,
    });
  });

  const mark = (s: Status) =>
    s === "PASS" ? "✅" : s === "SKIP" ? "⚪" : "❌";
  for (const r of results)
    console.log(`  ${mark(r.status)} ${r.name.padEnd(38)} ${r.detail}`);
  console.log(
    `  ℹ️  outbox unpublished ${outboxBefore} → ${outboxAfter}` +
      (outboxAfter > outboxBefore
        ? " (growing — pollers alive, as intended)"
        : " (NOT growing — check the pollers are still running)"),
  );

  if (results.some((r) => r.status === "FAIL")) {
    console.error(
      "\n❌ NOT QUIESCENT — do NOT start stage 4. The hot tables are still being written.\n" +
        "   The cutover:paused KV flag alone does not stop the receiver: it gates only the six cron\n" +
        "   routes that call cutoverSkipReason. Run `cutover-pause.ts set` (which also pauses the QStash\n" +
        "   queue), confirm `cutover-pause.ts status` reports both halves paused, then re-run this gate.",
    );
    process.exitCode = 1;
  } else {
    console.log("\n✅ quiescent — hot tables static; safe to start stage 4.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
