#!/usr/bin/env tsx
/**
 * config-v4 authz-delta check (Phase 8, Group A). Runs on a rehearsal branch AFTER config-transform.ts,
 * asserting that the cutover preserves read access exactly where it should and narrows it ONLY where the
 * design intends.
 *
 * Why a separate script from parity-check.ts: parity is per-column content checksums (pure server-side
 * aggregates); authz is a two-world RESOLUTION — it drives the real, request-free, shape-aware resolver
 * `resolveDashboardReadPoints` (lib/dashboard/access.ts) over BOTH the retained legacy tables (the
 * pre-cutover world) and the new v4 tables (the post-cutover world), and does set algebra on the results.
 * Phase 8 retains every legacy table until Phase 9, so ONE post-transform branch carries both worlds.
 *
 * Common key space: every resolved point set is reduced to a `Set<point_info.rid>` (== points.rid, proven
 * verbatim by parity), so the two worlds are directly comparable.
 *
 * The three legs:
 *   - AC1 dashboard scope equivalence: for every dashboard a surviving token/grant targets, the point set
 *     resolved from the v3 `descriptor` equals the set resolved from the v4 `doc` (the rewrite neither
 *     widened nor narrowed scope).
 *   - AC2 (share-token → point) preservation [LOAD-BEARING]: dashboard-scoped tokens folded 1:1 verbatim,
 *     validity-state preserved (no revoked/expired token silently revived = no widening), owner-scoped
 *     token re-pointed with its scope preserved.
 *   - AC3 (user → point) delta: OWN/GRANT/PUBLIC cancel; ONLY the `user_systems` viewer grant is removed
 *     by design. Assert zero widening (leak) and that the narrowing equals exactly that intended reduction.
 *     LiveOne is effectively single-user, so AC3 is nearly vacuous and AC2 is the load-bearing leg.
 *
 * ⚠️  AC1 and AC3 are SET-ALGEBRA checks, and set algebra passes trivially on empty sets. Worse, both
 *     worlds are resolved by the SAME `resolveDashboardReadPoints`, and `lib/dashboard/access.ts` wraps
 *     each per-area resolution in a bare `catch {}` that keeps the handle and drops the points — so a
 *     Group-B regression that breaks point resolution narrows both legs identically and every comparison
 *     still passes. Each leg therefore carries an explicit NON-VACUITY assertion (targets > 0, users > 0,
 *     no resolved scope empty). Those are what make the other assertions evidence rather than ceremony.
 *
 *     Known remaining gap, deliberately NOT papered over: this script reads `dashboard_grants`,
 *     `user_systems` and `share_tokens` with raw SQL and never imports `lib/dashboard/grants.ts` or
 *     `lib/dashboard/sharing.ts`. It therefore certifies the DATA FOLD, not the access PATH — the grant
 *     reshape and the share-token unification can be wired wrong in the drizzle layer with this script
 *     still 11/11. Covering that needs the serving-path smoke set (see the Phase-8 plan of record), not
 *     another SQL check here.
 *
 * ⚠️  AC1 NEEDS A PRE-TRANSFORM SNAPSHOT — `--snapshot` is NOT optional. Run 5 (2026-07-26) proved that
 *     resolving the v3 `descriptor` leg AFTER the transform is structurally incapable of proving anything:
 *     stage 2 renames `areas.display_name` → `name`, `schema.ts` still declares `displayName`, so every
 *     drizzle read of `areas` raises 42703 and `access.ts`'s per-area `catch {}` swallows it — the descriptor
 *     scope resolves to ZERO points. Both legs then narrow together and every set comparison passes
 *     vacuously. (That is exactly how Run 4's "authz 9/9" reported a green AC1 over an empty set.) So the
 *     descriptor leg is CAPTURED BEFORE the transform, while the v3 code can still read the v3 database, and
 *     the post-transform run compares that snapshot against the live v4 `doc` scope.
 *
 *     The snapshot is keyed on `dashboards.legacy_id`, NOT the PK: the cutover replaces the serial int id
 *     with a uuid, so the pre-transform id is only recoverable through `legacy_id` (unique, frozen at 5c).
 *     A dashboard the TRANSFORM created (the owner-token auto-create) has no `legacy_id` and therefore no
 *     pre-cutover scope to compare — it is reported informationally and covered by AC2d instead.
 *
 * Usage — TWO invocations, in this order:
 *   # 1. BEFORE config-transform.ts (captures the descriptor leg while v3 code still works)
 *   PLANETSCALE_DATABASE_URL="<branch url>" REHEARSAL_BRANCH_ID="<branch id>" \
 *     npx tsx scripts/config-v4/authz-check.ts --snapshot
 *   # 2. AFTER config-transform.ts --commit
 *   PLANETSCALE_DATABASE_URL="<branch url>" REHEARSAL_BRANCH_ID="<branch id>" \
 *     npx tsx scripts/config-v4/authz-check.ts
 *
 * Snapshot file: $CONFIG_V4_AUTHZ_SNAPSHOT_FILE, default .context/config-v4-authz-snapshot.json.
 * A missing/incomplete snapshot is a FAILURE, never a silent skip (fail-closed).
 *
 * TARGET MODES (guard.ts). `CONFIG_V4_TARGET` defaults to `rehearsal`; the branch-id var is the positive
 * proof of the mode. `PLANETSCALE_PROD_BRANCH_ID` is required in ALL modes (it is the only way to
 * recognise prod). Prod additionally needs `ALLOW_PROD_DB_IN_DEV=true`, because `@/lib/db/planetscale`
 * refuses a prod connection outside production BEFORE the guard ever runs:
 *   rehearsal:  REHEARSAL_BRANCH_ID="<branch id>"
 *   dev:        CONFIG_V4_TARGET=dev LIVEONE_DEV_BRANCH_ID="<branch id>"
 *   prod:       CONFIG_V4_TARGET=prod ALLOW_PROD_DB_IN_DEV=true   … --i-understand-this-is-prod
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import { assertRehearsalTarget } from "./guard";

/** Capture mode: resolve + persist the v3 descriptor scope BEFORE the transform renames it out of reach. */
const snapshotMode = process.argv.includes("--snapshot");
const SNAPSHOT_FILE =
  process.env.CONFIG_V4_AUTHZ_SNAPSHOT_FILE ??
  join(process.cwd(), ".context", "config-v4-authz-snapshot.json");

/** One dashboard's pre-cutover descriptor scope, keyed by the frozen `legacy_id`. */
type SnapshotEntry = { legacyId: number; rids: number[]; areas: string[] };
type Snapshot = { capturedAt: string; dashboards: SnapshotEntry[] };

type Status = "PASS" | "FAIL";
const results: { name: string; status: Status; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) =>
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });

// ── set helpers ─────────────────────────────────────────────────────────────────
const difference = <T>(a: Set<T>, b: Set<T>) =>
  new Set([...a].filter((x) => !b.has(x)));
const union = <T>(...sets: Set<T>[]) => {
  const out = new Set<T>();
  for (const s of sets) for (const x of s) out.add(x);
  return out;
};
const sameSet = <T>(a: Set<T>, b: Set<T>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

async function main() {
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const { resolveDashboardReadPoints } = await import("@/lib/dashboard/access");
  const { descriptorAreaIds } = await import("@/lib/dashboard/composition");
  const { collectRefs } = await import("@/lib/dashboard/v4-validate");
  const { Area } = await import("@/lib/ids");
  const db = requirePlanetscaleDb();
  assertRehearsalTarget();

  const rowsOf = async (q: SQL | string) =>
    (
      (await db.execute(typeof q === "string" ? sql.raw(q) : q)) as unknown as {
        rows: Record<string, unknown>[];
      }
    ).rows;
  const ridSet = async (q: SQL | string): Promise<Set<number>> =>
    new Set((await rowsOf(q)).map((r) => Number(r.rid)));

  // (systemId, pointId) refs → Set<rid> via the RETAINED point_info (pi."id" is the TS `index`/pointId).
  const ridsForRefs = async (
    refs: { systemId: number; pointId: number }[],
  ): Promise<Set<number>> => {
    if (!refs.length) return new Set();
    const values = refs.map((r) => `(${r.systemId},${r.pointId})`).join(",");
    return ridSet(
      `SELECT rid FROM point_info WHERE (system_id, id) IN (${values})`,
    );
  };
  // `descriptor` is required by DashboardScopeInput (a v3 dashboard always has one); the doc-only leg
  // passes `descriptor: null` deliberately, so that `dashboardAreaUuids` takes the v4 envelope path.
  const scopeRids = async (input: {
    descriptor: unknown;
    doc?: unknown;
  }): Promise<Set<number>> => {
    const { points } = await resolveDashboardReadPoints(input);
    return ridsForRefs(points);
  };

  // ── SNAPSHOT (capture) MODE — run BEFORE config-transform.ts ────────────────────────────────────────
  // Resolves the v3 descriptor leg while the v3 resolver can still read the v3 `areas` columns, and keys
  // each result on the int PK, which stage 5c freezes into `dashboards.legacy_id`. After the transform this
  // resolution is impossible (see the header), so this file is the ONLY evidence of pre-cutover scope.
  if (snapshotMode) {
    const dash = (await rowsOf(
      "SELECT id, descriptor FROM dashboards ORDER BY id",
    )) as Array<{ id: number; descriptor: unknown }>;
    const entries: SnapshotEntry[] = [];
    for (const d of dash) {
      const rids = await scopeRids({ descriptor: d.descriptor });
      entries.push({
        legacyId: Number(d.id),
        rids: [...rids].sort((a, b) => a - b),
        areas: [...descriptorAreaIds(d.descriptor)].sort(),
      });
    }
    const empty = entries.filter((e) => e.rids.length === 0);
    mkdirSync(dirname(SNAPSHOT_FILE), { recursive: true });
    writeFileSync(
      SNAPSHOT_FILE,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          dashboards: entries,
        } satisfies Snapshot,
        null,
        2,
      ),
    );
    console.log(`\n=== config-v4 authz snapshot (PRE-transform) ===`);
    console.log(`  dashboards captured : ${entries.length}`);
    console.log(
      `  total points        : ${entries.reduce((a, e) => a + e.rids.length, 0)}`,
    );
    console.log(`  → ${SNAPSHOT_FILE}`);
    // Capturing zeros would bake the very vacuity this snapshot exists to prevent into the baseline.
    if (entries.length === 0 || empty.length) {
      console.error(
        `\n❌ REFUSING to accept this snapshot: ${entries.length} dashboards, ${empty.length} resolved to ZERO points.` +
          `\n   The descriptor resolver must work at capture time — fix it BEFORE running the transform.` +
          (empty.length
            ? `\n   empty: ${empty.map((e) => e.legacyId).join(",")}`
            : ""),
      );
      process.exitCode = 1;
    }
    return;
  }

  // ── VERIFY MODE — the descriptor leg comes from the snapshot, the doc leg is resolved live ──────────
  const snapshot: Snapshot | null = existsSync(SNAPSHOT_FILE)
    ? (JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as Snapshot)
    : null;
  const snapByLegacy = new Map<number, SnapshotEntry>(
    (snapshot?.dashboards ?? []).map((e) => [e.legacyId, e]),
  );
  record(
    "AC1 pre-transform snapshot present",
    snapshot != null && snapByLegacy.size > 0,
    snapshot
      ? `${snapByLegacy.size} dashboards captured ${snapshot.capturedAt}`
      : `MISSING ${SNAPSHOT_FILE} — run --snapshot BEFORE config-transform (AC1 cannot be evaluated post-hoc)`,
  );

  // Cache each dashboard's descriptor- and doc-resolved scope (points + areas), computed once.
  // `descriptor*` is READ FROM THE SNAPSHOT (via legacy_id); only `doc*` is resolved live.
  const scopeCache = new Map<
    string,
    {
      descriptorRids: Set<number>;
      docRids: Set<number>;
      descAreas: Set<string>;
      docAreas: Set<string>;
      legacyId: number | null;
      snapshotFound: boolean;
    }
  >();
  const dashboardScopes = async (id: string) => {
    let s = scopeCache.get(id);
    if (!s) {
      const [d] = (await rowsOf(
        sql`SELECT legacy_id, doc FROM dashboards WHERE id = ${id}`,
      )) as Array<{ legacy_id: number | null; doc: DashboardV4 }>;
      const docAreas = new Set(
        d
          ? (collectRefs(d.doc)
              .areas.map((a) => {
                try {
                  return Area.toUuid(a);
                } catch {
                  return null;
                }
              })
              .filter((x): x is string => x != null) as string[])
          : [],
      );
      const legacyId = d?.legacy_id == null ? null : Number(d.legacy_id);
      const snap = legacyId == null ? undefined : snapByLegacy.get(legacyId);
      s = {
        descriptorRids: new Set(snap?.rids ?? []),
        docRids: d
          ? await scopeRids({ descriptor: null, doc: d.doc })
          : new Set(),
        descAreas: new Set(snap?.areas ?? []),
        docAreas,
        legacyId,
        snapshotFound: snap != null,
      };
      scopeCache.set(id, s);
    }
    return s;
  };

  // ── AC1 — dashboard scope over token/grant targets ──────────────────────────────────────────────────
  // The rewriter's contract (v3-to-v4.ts) is AREA-scope equivalence, NOT point equality: a v4 doc's ONLY
  // scope sources are `area` + `device` envelope refs (§8.3), and it deliberately carries v3 deviceSystemId
  // pins forward as `device` refs. The v4 resolver expands those device refs into scope (access.ts INTENDS
  // this — a device-pinned card would otherwise 401 for a share viewer even though the dashboard renders it),
  // whereas the v3 descriptor resolver only expands areas. So the doc is a SUPERSET by exactly the
  // device-pinned points. The security-critical invariants are therefore: (1) NO LOCKOUT (descriptor ⊆ doc —
  // no shared viewer loses access) and (2) AREA-scope preserved. Any point-level widening is confined to
  // device pins (structural, since areas are equal) and is surfaced loudly below, not silently.
  const targeted = (await rowsOf(
    `SELECT DISTINCT dashboard_id::text AS id FROM (
        SELECT dashboard_id FROM share_tokens WHERE dashboard_id IS NOT NULL
        UNION SELECT dashboard_id FROM dashboard_grants
     ) t WHERE dashboard_id IS NOT NULL`,
  )) as Array<{ id: string }>;
  let lockout = 0;
  let areaMismatch = 0;
  let widenPoints = 0;
  let widenDashboards = 0;
  let emptyDescriptor = 0;
  let mintedAtCutover = 0;
  let comparable = 0;
  for (const { id } of targeted) {
    const {
      descriptorRids,
      docRids,
      descAreas,
      docAreas,
      legacyId,
      snapshotFound,
    } = await dashboardScopes(id);
    // A dashboard the TRANSFORM minted (owner-token auto-create) has no legacy_id and so no pre-cutover
    // scope: there is nothing to compare, and counting it as vacuous would be a false red. AC2d is what
    // proves that token's scope survived.
    if (legacyId == null) {
      mintedAtCutover++;
      record(
        `AC1 new-at-cutover ${id.slice(0, 8)}`,
        true,
        "minted by the transform (no legacy_id) — pre-cutover scope N/A; covered by AC2d",
      );
      continue;
    }
    // Fail-closed: a targeted dashboard that existed before the window MUST be in the snapshot. Silently
    // treating it as empty is what turned AC1 green over nothing in Run 4.
    if (!snapshotFound) {
      emptyDescriptor++;
      record(
        `AC1 NO SNAPSHOT ${id.slice(0, 8)}`,
        false,
        `legacy_id=${legacyId} absent from the snapshot — captured after the transform, or against a different database`,
      );
      continue;
    }
    // NON-VACUITY. The snapshot is captured with a working v3 resolver and refuses to persist zeros, so an
    // empty scope here means the capture itself was degraded. An empty descriptor scope on a dashboard
    // someone actually shares is never a legitimate state.
    if (descriptorRids.size === 0) {
      emptyDescriptor++;
      record(
        `AC1 VACUOUS ${id.slice(0, 8)}`,
        false,
        `legacy_id=${legacyId} snapshot scope is EMPTY — the descriptor resolver was broken at capture time`,
      );
      continue;
    }
    comparable++;
    const lost = difference(descriptorRids, docRids); // LOCKOUT — the dangerous direction
    const gained = difference(docRids, descriptorRids); // device-pin widening — intended (§8.3)
    if (lost.size) {
      lockout++;
      record(`AC1 LOCKOUT ${id.slice(0, 8)}`, false, `lost rids=${[...lost]}`);
    }
    if (!sameSet(descAreas, docAreas)) {
      areaMismatch++;
      record(
        `AC1 area-scope ${id.slice(0, 8)}`,
        false,
        `descriptor=${descAreas.size} doc=${docAreas.size} areas`,
      );
    }
    if (gained.size) {
      widenDashboards++;
      widenPoints += gained.size;
    }
  }
  // The floor under the two set-comparison checks below: with zero targeted dashboards they compare
  // nothing and pass. Prod has share tokens and grants, so an empty target set means the query (or the
  // fold that populates it) is wrong, not that there is nothing to check.
  record(
    "AC1 non-vacuous (comparable dashboards > 0, all scopes non-empty)",
    targeted.length > 0 && emptyDescriptor === 0 && comparable > 0,
    `${targeted.length} targeted = ${comparable} compared vs snapshot + ${mintedAtCutover} minted at cutover; ${emptyDescriptor} unusable`,
  );
  record(
    "AC1 no lockout (descriptor ⊆ doc, all targeted)",
    lockout === 0,
    `${targeted.length} dashboards, ${lockout} with lost points`,
  );
  record(
    "AC1 area-scope preserved (rewriter contract)",
    areaMismatch === 0,
    `${areaMismatch} area-set mismatches`,
  );
  // Expected, not a failure — but surfaced so the cutover's share-scope change is visible. A v4 share/grant
  // holder additionally sees the device-pinned cards the dashboard renders (v3 would have 401'd them).
  record(
    "AC1 device-pin widening (intended §8.3; informational)",
    true,
    `${widenPoints} extra points across ${widenDashboards} dashboards via doc device refs`,
  );

  // ── AC2 — (share-token → point) preservation ────────────────────────────────────────────────────────
  // (a) every dashboard-scoped token folded 1:1, verbatim string + correct dashboard target.
  const foldMiss = Number(
    (
      await rowsOf(`SELECT count(*)::int AS rid FROM dashboard_share_tokens dst
         JOIN dashboards d ON d.legacy_id = dst.dashboard_id
         LEFT JOIN share_tokens st ON st.token = dst.token AND st.dashboard_id = d.id
        WHERE st.token IS NULL`)
    )[0].rid,
  );
  record(
    "AC2a dashboard tokens folded 1:1 (string + target)",
    foldMiss === 0,
    `${foldMiss} unmapped`,
  );

  // (b) validity-state fold correctness — a cleared revoked_at/expires_at would silently revive a dead
  // token (widening). Assert NULL-iff-_ms-NULL and value == to_timestamp(ms/1000) for the folded subset.
  const validityMiss = Number(
    (
      await rowsOf(`SELECT count(*)::int AS rid FROM dashboard_share_tokens dst
         JOIN share_tokens st ON st.token = dst.token
        WHERE (dst.revoked_at_ms IS NULL) <> (st.revoked_at IS NULL)
           OR (dst.expires_at_ms IS NULL) <> (st.expires_at IS NULL)
           OR (dst.revoked_at_ms IS NOT NULL AND st.revoked_at <> to_timestamp(dst.revoked_at_ms/1000.0))
           OR (dst.expires_at_ms IS NOT NULL AND st.expires_at <> to_timestamp(dst.expires_at_ms/1000.0))`)
    )[0].rid,
  );
  record(
    "AC2b token validity-state preserved (no revive)",
    validityMiss === 0,
    `${validityMiss} drifted`,
  );

  // (c) per-token resolved scope is non-empty for dashboard-scoped tokens (they must expose points), and
  // descriptor==doc is already AC1. Assert each surviving token's dashboard resolves some points.
  const tokenTargets = (await rowsOf(
    `SELECT token, dashboard_id::text AS id FROM share_tokens WHERE dashboard_id IS NOT NULL`,
  )) as Array<{ token: string; id: string }>;
  let emptyScope = 0;
  for (const t of tokenTargets) {
    const { docRids } = await dashboardScopes(t.id);
    if (docRids.size === 0) emptyScope++;
  }
  record(
    "AC2c every surviving token resolves ≥1 point",
    emptyScope === 0,
    `${tokenTargets.length} tokens, ${emptyScope} empty-scope`,
  );

  // (d) legacy owner-scoped token preserved: its dashboard's scope must still include the kinkora
  // load.hws temperature+power points (the only live consumer, /labs/kinkora-hws), i.e. never narrowed.
  const ownerTok = (await rowsOf(
    `SELECT st.token, st.dashboard_id::text AS id, st.owner_clerk_user_id AS owner
       FROM share_tokens st WHERE st.owner_clerk_user_id IS NOT NULL`,
  )) as Array<{ token: string; id: string | null; owner: string | null }>;
  const hwsRids = await ridSet(
    `SELECT rid FROM point_info WHERE logical_path_stem='load.hws' AND metric_type IN ('temperature','power')`,
  );
  if (ownerTok.length === 0) {
    record(
      "AC2d legacy owner token present",
      true,
      "none found (nothing to preserve)",
    );
  } else {
    let ownerFail = 0;
    for (const t of ownerTok) {
      if (!t.id) {
        ownerFail++;
        continue;
      } // must have been re-pointed (dashboard_id NOT NULL)
      const { docRids } = await dashboardScopes(t.id);
      // hwsRids ⊆ the token's resolved scope (the auto-created dashboard covers all owner areas ⊇ kinkora).
      if ([...hwsRids].some((r) => !docRids.has(r))) ownerFail++;
    }
    record(
      "AC2d owner token re-pointed, kinkora load.hws scope preserved",
      ownerFail === 0,
      `${ownerTok.length} owner token(s), ${ownerFail} narrowed/unmapped, hws=${hwsRids.size} pts`,
    );
  }

  // ── AC3 — (user → point) delta == intended reduction (viewer loss), zero widening ─────────────────────
  const publicRids = await ridSet(
    `SELECT pi.rid FROM point_info pi JOIN systems s ON s.id=pi.system_id WHERE s.owner_clerk_user_id IS NULL`,
  );
  const users = (await rowsOf(
    `SELECT DISTINCT u AS uid FROM (
        SELECT owner_clerk_user_id AS u FROM systems WHERE owner_clerk_user_id IS NOT NULL
        UNION SELECT clerk_user_id FROM user_systems
        UNION SELECT user_id FROM dashboard_grants
     ) x WHERE u IS NOT NULL`,
  )) as Array<{ uid: string }>;

  const grantRidsFor = async (uid: string): Promise<Set<number>> => {
    const gs = (await rowsOf(
      sql`SELECT dashboard_id::text AS id FROM dashboard_grants WHERE user_id = ${uid}`,
    )) as Array<{ id: string }>;
    const out = new Set<number>();
    for (const g of gs)
      for (const r of (await dashboardScopes(g.id)).docRids) out.add(r);
    return out;
  };

  let widen = 0;
  let narrowMismatch = 0;
  let intendedLoss = 0;
  let emptyPre = 0;
  for (const { uid } of users) {
    const ownPre = await ridSet(
      sql`SELECT pi.rid FROM point_info pi JOIN systems s ON s.id=pi.system_id WHERE s.owner_clerk_user_id = ${uid}`,
    );
    const ownPost = await ridSet(
      sql`SELECT p.rid FROM points p JOIN devices d ON d.id=p.device_id WHERE d.owner_user_id = ${uid}`,
    );
    const viewer = await ridSet(
      sql`SELECT pi.rid FROM user_systems us JOIN point_info pi ON pi.system_id=us.system_id WHERE us.clerk_user_id = ${uid}`,
    );
    const grant = await grantRidsFor(uid);

    const pre = union(ownPre, viewer, grant, publicRids);
    const post = union(ownPost, grant, publicRids);
    const intended = difference(viewer, union(ownPost, grant, publicRids)); // E: viewer-only access, lost by design

    const widened = difference(post, pre); // must be ∅ — a leak
    const narrowed = difference(pre, post); // must equal `intended` exactly
    if (widened.size) widen++;
    if (!sameSet(narrowed, intended)) narrowMismatch++;
    if (pre.size === 0) emptyPre++;
    intendedLoss += intended.size;
  }
  // NON-VACUITY, same reasoning as AC1: `∅ ⊆ ∅` and `∅ == ∅` both pass, so a resolver that returns
  // nothing satisfies every AC3 assertion. A user with no pre-cutover access at all cannot appear in the
  // `users` query (it is built from owners/viewers/grantees), so an empty `pre` means broken resolution.
  record(
    "AC3 non-vacuous (users > 0, all pre-scopes non-empty)",
    users.length > 0 && emptyPre === 0,
    `${users.length} users, ${emptyPre} with an empty pre-cutover scope`,
  );
  record(
    "AC3 no widening (post ⊆ pre) per user",
    widen === 0,
    `${users.length} users, ${widen} widened`,
  );
  record(
    "AC3 narrowing == intended viewer-loss E per user",
    narrowMismatch === 0,
    `${narrowMismatch} users differ from E; |E| total=${intendedLoss}`,
  );

  // ── report ─────────────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("\n=== config-v4 authz-delta ===");
  for (const r of results)
    console.log(
      `  ${r.status === "PASS" ? "✅" : "❌"} ${pad(r.name, 48)} ${r.detail}`,
    );
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(
    `\n${results.length - failed.length} pass, ${failed.length} fail`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
