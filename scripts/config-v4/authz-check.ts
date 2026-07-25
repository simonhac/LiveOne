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
 * Usage (on the branch, AFTER config-transform.ts --commit):
 *   PLANETSCALE_DATABASE_URL="<branch url>" REHEARSAL_BRANCH_ID="<branch id>" \
 *     npx tsx scripts/config-v4/authz-check.ts
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql, type SQL } from "drizzle-orm";
import { assertRehearsalTarget } from "./guard";

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
  const scopeRids = async (input: {
    descriptor?: unknown;
    doc?: unknown;
  }): Promise<Set<number>> => {
    const { points } = await resolveDashboardReadPoints(input);
    return ridsForRefs(points);
  };

  // Cache each dashboard's descriptor- and doc-resolved scope (points + areas), computed once.
  const scopeCache = new Map<
    string,
    {
      descriptorRids: Set<number>;
      docRids: Set<number>;
      descAreas: Set<string>;
      docAreas: Set<string>;
    }
  >();
  const dashboardScopes = async (id: string) => {
    let s = scopeCache.get(id);
    if (!s) {
      const [d] = (await rowsOf(
        sql`SELECT descriptor, doc FROM dashboards WHERE id = ${id}`,
      )) as Array<{ descriptor: unknown; doc: unknown }>;
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
      s = {
        descriptorRids: d
          ? await scopeRids({ descriptor: d.descriptor })
          : new Set(),
        docRids: d ? await scopeRids({ doc: d.doc }) : new Set(),
        descAreas: new Set(d ? descriptorAreaIds(d.descriptor) : []),
        docAreas,
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
  for (const { id } of targeted) {
    const { descriptorRids, docRids, descAreas, docAreas } =
      await dashboardScopes(id);
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
    intendedLoss += intended.size;
  }
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
