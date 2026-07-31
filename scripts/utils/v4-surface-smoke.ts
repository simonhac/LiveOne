#!/usr/bin/env tsx
/**
 * Drive EVERY handler of the `/api/v4` surface against a running dev server, once, for real.
 *
 *   npm run dev            # in another terminal (or PORT=3001 npm run dev)
 *   npx tsx --env-file=.env.local scripts/utils/v4-surface-smoke.ts
 *   V4_SMOKE_BASE=http://localhost:3001 npx tsx --env-file=.env.local scripts/utils/v4-surface-smoke.ts
 *
 * WHY THIS EXISTS. Until config-v4 Phase 14 STEP 0 the whole `/api/v4` tree had **never run**: zero
 * `fetch()` callers anywhere in the app, zero route tests. Its helper libs (`v4-validate`, `v4-routes`,
 * `v4-seed`, `v4-shapes`) were well unit-tested, but those mock their dependencies and never construct a
 * request or import a route module — so they could not see, and did not see, the two defects this script
 * was written to catch: an alias collision 500ing instead of 409ing (drizzle ≥0.44 moved the SQLSTATE
 * onto `error.cause`, see `lib/db/pg-error.ts`), and the reads echoing the DAO's legacy
 * `displayName`/`alias` where every write takes `name`/`slug`. Route-level jest tests
 * (`app/api/v4/__tests__/`) pin the decidable parts; this pins the parts that only a real request,
 * a real Clerk session and a real Postgres can answer. Run it after ANY change under `app/api/v4/`.
 *
 * SAFE TO RE-RUN. It creates only its own scratch dashboards (name prefixed `v4-smoke ·`) and its own
 * scratch AREAS (name prefixed `p14-areaw ·`), deletes both in a `finally`, AND sweeps anything left
 * behind by a previous crashed run before it starts. It never mutates a device, a point, or a
 * pre-existing dashboard. Modelled on `verify-areas-drift-key.ts`.
 *
 * ⚠️ The scratch AREAS are swept over a direct DB connection, not over HTTP, and that is deliberate:
 * `DELETE /api/v4/areas/{id}` is a SOFT delete (`status='archived'`), so an HTTP-only teardown would
 * leave a growing pile of archived rows and a consumed integer handle on the SHARED `liveone-dev`
 * database after every run. The sweep is by name prefix and drops the area's `legacy_handles` row first
 * (that FK has no ON DELETE, so the row order is load-bearing).
 *
 * ⚠️ It does mutate two things it did not create, both idempotently and both reverted: it drives the
 * LEGACY area twins against its own scratch areas (to diff their payloads key-by-key against the v4
 * ones), and it recomputes ONE already-materialised day of provenance for a real area — with an explicit
 * `cursor`, so the first-batch η re-learn and `updateLatest` are both skipped and the write is a
 * recomputation of values that already exist.
 *
 * 🛑 It also MINTS SHARE TOKENS (Phase 14 stage 11). Those live on a scratch dashboard and
 * `share_tokens.dashboard_id`/`dashboard_grants.dashboard_id` are both ON DELETE CASCADE, so deleting
 * the dashboard is what removes them — the run asserts that anonymously rather than assuming it. A
 * leftover token is a live anonymous credential, not untidiness, which is why the sweep at the top
 * matters more here than it did for a plain dashboard row.
 *
 * DEV-ONLY, two independent guards: the base URL must be loopback, and the server's database (read from
 * this process's own env, which is the same `.env.local` the dev server booted from) must not carry
 * `PLANETSCALE_PROD_BRANCH_ID`.
 *
 * AUTH. Mints a real Clerk session JWT per request (they expire in ~60 s), exactly as
 * `scripts/utils/get-test-token.ts` does — `x-claude` is NOT enough, because `middleware.ts` runs
 * `auth.protect()` at the edge and rewrites an unauthenticated `/api/v4/*` call to 404 before the
 * handler sees the header. Needs an active browser session for the test user on the DEV Clerk instance;
 * if there is none, sign in first — there is no workaround.
 */
import { isDeepStrictEqual } from "node:util";
import { isNull } from "drizzle-orm";
import { createClerkClient } from "@clerk/nextjs/server";
import { planetscaleDb } from "@/lib/db/planetscale";
import { shareTokens } from "@/lib/db/planetscale/schema";
import { eq, like } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, legacyHandles } from "@/lib/db/planetscale/schema";
// The server's OWN binding predicate, so the fixture this script builds cannot drift from the rules
// `replaceBindings` validates against.
import { bindingShapeMatches } from "@/lib/areas/slots";
import { ROLES, type RoleId } from "@/lib/roles/registry";

const BASE = process.env.V4_SMOKE_BASE ?? "http://localhost:3001";
const SCRATCH_PREFIX = "v4-smoke ·";
const SCRATCH_SLUG = `v4-smoke-${Math.random().toString(36).slice(2, 8)}`;
/** Scratch AREAS carry their own prefix — the ledger's namespace for Phase 14 stage 10. */
const AREA_PREFIX = "p14-areaw ·";
const AREA_SLUG = `p14-areaw-${Math.random().toString(36).slice(2, 8)}`;

// --- tiny assertion harness -------------------------------------------------
let failures = 0;
let checks = 0;
function ok(condition: unknown, label: string, detail?: unknown): void {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
    if (detail !== undefined)
      console.error(`      got: ${JSON.stringify(detail)?.slice(0, 400)}`);
  }
}
function section(name: string): void {
  console.log(`\n── ${name}`);
}
function skip(label: string, why: string): void {
  console.log(`  ⚠ SKIPPED ${label} — ${why}`);
}

/*
 * 🛑 `compareKeyByKey` LIVED HERE UNTIL config-v4 Phase 14 stage 13, and its removal is a deliberate
 * loss of oracle, not an oversight. It diffed a v4 payload against its LEGACY TWIN key-by-key — the
 * check that caught STEP 0's D2 (`GET /api/v4/areas` silently dropping `legacySystemId`, which renders
 * every card as a permanent skeleton with no error anywhere). Stage 13 deleted both legacy trees, so
 * there is no twin left to diff against.
 *
 * What replaces it: each moved client's exact key set is now asserted DIRECTLY, at the section for the
 * route that serves it, naming the client module and what breaks if the key goes. That is weaker than a
 * differential check — it cannot notice a field neither side has — but it is what the wire contract has
 * become now that the legacy shape is gone, and it is stronger in one way: it states what the CLIENT
 * reads rather than what a retired route happened to emit.
 */

// --- auth -------------------------------------------------------------------
const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY ?? "",
});
let cachedUserId: string | null = null;

async function mintJwt(): Promise<string> {
  if (!process.env.CLERK_SECRET_KEY)
    throw new Error(
      "CLERK_SECRET_KEY missing — run with --env-file=.env.local",
    );
  if (!cachedUserId) {
    const users = await clerk.users.getUserList({ limit: 20 });
    const user =
      users.data.find((u) =>
        u.emailAddresses[0]?.emailAddress?.includes("simon"),
      ) ??
      users.data.find(
        (u) =>
          (u.privateMetadata as { isPlatformAdmin?: boolean })
            ?.isPlatformAdmin === true,
      ) ??
      users.data[0];
    if (!user) throw new Error("no Clerk users on this instance");
    cachedUserId = user.id;
  }
  const sessions = await clerk.sessions.getSessionList({
    userId: cachedUserId,
  });
  const session =
    sessions.data.find((s) => s.status === "active") ?? sessions.data[0];
  if (!session)
    throw new Error(
      "No existing sessions for the test user — sign in to the dev app first (a session JWT cannot be minted without one).",
    );
  const token = await clerk.sessions.getToken(session.id);
  if (!token.jwt) throw new Error("Clerk returned no JWT for that session");
  return token.jwt;
}

interface Res {
  status: number;
  etag: string | null;
  body: any;
}

async function request(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    /** "clerk" = a freshly-minted session JWT; "cron" = CRON_SECRET; "anon" = no credentials at all. */
    as?: "clerk" | "cron" | "anon";
  } = {},
): Promise<Res> {
  const as = opts.as ?? "clerk";
  const auth =
    as === "clerk"
      ? { Authorization: `Bearer ${await mintJwt()}` }
      : as === "cron"
        ? { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` }
        : {};
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...auth,
      ...(opts.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the raw text — an empty body on a 500 is itself the signal */
  }
  return { status: res.status, etag: res.headers.get("etag"), body };
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  return request(method, path, opts);
}

/**
 * The same request WITHOUT a Clerk session — how an anonymous share-token holder reaches the app.
 *
 * config-v4 Phase 14 stage 11. `call()` cannot answer the questions that matter most about sharing:
 * whether a token actually reaches the data, whether a revoked one is actually refused, and whether
 * the owner-side management routes are actually unreachable. All three need NO Authorization header,
 * because `middleware.ts` decides at the edge and a session would mask the answer entirely.
 *
 * A thin alias over `request({ as: "anon" })` — stage 12 landed the `as` parameter first, so the
 * anonymous leg has one implementation rather than two.
 */
async function raw(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  return request(method, path, { ...opts, as: "anon" });
}

// --- guards -----------------------------------------------------------------
function assertNotProd(): void {
  const host = new URL(BASE).hostname;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new Error(
      `refusing to run: V4_SMOKE_BASE must be loopback (got ${host}). This script MUTATES dashboards.`,
    );
  }
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID;
  const dbUrl =
    process.env.PLANETSCALE_DATABASE_URL ??
    process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS ??
    "";
  if (prodToken && dbUrl.toLowerCase().includes(prodToken.toLowerCase())) {
    throw new Error(
      "refusing to run: the database in this environment carries PLANETSCALE_PROD_BRANCH_ID (prod).",
    );
  }
}

// --- the run ----------------------------------------------------------------
const UNKNOWN_AREA = "ar_00000000000000000000000000";
const UNKNOWN_DEVICE = "dv_00000000000000000000000000";
const UNKNOWN_DASHBOARD = "db_00000000000000000000000000";

function docWithArea(areaId: string) {
  return {
    version: 4,
    root: {
      kind: "group",
      children: [
        {
          kind: "group",
          area: areaId,
          heading: true,
          children: [{ kind: "card", type: "sankey" }],
        },
      ],
    },
  };
}

/**
 * Drive `provenance-daily` ANONYMOUSLY with a real `?access=` share token — the one check that
 * distinguishes a correct `shareableRoutes` entry from a missing one end-to-end.
 *
 * READ-ONLY: it never creates a share token (the dev database is shared with other agents and with
 * Simon). It reads the existing non-revoked tokens, and uses the LEGACY route as the oracle for which
 * (token, area) pair is actually authorized — a token only grants the areas its own dashboard shows.
 * Whatever the legacy route answers 200 to, the v4 twin must answer identically.
 */
async function driveSharedProvenanceDaily(areas: any[]): Promise<void> {
  section(
    "GET /api/v4/areas/{id}/provenance-daily — ANONYMOUS, real share token",
  );
  if (!planetscaleDb) {
    skip("the share-token leg", "no database configured in this environment");
    return;
  }
  const tokens = await planetscaleDb
    .select({ token: shareTokens.token })
    .from(shareTokens)
    .where(isNull(shareTokens.revokedAt));
  if (tokens.length === 0) {
    skip("the share-token leg", "no non-revoked share tokens on this database");
    return;
  }

  for (const { token } of tokens) {
    for (const a of areas) {
      // 🛑 The search itself is the check that matters. Until stage 13 this loop probed the LEGACY route
      // first and used it as the oracle; that route is deleted, so the v4 route is now driven blind —
      // and a missing `shareableRoutes` entry would make EVERY (token, area) pair 404 and the whole leg
      // skip with a plausible-looking message. The skip at the bottom therefore distinguishes
      // "404 everywhere" (the matcher is gone: FAIL) from "403/404 per token" (genuinely out of scope).
      const v4 = await request(
        "GET",
        `/api/v4/areas/${a.id}/provenance-daily?last=3d&access=${token}`,
        { as: "anon" },
      );
      if (v4.status !== 200) continue;
      console.log(`  using token …${token.slice(-6)} on ${a.displayName}`);
      ok(
        v4.status === 200,
        "an anonymous share-token viewer reaches the v4 route and is authorized by the handler",
        v4.status,
      );
      ok(
        Array.isArray(v4.body?.days) || typeof v4.body?.systemId === "number",
        "…and gets the dense columnar ProvenanceDailyResponse the panel charts",
        Object.keys(v4.body ?? {}),
      );
      // 🛑 The LEGACY path is gone, and so is its `shareableRoutes` entry (stage 13). Anonymous, WITH a
      // live token, it must not answer 200 — that would mean the route or the bypass outlived the
      // client that moved off it.
      const legacyGone = await request(
        "GET",
        `/api/areas/${a.id}/provenance-daily?last=3d&access=${token}`,
        { as: "anon" },
      );
      ok(
        legacyGone.status === 404,
        "the deleted LEGACY provenance-daily path answers 404 to the same live token",
        legacyGone.status,
      );
      // The token must not become a skeleton key: another area outside the dashboard's scope stays shut.
      const other = areas.find((o) => o.id !== a.id);
      if (other) {
        const escalate = await request(
          "GET",
          `/api/v4/areas/${other.id}/provenance-daily?last=3d&access=${token}`,
          { as: "anon" },
        );
        ok(
          escalate.status !== 200,
          "an out-of-scope area refuses the same token (no widened scope)",
          escalate.status,
        );
      }
      return;
    }
  }
  skip(
    "the share-token leg",
    "no (token, area) pair is authorized — if EVERY pair 404'd, the `shareableRoutes` entry is missing",
  );
}

/**
 * A request with NO Authorization header — the only way to tell a `lib/route-matchers.ts` entry that is
 * load-bearing from one that is decorative. A Clerk-gated route answers 404 (the middleware's
 * `protect-rewrite`); a `publicRoutes` route reaches its handler and answers that handler's own 401.
 *
 * Stage 12 landed `request()`'s `as` parameter first, so this is now a thin alias over it rather than
 * a second fetch/parse. The signature stays POSITIONAL (`body`, not an options object) — the `{}` at
 * the recompute-provenance call site is a request BODY, and absorbing it as options would leave the
 * handler with no JSON and silently take a different date-param branch while still returning a
 * plausible status.
 */
async function callAnon(
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return request(method, path, {
    as: "anon",
    ...(body !== undefined ? { body } : {}),
  });
}

/**
 * HARD-delete every scratch area this script has ever created, over a direct DB connection.
 *
 * `DELETE /api/v4/areas/{id}` archives rather than deletes (an area's uuid keys its provenance history),
 * so there is no HTTP teardown that restores `liveone-dev` to its baseline row counts — and this
 * database is shared with three other worktrees, Vercel previews and Simon's local dev. Returns how many
 * rows it removed so the caller can report a clean run. `legacy_handles.area_id` has no ON DELETE, so
 * that row must go first or the area delete is refused by the FK.
 */
async function sweepScratchAreas(): Promise<number> {
  const db = requirePlanetscaleDb();
  const rows = await db
    .select({ id: areas.id })
    .from(areas)
    .where(like(areas.name, `${AREA_PREFIX}%`));
  for (const row of rows) {
    await db.delete(legacyHandles).where(eq(legacyHandles.areaId, row.id));
    await db.delete(areas).where(eq(areas.id, row.id)); // area_members/area_bindings cascade
  }
  return rows.length;
}

interface BindingFixture {
  /** `dv_` → integer handle, learned from the areas-of-one (an area of one member IS that device). */
  handleOf: Map<string, number>;
  /** Two readable devices, each with a point this script can legally bind. */
  deviceA: string;
  deviceB: string;
  bindingA: { role: string; metricType: string; pointId: string };
  bindingB: { role: string; metricType: string; pointId: string };
  /** One `vendor:"helper"` device — the SERVER-MANAGED member a full replace must never evict. */
  helperDevice: string | null;
}

/**
 * BUILD (do not borrow) a two-devices-with-a-bindable-point-each fixture, using only the public API.
 *
 * Nothing is hardcoded, and nothing is cloned from an existing multi-member area — an earlier version
 * did exactly that and went un-runnable the moment the 2-hourly prod→dev sync rewrote
 * `areas.owner_user_id` to a PROD user id, dropping every multi-member area out of the test user's
 * readable set. What survives that: an area whose `members` is a single device IS that device (its
 * handle addresses the device), so the readable areas-of-one give both a `dv_` → integer-handle map and
 * a set of devices this user can definitely pull into an area of their own.
 *
 * The candidate bindings are then checked with the SERVER'S OWN predicate (`bindingShapeMatches`, which
 * `replaceBindings` validates against), so a fixture that this function returns is one the API must
 * accept — the fixture cannot drift away from the binding rules.
 */
async function findBindingFixture(
  areaList: any[],
): Promise<BindingFixture | null> {
  const handleOf = new Map<string, number>();
  // EVERY helper, not merely the first: there are several on `liveone-dev`, and skipping only one of
  // them let a helper become `deviceB` — at which point the members PUT correctly refused to evict it
  // and three assertions failed on a bad fixture rather than on a real defect.
  const helpers = new Set<string>();
  for (const a of areaList) {
    const agg = (await call("GET", `/api/v4/areas/${a.id}`)).body;
    const members: any[] = agg?.members ?? [];
    for (const m of members) if (m.vendor === "helper") helpers.add(m.id);
    if (members.length === 1) handleOf.set(members[0].id, a.legacySystemId);
  }

  /** The first (role, metric, point) triple on this device that `replaceBindings` would accept. */
  const bindableOn = async (handle: number) => {
    const pts =
      (await call("GET", `/api/device/${handle}/points`)).body?.points ?? [];
    for (const p of pts) {
      const stem =
        typeof p.logicalPath === "string"
          ? p.logicalPath.slice(0, p.logicalPath.lastIndexOf("/"))
          : null;
      if (!stem || !p.pointId) continue;
      for (const role of Object.keys(ROLES) as RoleId[]) {
        if (
          bindingShapeMatches(role, p.metricType, {
            logicalPathStem: stem,
            metricType: p.metricType,
          })
        )
          return { role, metricType: p.metricType, pointId: p.pointId };
      }
    }
    return null;
  };

  const found: { device: string; binding: any }[] = [];
  for (const [device, handle] of handleOf) {
    if (helpers.has(device)) continue; // server-managed — never evicted, so useless as the removal case
    const binding = await bindableOn(handle);
    if (binding) found.push({ device, binding });
    if (found.length === 2) break;
  }
  if (found.length < 2) return null;
  return {
    handleOf,
    deviceA: found[0].device,
    deviceB: found[1].device,
    bindingA: found[0].binding,
    bindingB: found[1].binding,
    helperDevice: [...helpers][0] ?? null,
  };
}

/** Keys `b` has that `a` does not — the "silent narrowing" check STEP 0's D2 was found by. */
/**
 * Every handler of the two deleted legacy trees, as (method, path) — 28 handlers across 15 route files,
 * measured on `origin/main` before the deletion (config-v4 Phase 14 stage 13).
 *
 * 🛑 This is the ONLY proof that the deletion actually reached the server. `tsc` cannot see a URL in a
 * template literal, so a client left behind on a legacy path compiles clean; and a route file left
 * behind compiles clean too. A 404 from a REAL SESSION is the discriminator: with a valid Clerk JWT the
 * middleware does not rewrite, so 404 means "Next has no such route" rather than "the edge ate it".
 */
const DELETED_LEGACY_HANDLERS: [string, (areaId: string) => string][] = [
  ["GET", () => "/api/areas"],
  ["POST", () => "/api/areas"],
  ["GET", () => "/api/areas/readable"],
  ["GET", () => "/api/areas/candidate-devices"],
  ["GET", () => "/api/areas/by-handle/1"],
  ["GET", (a) => `/api/areas/${a}`],
  ["PATCH", (a) => `/api/areas/${a}`],
  ["DELETE", (a) => `/api/areas/${a}`],
  ["GET", (a) => `/api/areas/${a}/bindings`],
  ["PUT", (a) => `/api/areas/${a}/bindings`],
  ["POST", (a) => `/api/areas/${a}/devices`],
  ["DELETE", (a) => `/api/areas/${a}/devices`],
  ["GET", (a) => `/api/areas/${a}/default-section`],
  ["GET", (a) => `/api/areas/${a}/provenance-daily`],
  ["GET", (a) => `/api/areas/${a}/provenance-summary`],
  ["POST", (a) => `/api/areas/${a}/recompute-provenance`],
  ["GET", () => "/api/dashboards"],
  ["POST", () => "/api/dashboards"],
  ["GET", () => `/api/dashboards/${UNKNOWN_DASHBOARD}`],
  ["PATCH", () => `/api/dashboards/${UNKNOWN_DASHBOARD}`],
  ["DELETE", () => `/api/dashboards/${UNKNOWN_DASHBOARD}`],
  ["GET", () => `/api/dashboards/${UNKNOWN_DASHBOARD}/share`],
  ["POST", () => `/api/dashboards/${UNKNOWN_DASHBOARD}/share`],
  ["PATCH", () => `/api/dashboards/${UNKNOWN_DASHBOARD}/share`],
  ["DELETE", () => `/api/dashboards/${UNKNOWN_DASHBOARD}/share`],
  ["GET", () => `/api/dashboards/${UNKNOWN_DASHBOARD}/grants`],
  ["POST", () => `/api/dashboards/${UNKNOWN_DASHBOARD}/grants`],
  ["DELETE", () => `/api/dashboards/${UNKNOWN_DASHBOARD}/grants`],
];

async function assertLegacyTreesDeleted(realAreaId: string): Promise<void> {
  section("🛑 the LEGACY /api/areas + /api/dashboards trees are DELETED");
  // A REAL area id, not a synthetic one: a surviving route would answer 200/403 on it rather than the
  // 404 an unknown id would produce anyway, so the assertion cannot pass for the wrong reason.
  const alive: string[] = [];
  for (const [method, path] of DELETED_LEGACY_HANDLERS) {
    const res = await call(method, path(realAreaId), {
      body: method === "GET" || method === "DELETE" ? undefined : {},
    });
    if (res.status !== 404)
      alive.push(`${method} ${path(realAreaId)} → ${res.status}`);
  }
  ok(
    alive.length === 0,
    `all ${DELETED_LEGACY_HANDLERS.length} deleted legacy handlers answer 404 to an AUTHENTICATED caller`,
    { stillAlive: alive },
  );
  // The control: the v4 replacements are still there, so a blanket "everything 404s" (a broken dev
  // server, a bad base URL) cannot pass the check above.
  const control = await call("GET", `/api/v4/areas/${realAreaId}`);
  ok(
    control.status === 200,
    "…while the v4 replacement still answers 200 (so this is deletion, not a dead server)",
    control.status,
  );
}

function missingKeys(a: unknown, b: unknown): string[] {
  const has = Object.keys((a ?? {}) as object);
  return Object.keys((b ?? {}) as object).filter((k) => !has.includes(k));
}

async function main(): Promise<void> {
  assertNotProd();
  console.log(`target: ${BASE}`);

  const scratch = new Set<string>();
  const trash = async (): Promise<void> => {
    for (const id of scratch) {
      const r = await call("DELETE", `/api/v4/dashboards/${id}`);
      if (r.status !== 200 && r.status !== 404)
        console.error(`  ! failed to delete scratch ${id}: ${r.status}`);
      scratch.delete(id);
    }
  };

  // Self-heal: adopt (and therefore delete) anything a previous crashed run left behind.
  const preexisting = await call("GET", "/api/v4/dashboards");
  for (const d of preexisting.body?.dashboards ?? []) {
    if (typeof d?.name === "string" && d.name.startsWith(SCRATCH_PREFIX)) {
      console.log(`  (sweeping leftover scratch dashboard ${d.id})`);
      scratch.add(d.id);
    }
  }
  await trash();
  const preSwept = await sweepScratchAreas();
  if (preSwept > 0)
    console.log(
      `  (swept ${preSwept} leftover scratch area(s) from a crashed run)`,
    );

  try {
    // ---------------------------------------------------------------- 1. GET /areas
    section("GET /api/v4/areas");
    const areas = await call("GET", "/api/v4/areas");
    ok(areas.status === 200, "200", areas.status);
    const list = areas.body?.areas ?? [];
    ok(
      Array.isArray(list) && list.length > 0,
      "returns a non-empty list",
      list,
    );
    ok(
      list.every(
        (a: any) =>
          typeof a.id === "string" &&
          a.id.startsWith("ar_") &&
          typeof a.displayName === "string" &&
          typeof a.chartCapable === "boolean",
      ),
      "every entry is { id: ar_…, displayName, chartCapable }",
      list[0],
    );
    // 🛑 A STATUS-ONLY assertion cannot see this one. `clientShellResolver` turns `legacySystemId` into
    // the handle every card fetches its data with, so a 200 that omits it renders a dashboard of
    // permanent skeletons — silently. Assert the FIELD, and assert it against the legacy twin this
    // route is meant to replace, so the two cannot drift apart again.
    ok(
      list.every((a: any) => typeof a.legacySystemId === "number"),
      "every entry carries `legacySystemId` (the handle every card binds its data to)",
      list[0],
    );
    // 🛑 THE `readableAreasQuery` CONTRACT, pinned exactly (config-v4 Phase 14 stage 13). Until now this
    // was diffed against `GET /api/areas/readable`; that route is deleted, so the contract is stated
    // directly against `ReadableArea` — the type `lib/queries/areas.ts` casts the body to, unchecked.
    ok(
      list.length > 0 &&
        list.every(
          (a: any) =>
            typeof a.id === "string" &&
            typeof a.displayName === "string" &&
            typeof a.legacySystemId === "number" &&
            typeof a.chartCapable === "boolean",
        ),
      "every entry satisfies `ReadableArea` in full — the shape readableAreasQuery casts to",
      list[0],
    );
    // Prefer a chart-capable area: it exercises the richest seed strategy.
    const area = list.find((a: any) => a.chartCapable) ?? list[0];
    if (!area) throw new Error("no readable areas — cannot continue");
    console.log(`  using area ${area.id} (${area.displayName})`);

    // ------------------------------------------------------------- 1b. GET /devices
    // The area builder's member picker (config-v4 Phase 14 stage 13). Never driven over HTTP before —
    // stage 12 covered it with route tests only, and it had no client until this stage.
    section("GET /api/v4/devices — the area builder's member picker");
    const devicesRes = await call("GET", "/api/v4/devices");
    ok(devicesRes.status === 200, "200", devicesRes.status);
    const deviceList: any[] = devicesRes.body?.devices ?? [];
    ok(deviceList.length > 0, "returns the caller's readable devices", {
      count: deviceList.length,
    });
    // The exact `CandidateDevice` key set `components/area-builder/types.ts` casts to. `legacySystemId`
    // is what MembersTab renders as "ID: n" and what create-mode joins the seed device on; `id` (dv_) is
    // the currency `POST /api/v4/areas` and `PUT …/members` take.
    ok(
      deviceList.every(
        (d: any) =>
          (d.id === null || String(d.id).startsWith("dv_")) &&
          typeof d.legacySystemId === "number" &&
          typeof d.name === "string" &&
          "slug" in d &&
          typeof d.vendor === "string" &&
          "vendorSiteId" in d &&
          typeof d.status === "string" &&
          "ownerUserId" in d,
      ),
      "every entry satisfies `CandidateDevice` in full (id: dv_…, legacySystemId, name, slug, vendor, vendorSiteId, status, ownerUserId)",
      deviceList[0],
    );
    ok(
      deviceList.every(
        (d: any) =>
          !("displayName" in d) && !("vendorType" in d) && !("alias" in d),
      ),
      "…and speaks v4 vocabulary only (no displayName/vendorType/alias)",
      Object.keys(deviceList[0] ?? {}),
    );

    // ---------------------------------------------------------------- 2. GET /areas/{id}
    section("GET /api/v4/areas/{id}");
    const detail = await call("GET", `/api/v4/areas/${area.id}`);
    ok(detail.status === 200, "200", detail.status);
    ok(detail.body?.area?.id === area.id, "echoes the ar_ id", detail.body);
    ok(
      typeof detail.body?.area?.name === "string" &&
        "slug" in detail.body.area &&
        Array.isArray(detail.body.area.capabilities),
      "area is { name, slug, capabilities, … }",
      detail.body?.area,
    );
    ok(
      Array.isArray(detail.body?.members) &&
        detail.body.members.every((m: any) => m.id?.startsWith?.("dv_")),
      "members carry dv_ TypeIDs",
      detail.body?.members,
    );
    ok(
      Array.isArray(detail.body?.bindings) &&
        detail.body.bindings.every(
          (b: any) =>
            b.id?.startsWith?.("bn_") && b.pointId?.startsWith?.("pt_"),
        ),
      "bindings carry bn_/pt_ TypeIDs",
      detail.body?.bindings,
    );
    ok(
      typeof detail.body?.area?.legacySystemId === "number",
      "area carries `legacySystemId` (the /api/data address, as the legacy twin does)",
      detail.body?.area,
    );
    const memberDevice: string | undefined = detail.body?.members?.[0]?.id;

    const badId = await call("GET", "/api/v4/areas/not-a-typeid");
    ok(badId.status === 400, "malformed id → 400", badId);
    const unknownArea = await call("GET", `/api/v4/areas/${UNKNOWN_AREA}`);
    ok(
      unknownArea.status === 403,
      "unknown/unreadable id → 403 (§8.4 collapses unknown into not-yours)",
      unknownArea,
    );

    // ---------------------------------------------------------------- 3. default-group
    section("GET /api/v4/areas/{id}/default-group");
    const group = await call("GET", `/api/v4/areas/${area.id}/default-group`);
    ok(group.status === 200, "200", group.status);
    ok(
      group.body?.group?.kind === "group" &&
        group.body.group.area === area.id &&
        Array.isArray(group.body.group.children),
      "returns an area-bound group node",
      group.body,
    );
    ok(
      String(JSON.stringify(group.body)).includes('"id":"n_'),
      "nodes carry server-assigned n_ ids",
      group.body,
    );

    // ---------------------------------------------------------------- 4. eligibility
    section("GET /api/v4/areas/{id}/eligibility");
    const elig = await call("GET", `/api/v4/areas/${area.id}/eligibility`);
    ok(elig.status === 200, "200", elig.status);
    ok(
      Array.isArray(elig.body?.areaCards) &&
        Array.isArray(elig.body?.tiles) &&
        Array.isArray(elig.body?.deviceCards),
      "{ areaCards, tiles, deviceCards }",
      elig.body,
    );
    ok(
      elig.body.deviceCards.every((d: any) => d.deviceId?.startsWith?.("dv_")),
      "deviceCards are keyed by `deviceId` (a dv_ TypeID)",
      elig.body.deviceCards,
    );

    // ---------------------------------------------------------------- 5. resolution
    section("GET /api/v4/areas/{id}/resolution");
    const resolution = await call("GET", `/api/v4/areas/${area.id}/resolution`);
    ok(resolution.status === 200, "200", resolution.status);
    ok(
      resolution.body?.areaId === area.id &&
        Array.isArray(resolution.body?.slots) &&
        resolution.body.slots.length > 0,
      "{ areaId, slots: [...] }",
      resolution.body,
    );
    ok(
      resolution.body.slots.every((s: any) =>
        ["explicit", "auto", "config", "absent"].includes(s.mode),
      ),
      "every slot reports a known resolution mode",
      resolution.body.slots?.[0],
    );

    // ======================================================= the SEVEN area mutations (stage 10)
    // 🛑 Every one of these is driven by CREATING FROM SCRATCH, never by re-running against something
    // that already exists. This repo has twice shipped a write that worked on the second call and 500'd
    // on the first (an `ON CONFLICT … coalesce` path, and an FK that only breaks first creation).
    const fixture = await findBindingFixture(list);
    if (!fixture)
      throw new Error(
        "fewer than 2 readable devices carry a bindable point — cannot prove the members PUT removal leg",
      );
    console.log(
      `  fixture: ${fixture.deviceA} (${fixture.bindingA.role}/${fixture.bindingA.metricType}) + ${fixture.deviceB} (${fixture.bindingB.role}/${fixture.bindingB.metricType})`,
    );
    const handleA = fixture.handleOf.get(fixture.deviceA)!;
    const handleB = fixture.handleOf.get(fixture.deviceB)!;

    // ---------------------------------------------------------------- 5b. POST /areas
    section("POST /api/v4/areas");
    const noName = await call("POST", "/api/v4/areas", {
      body: { members: [fixture.deviceA] },
    });
    ok(noName.status === 422, "no name → 422", noName);
    const noMembers = await call("POST", "/api/v4/areas", {
      body: { name: `${AREA_PREFIX} nomembers` },
    });
    ok(noMembers.status === 422, "no members → 422", noMembers);
    const badMember = await call("POST", "/api/v4/areas", {
      body: { name: `${AREA_PREFIX} badmember`, members: ["not-a-typeid"] },
    });
    ok(badMember.status === 422, "malformed member id → 422", badMember);
    const dupMember = await call("POST", "/api/v4/areas", {
      body: {
        name: `${AREA_PREFIX} dup`,
        members: [fixture.deviceA, fixture.deviceA],
      },
    });
    ok(dupMember.status === 422, "duplicate member → 422", dupMember);
    const unknownMember = await call("POST", "/api/v4/areas", {
      body: { name: `${AREA_PREFIX} unknown`, members: [UNKNOWN_DEVICE] },
    });
    ok(
      unknownMember.status === 403,
      "unknown/unreadable member → 403 (§8.4 collapses unknown into not-readable)",
      unknownMember,
    );

    const createdArea = await call("POST", "/api/v4/areas", {
      body: {
        name: `${AREA_PREFIX} site`,
        slug: AREA_SLUG,
        members: [fixture.deviceA, fixture.deviceB],
        location: { country: "AU", state: "VIC" },
      },
    });
    ok(createdArea.status === 201, "201", createdArea);
    ok(
      typeof createdArea.body?.id === "string" &&
        createdArea.body.id.startsWith("ar_") &&
        typeof createdArea.body?.legacySystemId === "number",
      "returns { id: ar_…, legacySystemId }",
      createdArea.body,
    );
    if (!createdArea.body?.id)
      throw new Error("area create failed — cannot continue");
    const areaId: string = createdArea.body.id;

    const slugClash = await call("POST", "/api/v4/areas", {
      body: {
        name: `${AREA_PREFIX} clash`,
        slug: AREA_SLUG,
        members: [fixture.deviceA],
      },
    });
    ok(
      slugClash.status === 409,
      "POST with a taken slug → 409 (never a bare 500 — lib/db/pg-error.ts)",
      slugClash,
    );

    // ---------------------------------------------------------------- 5c. the new area reads back
    section("GET /api/v4/areas/{id} — the freshly created area");
    const fresh = await call("GET", `/api/v4/areas/${areaId}`);
    ok(fresh.status === 200, "200", fresh);
    ok(
      fresh.body?.area?.slug === AREA_SLUG &&
        fresh.body?.area?.legacySystemId === createdArea.body.legacySystemId,
      "slug + legacySystemId persisted as created",
      fresh.body?.area,
    );
    ok(
      fresh.body?.members?.length === 2 &&
        fresh.body.members[0].id === fixture.deviceA &&
        fresh.body.members[1].id === fixture.deviceB,
      "members are the two requested devices, in the requested ORDER",
      fresh.body?.members,
    );
    ok(
      fresh.body?.area?.location?.state === "VIC",
      "location round-tripped",
      fresh.body?.area?.location,
    );

    // ---------------------------------------------------------------- 5d. PUT bindings
    section("PUT /api/v4/areas/{id}/bindings");
    const wantBindings = [
      {
        role: fixture.bindingA.role,
        metricType: fixture.bindingA.metricType,
        pointId: fixture.bindingA.pointId,
      },
      {
        role: fixture.bindingB.role,
        metricType: fixture.bindingB.metricType,
        pointId: fixture.bindingB.pointId,
      },
    ];
    const badBindings = await call("PUT", `/api/v4/areas/${areaId}/bindings`, {
      body: { bindings: "nope" },
    });
    ok(badBindings.status === 422, "bindings not an array → 422", badBindings);
    const badPointId = await call("PUT", `/api/v4/areas/${areaId}/bindings`, {
      body: {
        bindings: [{ role: "solar", metricType: "power", pointId: "ar_x" }],
      },
    });
    ok(
      badPointId.status === 422,
      "a non-`pt_` pointId → 422 (parsed at the seam, not surfaced as 'not found')",
      badPointId,
    );
    const putBindings = await call("PUT", `/api/v4/areas/${areaId}/bindings`, {
      body: { bindings: wantBindings },
    });
    ok(putBindings.status === 200, "200", putBindings);
    ok(
      putBindings.body?.bindings?.length === 2 &&
        putBindings.body.bindings.every(
          (b: any) =>
            b.id?.startsWith?.("bn_") &&
            b.pointId?.startsWith?.("pt_") &&
            typeof b.priority === "number",
        ),
      "returns the new state: bn_ ids, pt_ points, priority",
      putBindings.body?.bindings,
    );
    ok(
      missingKeys(putBindings.body.bindings[0], fresh.body.bindings[0] ?? {})
        .length === 0 &&
        missingKeys(
          putBindings.body.bindings[0],
          (await call("GET", `/api/v4/areas/${areaId}`)).body?.bindings?.[0],
        ).length === 0,
      "the PUT's binding shape is identical to the aggregate GET's (same loader)",
      putBindings.body.bindings[0],
    );
    // 🛑 The `AreaBinding` contract BindingsTab casts to (stage 13). Previously diffed against the
    // legacy editor projection (role/metricType/pointId/transform); that route is deleted, so the four
    // legacy keys plus the two v4 widenings (`id`, `priority`) are asserted directly.
    ok(
      ["id", "role", "metricType", "pointId", "priority", "transform"].every(
        (k) => k in putBindings.body.bindings[0],
      ) &&
        putBindings.body.bindings[0].id.startsWith("bn_") &&
        putBindings.body.bindings[0].pointId.startsWith("pt_"),
      "a binding is { id: bn_…, role, metricType, pointId: pt_…, priority, transform }",
      putBindings.body.bindings[0],
    );
    const foreignPoint = await call("PUT", `/api/v4/areas/${areaId}/bindings`, {
      body: {
        bindings: [
          {
            role: fixture.bindingA.role,
            metricType: fixture.bindingA.metricType,
            pointId: fixture.bindingA.pointId,
          },
          {
            role: fixture.bindingA.role,
            metricType: fixture.bindingA.metricType,
            pointId: fixture.bindingA.pointId,
          },
        ],
      },
    });
    ok(
      foreignPoint.status === 422,
      "a duplicate (role, metric, point) → 422",
      foreignPoint,
    );

    // ---------------------------------------------------------------- 5e. PUT members
    section("PUT /api/v4/areas/{id}/members — the declarative full replace");
    const emptyMembers = await call("PUT", `/api/v4/areas/${areaId}/members`, {
      body: { members: [] },
    });
    ok(
      emptyMembers.status === 422,
      "an empty membership → 422 (an area of zero members has no point set)",
      emptyMembers,
    );
    const unreadableMember = await call(
      "PUT",
      `/api/v4/areas/${areaId}/members`,
      { body: { members: [UNKNOWN_DEVICE] } },
    );
    ok(
      unreadableMember.status === 403,
      "an unreadable member → 403",
      unreadableMember,
    );

    // 🛑 THE CASE THAT PROVES THE REMOVAL LEG. Two members, a binding on EACH, remove one. An
    // under-delete (the departing member's binding survives) and an over-delete (the survivor's binding
    // goes too) are both SILENT — only asserting on the exact surviving set can tell them apart.
    const before = await call("GET", `/api/v4/areas/${areaId}`);
    ok(
      before.body?.members?.length === 2 && before.body?.bindings?.length === 2,
      "PRE-STATE: two members, one binding on each",
      {
        members: before.body?.members?.map((m: any) => m.id),
        bindings: before.body?.bindings?.map((b: any) => b.pointId),
      },
    );
    const removed = await call("PUT", `/api/v4/areas/${areaId}/members`, {
      body: { members: [fixture.deviceA] },
    });
    ok(removed.status === 200, "200", removed);
    ok(
      removed.body?.members?.length === 1 &&
        removed.body.members[0].id === fixture.deviceA,
      "returns the new state: exactly the surviving member",
      removed.body?.members,
    );
    const after = await call("GET", `/api/v4/areas/${areaId}`);
    ok(
      after.body?.bindings?.length === 1 &&
        after.body.bindings[0].pointId === fixture.bindingA.pointId,
      "the DEPARTING member's binding is gone and the SURVIVOR's remains (not zero, not two)",
      after.body?.bindings?.map((b: any) => b.pointId),
    );
    ok(
      missingKeys(removed.body.members[0], after.body.members[0]).length === 0,
      "the PUT's member shape is identical to the aggregate GET's (same loader)",
      removed.body?.members?.[0],
    );
    // …and the add leg, restoring the member. Its binding does NOT come back — bindings are authored,
    // not implied — which is exactly what the legacy add/remove pair did too.
    const restored = await call("PUT", `/api/v4/areas/${areaId}/members`, {
      body: { members: [fixture.deviceA, fixture.deviceB] },
    });
    ok(
      restored.status === 200 && restored.body?.members?.length === 2,
      "adding a member back → 200 with both members",
      restored.body?.members,
    );
    ok(
      (await call("GET", `/api/v4/areas/${areaId}`)).body?.bindings?.length ===
        1,
      "re-adding the member does NOT resurrect its deleted binding",
    );
    // A pure REORDER is a real edit, not a no-op: the array index is `area_members.ordinal`.
    const reordered = await call("PUT", `/api/v4/areas/${areaId}/members`, {
      body: { members: [fixture.deviceB, fixture.deviceA] },
    });
    ok(
      reordered.body?.members?.[0]?.id === fixture.deviceB,
      "a pure reorder is applied (ordinal = array index)",
      reordered.body?.members?.map((m: any) => m.id),
    );
    // 🛑 THE `AreaMember` CONTRACT, and the one v4 widening stage 13 needed. `members[]` used to carry
    // only the `dv_`, but the Bindings tab addresses `/api/device/{handle}/points` — the ONLY way to
    // enumerate a member's bindable points — and re-deriving that handle by joining
    // `GET /api/v4/devices` silently drops every member that route filters out (it is `activeOnly`, and
    // two `status='removed'` members exist on liveone-dev today). So the number is carried.
    await call("PUT", `/api/v4/areas/${areaId}/members`, {
      body: { members: [fixture.deviceA, fixture.deviceB] },
    });
    const memberShape = (await call("GET", `/api/v4/areas/${areaId}`)).body
      ?.members;
    ok(
      Array.isArray(memberShape) &&
        memberShape.length === 2 &&
        memberShape.every(
          (m: any) =>
            typeof m.id === "string" &&
            m.id.startsWith("dv_") &&
            typeof m.legacySystemId === "number" &&
            typeof m.name === "string" &&
            typeof m.vendor === "string" &&
            typeof m.status === "string" &&
            Array.isArray(m.capabilities),
        ),
      "a member is { id: dv_…, legacySystemId, name, vendor, status, capabilities }",
      memberShape?.[0],
    );
    ok(
      memberShape?.map((m: any) => m.legacySystemId).join(",") ===
        [handleA, handleB].join(","),
      "…and each `legacySystemId` is the member's real handle, in membership order",
      { got: memberShape?.map((m: any) => m.legacySystemId), handleA, handleB },
    );

    // 🛑 A SERVER-MANAGED `vendor:"helper"` member survives being omitted from a full replace. Driven on
    // a throwaway area, never on a real one — but the hazard it guards is real and lives on the real
    // ones: a client that read `members`, filtered to the devices its picker shows, and PUT the result
    // back would otherwise delete the area's blend bindings and blank its provenance card until the
    // next daily recompute rebuilt them.
    if (fixture.helperDevice) {
      const withHelper = await call("POST", "/api/v4/areas", {
        body: {
          name: `${AREA_PREFIX} helper-keep`,
          members: [fixture.deviceA, fixture.helperDevice],
        },
      });
      ok(
        withHelper.status === 201,
        "an area with a helper member creates",
        withHelper,
      );
      const dropped = await call(
        "PUT",
        `/api/v4/areas/${withHelper.body?.id}/members`,
        { body: { members: [fixture.deviceA] } },
      );
      ok(
        dropped.body?.members?.length === 2 &&
          dropped.body.members.some(
            (m: any) => m.id === fixture.helperDevice,
          ) &&
          dropped.body.members.some((m: any) => m.id === fixture.deviceA),
        "omitting a `vendor:helper` member does NOT evict it (server-managed membership)",
        dropped.body?.members,
      );
      const droppedReal = await call(
        "PUT",
        `/api/v4/areas/${withHelper.body?.id}/members`,
        { body: { members: [fixture.helperDevice] } },
      );
      ok(
        droppedReal.body?.members?.length === 1 &&
          droppedReal.body.members[0].id === fixture.helperDevice,
        "…while a REAL member named-out is still removed (the exception is narrow)",
        droppedReal.body?.members,
      );
    }

    // The area-of-one guard: a device's OWN area cannot be given a second member.
    const areaOfOne = list.find(
      (a: any) => fixture.handleOf.get(fixture.deviceA) === a.legacySystemId,
    );
    if (areaOfOne) {
      const cannotAdd = await call(
        "PUT",
        `/api/v4/areas/${areaOfOne.id}/members`,
        { body: { members: [fixture.deviceA, fixture.deviceB] } },
      );
      ok(
        cannotAdd.status === 409 &&
          cannotAdd.body?.code === "AREA_OF_ONE_CANNOT_ADD",
        "a device's own area refuses a second member → 409 AREA_OF_ONE_CANNOT_ADD",
        cannotAdd,
      );
      const idempotent = await call(
        "PUT",
        `/api/v4/areas/${areaOfOne.id}/members`,
        { body: { members: [fixture.deviceA] } },
      );
      ok(
        idempotent.status === 200,
        "…but restating its existing single member is a legal no-op (idempotent PUT)",
        idempotent,
      );
    }

    // ---------------------------------------------------------------- 5f. PATCH
    section("PATCH /api/v4/areas/{id}");
    const patchedArea = await call("PATCH", `/api/v4/areas/${areaId}`, {
      body: {
        name: `${AREA_PREFIX} renamed`,
        slug: `${AREA_SLUG}-2`,
        dayOffsetMin: 570,
        displayTimezone: "Australia/Adelaide",
        location: { postcode: "5000" },
      },
    });
    ok(patchedArea.status === 200, "200", patchedArea);
    ok(
      patchedArea.body?.area?.name === `${AREA_PREFIX} renamed` &&
        patchedArea.body?.area?.slug === `${AREA_SLUG}-2` &&
        patchedArea.body?.area?.dayOffsetMin === 570 &&
        patchedArea.body?.area?.displayTimezone === "Australia/Adelaide",
      "echoes the new state, and GET/PATCH speak the same keys (name/slug/dayOffsetMin)",
      patchedArea.body?.area,
    );
    ok(
      patchedArea.body?.area?.location?.postcode === "5000" &&
        patchedArea.body?.area?.location?.state === "VIC",
      "location MERGES rather than replacing (state survived a postcode-only patch)",
      patchedArea.body?.area?.location,
    );
    ok(
      missingKeys(
        patchedArea.body,
        (await call("GET", `/api/v4/areas/${areaId}`)).body,
      ).length === 0,
      "the PATCH echo is the same aggregate the GET returns",
      patchedArea.body?.area,
    );
    const emptyAreaName = await call("PATCH", `/api/v4/areas/${areaId}`, {
      body: { name: "  " },
    });
    ok(emptyAreaName.status === 422, "empty name → 422", emptyAreaName);
    const badOffset = await call("PATCH", `/api/v4/areas/${areaId}`, {
      body: { dayOffsetMin: "600" },
    });
    ok(badOffset.status === 422, "non-numeric dayOffsetMin → 422", badOffset);
    const unknownForPatch = await call(
      "PATCH",
      `/api/v4/areas/${UNKNOWN_AREA}`,
      { body: { name: "x" } },
    );
    ok(
      unknownForPatch.status === 404,
      "unknown area → 404 (the write side keeps the legacy 404/403 split)",
      unknownForPatch,
    );
    const malformedForPatch = await call(
      "PATCH",
      "/api/v4/areas/not-a-typeid",
      {
        body: { name: "x" },
      },
    );
    ok(
      malformedForPatch.status === 400,
      "malformed area id → 400",
      malformedForPatch,
    );
    // A second scratch area, then patch its slug onto the first's → 409 (the pg-error path again).
    const secondArea = await call("POST", "/api/v4/areas", {
      body: { name: `${AREA_PREFIX} second`, members: [fixture.deviceA] },
    });
    ok(secondArea.status === 201, "a second area creates from scratch", {
      status: secondArea.status,
    });
    const patchClash = await call(
      "PATCH",
      `/api/v4/areas/${secondArea.body?.id}`,
      { body: { slug: `${AREA_SLUG}-2` } },
    );
    ok(
      patchClash.status === 409,
      "PATCH onto a taken slug → 409 (never 500)",
      patchClash,
    );

    // ---------------------------------------------------------------- 5g. recompute-provenance
    section("POST /api/v4/areas/{id}/recompute-provenance");
    // 🛑 THE ROUTE-MATCHER PROOF, and the only assertion that can see the entry at all. Anonymous:
    // 401 means the request REACHED the handler (which then rejected it); 404 means the Clerk edge
    // rewrote it away, i.e. the `publicRoutes` entry is missing. A logged-in tester sees 200 either way.
    const anonRecompute = await callAnon(
      "POST",
      `/api/v4/areas/${areaId}/recompute-provenance`,
      {},
    );
    ok(
      anonRecompute.status === 401,
      "anonymous → 401 FROM THE HANDLER, not 404 from the Clerk edge (the publicRoutes entry works)",
      anonRecompute,
    );
    // The negative control: a v4 area route that is NOT in publicRoutes must still be 404'd at the edge.
    const anonControl = await callAnon("GET", `/api/v4/areas/${areaId}`);
    ok(
      anonControl.status === 404,
      "CONTROL: a v4 area route with no entry is still 404'd at the edge (the allow-list is surgical)",
      anonControl,
    );
    const recomputeBadDate = await call(
      "POST",
      `/api/v4/areas/${areaId}/recompute-provenance`,
      { body: { last: "banana" } },
    );
    ok(
      recomputeBadDate.status === 400,
      "malformed date params → 400",
      recomputeBadDate,
    );
    // A real one-day run against a real, already-materialised area. `cursor` == `end` makes this NOT
    // the first batch, so the η re-learn and `updateLatest` are both skipped: it recomputes one day of
    // `flow_attr_1d` to the same values it already holds, and mints nothing.
    const day = new Date(Date.now() - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const recompute = await call(
      "POST",
      `/api/v4/areas/${area.id}/recompute-provenance`,
      { body: { start: day, end: day, cursor: day, limit: 1 } },
    );
    ok(recompute.status === 200, "200 on a real area", recompute);
    ok(
      recompute.body?.ok === true &&
        recompute.body?.areaId === area.id &&
        typeof recompute.body?.systemId === "number" &&
        recompute.body?.done === true,
      "{ ok, areaId: ar_…, systemId, recomputed, rowsWritten, attrRows, from, to, nextCursor, done }",
      recompute.body,
    );
    // The `recomputeAreaFlow` client loop reads exactly these three off each batch; a missing
    // `nextCursor`/`done` pair would loop 200 times or stop after one batch, both silently.
    ok(
      ["recomputed", "nextCursor", "done"].every((k) => k in recompute.body),
      "…carrying the { recomputed, nextCursor, done } lib/areas/recompute-flow.ts loops on",
      recompute.body,
    );

    // ---------------------------------------------------------------- 5h. DELETE
    section("DELETE /api/v4/areas/{id}");
    const ownArea = list.find(
      (a: any) => fixture.handleOf.get(fixture.deviceA) === a.legacySystemId,
    );
    if (ownArea) {
      const refused = await call("DELETE", `/api/v4/areas/${ownArea.id}`);
      ok(
        refused.status === 409,
        "a device's own area refuses deletion → 409",
        refused,
      );
    }
    const deletedArea = await call("DELETE", `/api/v4/areas/${areaId}`);
    ok(
      deletedArea.status === 200 && deletedArea.body?.success === true,
      "200 { success }",
      deletedArea,
    );
    const afterDelete = await call("GET", `/api/v4/areas/${areaId}`);
    ok(
      afterDelete.status === 403,
      "the archived area drops out of the readable set (soft delete = gone, to every consumer)",
      afterDelete,
    );
    ok(
      !((await call("GET", "/api/v4/areas")).body?.areas ?? []).some(
        (a: any) => a.id === areaId,
      ),
      "…and out of GET /api/v4/areas",
    );

    // ---------------------------------------------------------------- 6. GET /dashboards
    section("GET /api/v4/dashboards");
    const dashboards = await call("GET", "/api/v4/dashboards");
    ok(dashboards.status === 200, "200", dashboards.status);
    ok(
      Array.isArray(dashboards.body?.dashboards),
      "{ dashboards: [...] }",
      dashboards.body,
    );
    ok(
      dashboards.body.dashboards.every(
        (d: any) =>
          d.id?.startsWith?.("db_") &&
          "name" in d &&
          "slug" in d &&
          !("displayName" in d) &&
          !("alias" in d),
      ),
      "list speaks v4 vocabulary (name/slug, never displayName/alias)",
      dashboards.body.dashboards?.[0],
    );
    // 🛑 THE `DashboardSummaryDTO` CONTRACT (config-v4 Phase 14 stage 13). `myDashboardsQuery` casts the
    // body to this unchecked, and `app/dashboard/[...slug]/page.tsx` SSR-SEEDS THE SAME CACHE KEY from
    // the DAO — which spells these `displayName`/`alias`. If the seed and the fetch disagree the
    // switcher paints "Untitled" until the first refetch quietly replaces it.
    ok(
      dashboards.body.dashboards.every((d: any) =>
        ["id", "name", "slug", "cardCount", "updatedAt", "access"].every(
          (k) => k in d,
        ),
      ),
      "every entry satisfies `DashboardSummaryDTO` in full — the shape the SSR seed must mirror",
      dashboards.body.dashboards?.[0],
    );

    // ---------------------------------------------------------------- 7. POST /dashboards (plain)
    section("POST /api/v4/dashboards — create from scratch");
    const bad = await call("POST", "/api/v4/dashboards", { body: {} });
    ok(bad.status === 400, "neither name nor seedArea → 400", bad);
    const both = await call("POST", "/api/v4/dashboards", {
      body: { seedArea: area.id, doc: docWithArea(area.id) },
    });
    ok(both.status === 400, "seedArea + doc → 400", both);
    const badSeed = await call("POST", "/api/v4/dashboards", {
      body: { seedArea: "not-a-typeid" },
    });
    ok(badSeed.status === 400, "malformed seedArea → 400", badSeed);
    const unreadableSeed = await call("POST", "/api/v4/dashboards", {
      body: { seedArea: UNKNOWN_AREA },
    });
    ok(
      unreadableSeed.status === 403,
      "unreadable seedArea → 403",
      unreadableSeed,
    );
    const invalidDoc = await call("POST", "/api/v4/dashboards", {
      body: { name: `${SCRATCH_PREFIX} invalid`, doc: { version: 9 } },
    });
    ok(
      invalidDoc.status === 422 && Array.isArray(invalidDoc.body?.errors),
      "invalid doc → 422 { errors }",
      invalidDoc,
    );
    const escalating = await call("POST", "/api/v4/dashboards", {
      body: {
        name: `${SCRATCH_PREFIX} escalating`,
        doc: {
          version: 4,
          root: { kind: "group", area: UNKNOWN_AREA, children: [] },
        },
      },
    });
    ok(escalating.status === 403, "unreadable area ref → 403", escalating);

    const plain = await call("POST", "/api/v4/dashboards", {
      body: { name: `${SCRATCH_PREFIX} plain`, slug: SCRATCH_SLUG },
    });
    ok(plain.status === 201, "201", plain);
    ok(
      typeof plain.body?.id === "string" && plain.body.id.startsWith("db_"),
      "returns a db_ id",
      plain.body,
    );
    if (!plain.body?.id) throw new Error("create failed — cannot continue");
    scratch.add(plain.body.id);
    const created = plain.body.id as string;

    // ---------------------------------------------------------------- 8. GET /dashboards/{id}
    section("GET /api/v4/dashboards/{id}");
    const got = await call("GET", `/api/v4/dashboards/${created}`);
    ok(got.status === 200, "200", got.status);
    ok(
      got.body?.id === created &&
        got.body.name === `${SCRATCH_PREFIX} plain` &&
        got.body.slug === SCRATCH_SLUG &&
        !("alias" in got.body),
      "{ id, name, slug, revision, doc } — v4 vocabulary",
      got.body,
    );
    ok(
      typeof got.body?.revision === "number" &&
        got.etag === `"${got.body.revision}"`,
      "ETag matches the revision",
      { etag: got.etag, revision: got.body?.revision },
    );
    const missing = await call(
      "GET",
      `/api/v4/dashboards/${UNKNOWN_DASHBOARD}`,
    );
    ok(missing.status === 404, "unknown id → 404", missing);

    // ---------------------------------------------------------------- 9. POST …/validate
    section("POST /api/v4/dashboards/{id}/validate");
    const dryRun = await call(
      "POST",
      `/api/v4/dashboards/${created}/validate`,
      {
        body: {
          doc: {
            version: 4,
            root: {
              kind: "group",
              children: [
                { kind: "card", type: "sankey" },
                { kind: "card", type: "not-a-real-card", config: { x: 1 } },
              ],
            },
          },
        },
      },
    );
    ok(dryRun.status === 200, "200", dryRun.status);
    ok(
      dryRun.body?.valid === true,
      "unknown card type does NOT invalidate",
      dryRun.body,
    );
    ok(
      dryRun.body?.warnings?.some((w: any) => w.code === "unknown-card-type"),
      "unknown card type warns (§8.4 warn-not-reject)",
      dryRun.body?.warnings,
    );
    ok(
      JSON.stringify(dryRun.body?.normalized).includes('"config":{"x":1}'),
      "unknown card's opaque config is preserved",
      dryRun.body?.normalized,
    );
    const dryRunBad = await call(
      "POST",
      `/api/v4/dashboards/${created}/validate`,
      { body: { doc: { version: 3 } } },
    );
    ok(
      dryRunBad.status === 200 &&
        dryRunBad.body?.valid === false &&
        dryRunBad.body?.normalized === null,
      "a malformed doc is reported, not thrown (200 valid:false)",
      dryRunBad,
    );

    // ---------------------------------------------------------------- 10. PUT
    section("PUT /api/v4/dashboards/{id}");
    const doc: any = docWithArea(area.id);
    if (memberDevice) {
      doc.root.children[0].children.push({
        kind: "card",
        type: "generator-runs",
        device: memberDevice,
      });
    }
    const put = await call("PUT", `/api/v4/dashboards/${created}`, {
      body: { doc },
      headers: { "If-Match": `"${got.body.revision}"` },
    });
    ok(put.status === 200, "matching If-Match → 200", put);
    ok(
      put.body?.revision === got.body.revision + 1 &&
        put.etag === `"${put.body.revision}"`,
      "revision bumps and the ETag follows",
      { etag: put.etag, revision: put.body?.revision },
    );
    ok(
      JSON.stringify(put.body?.doc).includes('"id":"n_'),
      "echoes the normalized doc with server-assigned node ids",
      put.body?.doc,
    );

    const stale = await call("PUT", `/api/v4/dashboards/${created}`, {
      body: { doc },
      headers: { "If-Match": `"${got.body.revision}"` },
    });
    ok(
      stale.status === 412 &&
        stale.body?.error === "revision-conflict" &&
        stale.body?.current === put.body.revision,
      "stale If-Match → 412 { error:'revision-conflict', current }",
      stale,
    );

    const badIfMatch = await call("PUT", `/api/v4/dashboards/${created}`, {
      body: { doc },
      headers: { "If-Match": "banana" },
    });
    ok(
      badIfMatch.status === 400 &&
        badIfMatch.body?.error === "invalid-if-match",
      "malformed If-Match → 400",
      badIfMatch,
    );

    const putInvalid = await call("PUT", `/api/v4/dashboards/${created}`, {
      body: { doc: { version: 4, root: { kind: "card", type: "sankey" } } },
    });
    ok(
      putInvalid.status === 422 && Array.isArray(putInvalid.body?.errors),
      "invalid doc → 422 { errors } (nothing persisted)",
      putInvalid,
    );

    const putEscalating = await call("PUT", `/api/v4/dashboards/${created}`, {
      body: {
        doc: {
          version: 4,
          root: {
            kind: "group",
            children: [
              { kind: "card", type: "sankey", device: UNKNOWN_DEVICE },
            ],
          },
        },
      },
    });
    ok(
      putEscalating.status === 403,
      "unreadable device ref → 403",
      putEscalating,
    );

    const afterFailures = await call("GET", `/api/v4/dashboards/${created}`);
    ok(
      afterFailures.body?.revision === put.body.revision,
      "no rejected write advanced the revision",
      { was: put.body.revision, now: afterFailures.body?.revision },
    );

    // ---------------------------------------------------------------- 11. POST (seedArea)
    section("POST /api/v4/dashboards — seedArea leg");
    const seeded = await call("POST", "/api/v4/dashboards", {
      body: { name: `${SCRATCH_PREFIX} seeded`, seedArea: area.id },
    });
    ok(seeded.status === 201, "201", seeded);
    if (seeded.body?.id) scratch.add(seeded.body.id);
    const seededDoc = await call("GET", `/api/v4/dashboards/${seeded.body.id}`);
    ok(
      seededDoc.body?.doc?.version === 4 &&
        seededDoc.body.doc.root.kind === "group" &&
        seededDoc.body.doc.root.children.length > 0,
      "the persisted doc is a populated v4 tree",
      seededDoc.body?.doc,
    );
    ok(
      JSON.stringify(seededDoc.body?.doc).includes(area.id),
      "the seeded doc is bound to the seed area",
      seededDoc.body?.doc,
    );
    // Round-trip the seeded doc through validate: whatever the seeder emits must be persistable.
    const reValidate = await call(
      "POST",
      `/api/v4/dashboards/${seeded.body.id}/validate`,
      { body: { doc: seededDoc.body.doc } },
    );
    ok(
      reValidate.body?.valid === true,
      "the seeded doc re-validates clean",
      reValidate.body?.errors,
    );

    // ---------------------------------------------------------------- 12. PATCH
    section("PATCH /api/v4/dashboards/{id}");
    const patched = await call("PATCH", `/api/v4/dashboards/${created}`, {
      body: { name: `${SCRATCH_PREFIX} renamed`, slug: `${SCRATCH_SLUG}-2` },
    });
    ok(patched.status === 200, "200", patched);
    const afterPatch = await call("GET", `/api/v4/dashboards/${created}`);
    ok(
      afterPatch.body?.name === `${SCRATCH_PREFIX} renamed` &&
        afterPatch.body?.slug === `${SCRATCH_SLUG}-2`,
      "the rename actually persisted (GET/PATCH speak the same keys)",
      afterPatch.body,
    );
    const emptyName = await call("PATCH", `/api/v4/dashboards/${created}`, {
      body: { name: "   " },
    });
    ok(emptyName.status === 400, "empty name → 400", emptyName);
    // 🛑 The regression this file was born for: a taken slug must 409, not 500.
    const clash = await call("PATCH", `/api/v4/dashboards/${seeded.body.id}`, {
      body: { slug: `${SCRATCH_SLUG}-2` },
    });
    ok(
      clash.status === 409,
      "PATCH onto a taken slug → 409 (never 500)",
      clash,
    );
    const clashOnCreate = await call("POST", "/api/v4/dashboards", {
      body: { name: `${SCRATCH_PREFIX} clash`, slug: `${SCRATCH_SLUG}-2` },
    });
    if (clashOnCreate.body?.id) scratch.add(clashOnCreate.body.id);
    ok(
      clashOnCreate.status === 409,
      "POST with a taken slug → 409 (never 500)",
      clashOnCreate,
    );

    // ================================================================ SHARING (stage 11)
    //
    // 🛑 Sharing is the ONE genuinely multi-party surface in this system — everything else is
    // effectively single-user. A share token authorizes an ANONYMOUS reader, so the checks below are
    // deliberately end-to-end and anonymous: a status code from an authenticated request proves
    // nothing about what a token holder can actually reach.
    const otherArea = list.find(
      (a: any) => a.id !== area.id && a.legacySystemId !== area.legacySystemId,
    );
    const handle: number = area.legacySystemId;

    section("POST /api/v4/dashboards/{id}/shares — mint");
    const shareDash = await call("POST", "/api/v4/dashboards", {
      body: { name: `${SCRATCH_PREFIX} shares`, doc: docWithArea(area.id) },
    });
    ok(
      shareDash.status === 201,
      "scratch dashboard for sharing created",
      shareDash,
    );
    const sd = shareDash.body?.id as string;
    if (!sd) throw new Error("could not create the sharing scratch dashboard");
    scratch.add(sd);

    const empty = await call("GET", `/api/v4/dashboards/${sd}/shares`);
    ok(
      empty.status === 200 &&
        Array.isArray(empty.body?.tokens) &&
        empty.body.tokens.length === 0,
      "a fresh dashboard has no tokens",
      empty.body,
    );

    const mintKeep = await call("POST", `/api/v4/dashboards/${sd}/shares`, {
      body: { label: "p14 keep" },
    });
    ok(mintKeep.status === 201, "201", mintKeep);
    const tokenKeep = mintKeep.body?.token as string;
    ok(
      typeof tokenKeep === "string" && tokenKeep.split("-").length === 3,
      "returns a 3-word phrase token",
      mintKeep.body,
    );
    ok(
      mintKeep.body?.label === "p14 keep" &&
        typeof mintKeep.body?.createdAtMs === "number" &&
        mintKeep.body?.expiresAtMs === null &&
        mintKeep.body?.revokedAtMs === null,
      "the 201 body is the PERSISTED row (label/createdAtMs/expiresAtMs/revokedAtMs)",
      mintKeep.body,
    );

    const mintRevoke = await call("POST", `/api/v4/dashboards/${sd}/shares`, {
      body: { label: "p14 revoke", expiresInDays: 30 },
    });
    const tokenRevoke = mintRevoke.body?.token as string;
    ok(
      mintRevoke.status === 201 && !!tokenRevoke,
      "a second token mints",
      mintRevoke,
    );
    ok(
      typeof mintRevoke.body?.expiresAtMs === "number" &&
        Math.abs(mintRevoke.body.expiresAtMs - (Date.now() + 30 * 86_400_000)) <
          60_000,
      "expiresInDays: 30 lands ~30 days out",
      mintRevoke.body,
    );
    // ⚠️ The legacy twin coerced a non-number to `null` — i.e. handed back a link the caller believes
    // expires and which never does. Widening a credential silently is the wrong way to fail.
    const badExpiry = await call("POST", `/api/v4/dashboards/${sd}/shares`, {
      body: { expiresInDays: "7" },
    });
    ok(
      badExpiry.status === 422,
      'expiresInDays: "7" → 422, not a never-expiring link',
      badExpiry,
    );
    const blankLabel = await call("POST", `/api/v4/dashboards/${sd}/shares`, {
      body: { label: "   " },
    });
    ok(blankLabel.status === 422, "a blank label → 422", blankLabel);

    section(
      "GET /api/v4/dashboards/{id}/shares — the ShareLinksPanel contract",
    );
    const listed = await call("GET", `/api/v4/dashboards/${sd}/shares`);
    // 🛑 THE CONTAINER KEY IS `tokens`, NOT `shares` — §9.2 renames the ROUTE, not the payload.
    // `DashboardSettingsDialog`'s `shareApi.list` reads `(await res.json()).tokens ?? []`, so a rename
    // here would render "no share links yet" forever with a 200 and no console error.
    ok(
      Array.isArray(listed.body?.tokens) && listed.body.tokens.length === 2,
      "the container key is `tokens` (NOT `shares`) and both tokens are listed",
      Object.keys(listed.body ?? {}),
    );
    // The exact `ShareTokenRow` key set the panel destructures (components/ShareLinksPanel.tsx).
    ok(
      [
        "token",
        "label",
        "createdAtMs",
        "expiresAtMs",
        "revokedAtMs",
        "lastUsedAtMs",
      ].every((k) => k in (listed.body?.tokens?.[0] ?? {})),
      "each row satisfies `ShareTokenRow` in full — the shape ShareLinksPanel renders",
      listed.body?.tokens?.[0],
    );

    section("PATCH /api/v4/dashboards/{id}/shares — relabel");
    const relabel = await call("PATCH", `/api/v4/dashboards/${sd}/shares`, {
      body: { token: tokenKeep, label: "p14 keep (renamed)" },
    });
    ok(
      relabel.status === 200 && relabel.body?.label === "p14 keep (renamed)",
      "200 with the updated row",
      relabel,
    );
    const afterRelabel = await call("GET", `/api/v4/dashboards/${sd}/shares`);
    ok(
      afterRelabel.body?.tokens?.some(
        (t: any) => t.token === tokenKeep && t.label === "p14 keep (renamed)",
      ),
      "the relabel actually persisted",
      afterRelabel.body,
    );
    const relabelUnknown = await call(
      "PATCH",
      `/api/v4/dashboards/${sd}/shares`,
      {
        body: { token: "no-such-token-here", label: "x" },
      },
    );
    ok(
      relabelUnknown.status === 404,
      "relabelling an unknown token → 404 (the legacy twin answered 200 {ok:false})",
      relabelUnknown,
    );
    const relabelNoToken = await call(
      "PATCH",
      `/api/v4/dashboards/${sd}/shares`,
      {
        body: { label: "x" },
      },
    );
    ok(
      relabelNoToken.status === 422,
      "PATCH with no token → 422",
      relabelNoToken,
    );

    section("ANONYMOUS: a live token reaches the dashboard's data");
    const anonNoToken = await raw("GET", `/api/data?systemId=${handle}`);
    ok(
      anonNoToken.status !== 200,
      "no token, no session → not 200 (the control)",
      anonNoToken.status,
    );
    const anonKeep = await raw(
      "GET",
      `/api/data?systemId=${handle}&access=${tokenKeep}`,
    );
    ok(
      anonKeep.status === 200,
      "token A reaches /api/data anonymously",
      anonKeep.status,
    );
    const anonRevokeBefore = await raw(
      "GET",
      `/api/data?systemId=${handle}&access=${tokenRevoke}`,
    );
    ok(
      anonRevokeBefore.status === 200,
      "token B reaches it too (both live before the revoke)",
      anonRevokeBefore.status,
    );

    section("DELETE /api/v4/dashboards/{id}/shares — revoke exactly one");
    const revoked = await call(
      "DELETE",
      `/api/v4/dashboards/${sd}/shares?token=${encodeURIComponent(tokenRevoke)}`,
    );
    ok(
      revoked.status === 200 && typeof revoked.body?.revokedAtMs === "number",
      "200 with revokedAtMs READ BACK from the row (not asserted by the handler)",
      revoked.body,
    );
    // 🛑 The pair that matters. An over-delete and an under-delete are indistinguishable from the
    // caller's side — only these two together separate them, and only anonymously.
    const anonRevokeAfter = await raw(
      "GET",
      `/api/data?systemId=${handle}&access=${tokenRevoke}`,
    );
    ok(
      anonRevokeAfter.status !== 200,
      "the REVOKED token is refused end-to-end (no under-delete)",
      anonRevokeAfter.status,
    );
    const anonKeepAfter = await raw(
      "GET",
      `/api/data?systemId=${handle}&access=${tokenKeep}`,
    );
    ok(
      anonKeepAfter.status === 200,
      "the OTHER token still resolves (no over-delete)",
      anonKeepAfter.status,
    );
    const revokeAgain = await call(
      "DELETE",
      `/api/v4/dashboards/${sd}/shares?token=${encodeURIComponent(tokenRevoke)}`,
    );
    ok(
      revokeAgain.status === 200 &&
        revokeAgain.body?.revokedAtMs === revoked.body?.revokedAtMs,
      "re-revoking is idempotent and does NOT move revokedAtMs",
      revokeAgain.body,
    );
    const relabelRevoked = await call(
      "PATCH",
      `/api/v4/dashboards/${sd}/shares`,
      {
        body: { token: tokenRevoke, label: "x" },
      },
    );
    ok(
      relabelRevoked.status === 409,
      "relabelling a revoked token → 409 (it exists, but it is not live)",
      relabelRevoked,
    );
    const revokeUnknown = await call(
      "DELETE",
      `/api/v4/dashboards/${sd}/shares?token=no-such-token-here`,
    );
    ok(
      revokeUnknown.status === 404,
      "revoking an unknown token → 404",
      revokeUnknown,
    );
    const revokeNoToken = await call(
      "DELETE",
      `/api/v4/dashboards/${sd}/shares`,
    );
    ok(
      revokeNoToken.status === 422,
      "DELETE with no ?token → 422",
      revokeNoToken,
    );

    section("🛑 SCOPE IS DERIVED LIVE from the doc's envelope refs (§6, §8.3)");
    if (!otherArea) {
      ok(
        false,
        "need a second readable area with a distinct handle to prove this",
        list,
      );
    } else {
      const otherHandle: number = otherArea.legacySystemId;
      const beforeMove = await raw(
        "GET",
        `/api/data?systemId=${otherHandle}&access=${tokenKeep}`,
      );
      ok(
        beforeMove.status !== 200,
        `token A does NOT reach area ${otherArea.id} while the doc does not reference it`,
        beforeMove.status,
      );
      // Re-aim the DOC — the token is untouched, and was minted before this edit.
      const repoint = await call("PUT", `/api/v4/dashboards/${sd}`, {
        body: { doc: docWithArea(otherArea.id) },
      });
      ok(
        repoint.status === 200,
        "the doc is re-pointed at the other area",
        repoint.status,
      );
      const afterMove = await raw(
        "GET",
        `/api/data?systemId=${otherHandle}&access=${tokenKeep}`,
      );
      ok(
        afterMove.status === 200,
        "the SAME token now reaches the new area — scope follows the doc, not the mint",
        afterMove.status,
      );
      const oldAreaAfterMove = await raw(
        "GET",
        `/api/data?systemId=${handle}&access=${tokenKeep}`,
      );
      ok(
        oldAreaAfterMove.status !== 200,
        "…and it no longer reaches the area the doc dropped",
        oldAreaAfterMove.status,
      );
      // Restore, so the grants leg below runs against the original binding.
      await call("PUT", `/api/v4/dashboards/${sd}`, {
        body: { doc: docWithArea(area.id) },
      });
    }

    section(
      "🛑 ANONYMOUS: the management routes are UNREACHABLE (never shareable)",
    );
    for (const [method, path] of [
      ["GET", `/api/v4/dashboards/${sd}/shares`],
      ["POST", `/api/v4/dashboards/${sd}/shares`],
      ["PATCH", `/api/v4/dashboards/${sd}/shares`],
      ["DELETE", `/api/v4/dashboards/${sd}/shares?token=${tokenKeep}`],
      ["GET", `/api/v4/dashboards/${sd}/grants`],
      ["PUT", `/api/v4/dashboards/${sd}/grants`],
    ] as const) {
      const withBody = method === "GET" ? {} : { body: {} };
      const anon = await raw(method, path, withBody);
      ok(
        anon.status === 404 || anon.status === 401,
        `${method} ${path.split("?")[0]} without a session → ${anon.status} (Clerk edge)`,
        anon.status,
      );
      // …and a VALID share token must not buy the way in either. If this ever answers 200, a token
      // has become a self-extending credential: it could mint more tokens or grant a stranger access.
      const withToken = await raw(
        method,
        `${path}${path.includes("?") ? "&" : "?"}access=${tokenKeep}`,
        withBody,
      );
      ok(
        withToken.status === 404 || withToken.status === 401,
        `${method} … with a VALID ?access= token → ${withToken.status} (still refused)`,
        withToken.status,
      );
    }
    const stillLive = await raw(
      "GET",
      `/api/data?systemId=${handle}&access=${tokenKeep}`,
    );
    ok(
      stillLive.status === 200,
      "…and that token is genuinely live — the refusals above are the ROUTE, not a dead token",
      stillLive.status,
    );

    // ================================================================ GRANTS (full replace)
    section(
      "PUT /api/v4/dashboards/{id}/grants — full replace, driven POSITIVELY",
    );
    const ALICE = "user_p14share_alice";
    const BOB = "user_p14share_bob";
    const CARLA = "user_p14share_carla";
    const ownerId = cachedUserId!;

    const noGrantMembers = await call("GET", `/api/v4/dashboards/${sd}/grants`);
    ok(
      noGrantMembers.status === 200 &&
        noGrantMembers.body?.members?.length === 0,
      "a fresh dashboard has no members",
      noGrantMembers.body,
    );

    const two = await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: {
        members: [{ clerkUserId: ALICE }, { clerkUserId: BOB, role: "admin" }],
      },
    });
    ok(two.status === 200, "200", two);
    ok(
      two.body?.changed?.added?.length === 2 &&
        two.body.changed.removed.length === 0,
      "two grantees added",
      two.body?.changed,
    );
    const twoListed = await call("GET", `/api/v4/dashboards/${sd}/grants`);
    ok(
      twoListed.body?.members?.length === 2,
      "…and both are listed",
      twoListed.body,
    );
    const aliceCreatedAt = twoListed.body.members.find(
      (m: any) => m.clerkUserId === ALICE,
    )?.createdAtMs;

    // 🛑 THE CASE THAT PROVES THE DELETE PREDICATE. A replace run against an already-empty table only
    // ever proves the SQL parses. Two grantees; remove ONE; the other must survive untouched.
    const keepOne = await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: { members: [{ clerkUserId: ALICE }] },
    });
    ok(
      JSON.stringify(keepOne.body?.changed?.removed) === JSON.stringify([BOB]),
      "removed names EXACTLY the dropped grantee",
      keepOne.body?.changed,
    );
    const afterKeep = await call("GET", `/api/v4/dashboards/${sd}/grants`);
    ok(
      afterKeep.body?.members?.length === 1 &&
        afterKeep.body.members[0].clerkUserId === ALICE,
      "the KEPT grantee survives and the dropped one is gone (no over/under-delete)",
      afterKeep.body?.members,
    );
    ok(
      afterKeep.body.members[0].createdAtMs === aliceCreatedAt,
      "the kept grantee's createdAtMs is unchanged — updated in place, not deleted + reinserted",
      { was: aliceCreatedAt, now: afterKeep.body.members[0]?.createdAtMs },
    );

    // …and the sideways move: add a third while removing another, plus a role change on the survivor.
    await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: { members: [{ clerkUserId: ALICE }, { clerkUserId: BOB }] },
    });
    const sideways = await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: {
        members: [
          { clerkUserId: ALICE, role: "admin" },
          { clerkUserId: CARLA },
        ],
      },
    });
    ok(
      JSON.stringify(sideways.body?.changed) ===
        JSON.stringify({
          added: [CARLA],
          updated: [ALICE],
          unchanged: [],
          removed: [BOB],
        }),
      "adds a third, removes another, re-roles the survivor — in one PUT",
      sideways.body?.changed,
    );
    const afterSideways = await call("GET", `/api/v4/dashboards/${sd}/grants`);
    ok(
      afterSideways.body?.members
        ?.map((m: any) => m.clerkUserId)
        .sort()
        .join(",") === [ALICE, CARLA].sort().join(","),
      "the listed state matches the declaration exactly",
      afterSideways.body?.members,
    );
    ok(
      afterSideways.body.members.find((m: any) => m.clerkUserId === ALICE)
        ?.role === "admin",
      "the role change landed",
      afterSideways.body?.members,
    );

    section("GET /api/v4/dashboards/{id}/grants — the GrantsPanel contract");
    // The exact `Member` key set `components/GrantsPanel.tsx` destructures. It is also the PUT input
    // shape: the panel restates the current membership by `clerkUserId` + `role` on every write, so a
    // missing `clerkUserId` here would make every add silently re-declare an empty membership.
    ok(
      ["clerkUserId", "role", "email", "name", "createdAtMs"].every(
        (k) => k in (afterSideways.body?.members?.[0] ?? {}),
      ),
      "each member is { clerkUserId, role, email, name, createdAtMs } — INCLUDING the Clerk decoration",
      afterSideways.body?.members?.[0],
    );
    ok(
      "email" in (afterSideways.body?.members?.[0] ?? {}) &&
        "name" in (afterSideways.body?.members?.[0] ?? {}),
      "email/name are present (null here — these scratch ids are not real Clerk users, and the row is KEPT)",
      afterSideways.body?.members?.[0],
    );

    section("PUT …/grants — the rejection paths (all-or-nothing)");
    const noKey = await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: {},
    });
    ok(
      noKey.status === 422 &&
        noKey.body?.errors?.[0]?.code === "members-required",
      "a MISSING members key → 422, never an accidental remove-everyone",
      noKey,
    );
    const ghost = await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: {
        members: [
          { clerkUserId: ALICE },
          { email: "p14-share-ghost@example.invalid" },
        ],
      },
    });
    ok(
      ghost.status === 422 &&
        ghost.body?.errors?.[0]?.code === "user-not-found",
      "one unresolvable invitee rejects the WHOLE replace",
      ghost,
    );
    const ownerGrant = await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: { members: [{ clerkUserId: ownerId }] },
    });
    ok(
      ownerGrant.status === 422 &&
        ownerGrant.body?.errors?.[0]?.code === "owner-already-has-full-access",
      "the owner cannot be granted their own dashboard",
      ownerGrant,
    );
    const dupGrant = await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: { members: [{ clerkUserId: ALICE }, { clerkUserId: ALICE }] },
    });
    ok(
      dupGrant.status === 422 &&
        dupGrant.body?.errors?.[0]?.code === "duplicate-member",
      "a duplicate grantee → 422, not a silent collapse",
      dupGrant,
    );
    const survived = await call("GET", `/api/v4/dashboards/${sd}/grants`);
    ok(
      survived.body?.members?.length === 2,
      "none of the four rejections changed the membership",
      survived.body?.members,
    );

    const wipe = await call("PUT", `/api/v4/dashboards/${sd}/grants`, {
      body: { members: [] },
    });
    ok(
      wipe.status === 200 && wipe.body?.changed?.removed?.length === 2,
      "[] removes everyone — the declarative contract",
      wipe.body?.changed,
    );
    ok(
      (await call("GET", `/api/v4/dashboards/${sd}/grants`)).body?.members
        ?.length === 0,
      "…and the membership is empty",
    );

    section("shares/grants — unknown dashboard, and not-yours");
    for (const path of ["shares", "grants"]) {
      const unknown = await call(
        "GET",
        `/api/v4/dashboards/${UNKNOWN_DASHBOARD}/${path}`,
      );
      ok(
        unknown.status === 404,
        `GET …/${UNKNOWN_DASHBOARD}/${path} → 404`,
        unknown,
      );
      const malformed = await call(
        "GET",
        `/api/v4/dashboards/not-a-typeid/${path}`,
      );
      ok(
        malformed.status === 404,
        `GET …/not-a-typeid/${path} → 404 (a malformed id reads as not-found)`,
        malformed,
      );
    }

    // ---------------------------------------------------------------- 13. DELETE
    section("DELETE /api/v4/dashboards/{id}");
    const del = await call("DELETE", `/api/v4/dashboards/${created}`);
    ok(
      del.status === 200 && del.body?.success === true,
      "200 { success }",
      del,
    );
    scratch.delete(created);
    const delAgain = await call("DELETE", `/api/v4/dashboards/${created}`);
    ok(delAgain.status === 404, "deleting it again → 404", delAgain);

    // ================================================================= THE ORPHAN READS (stage 12)
    //
    // 🛑 RESTORED IN STAGE 13, having been silently LOST. Stage 12 landed four sections here — the
    // `by-handle`, `provenance-summary` and `provenance-daily` route-matcher proofs, plus the
    // anonymous share-token leg — and the #317 rebase dropped all of them along with the call site of
    // `driveSharedProvenanceDaily` (whose *definition* survived, so nothing looked wrong). Nothing
    // noticed for three merges, because this file is checked by no gate at all: `tsconfig.json`
    // excludes `scripts/`, and no test imported it. `scripts/__tests__/smoke-driver-parses.test.ts`
    // is now the floor under that. See its header for the full bisect.
    //
    // Their oracle used to be the legacy twin, key-by-key. That twin is deleted, so each check is now
    // stated directly — and the ONES THAT MATTER MOST are unchanged either way, because they were
    // never comparisons: they are the `lib/route-matchers.ts` proofs, and they turn on the difference
    // between a 401 FROM THE HANDLER and a 404 FROM THE EDGE. A logged-in tester sees 200 both ways.

    // --------------------------------------------------------------- 14. by-handle
    section("GET /api/v4/areas/by-handle/{handle}");
    const v4ByHandle = await call("GET", `/api/v4/areas/by-handle/${handle}`);
    ok(v4ByHandle.status === 200, "200", v4ByHandle);
    ok(
      v4ByHandle.body?.areaId === area.id,
      "resolves to the ar_ TypeID we started from",
      v4ByHandle.body,
    );
    ok(
      (await call("GET", "/api/v4/areas/by-handle/not-a-number")).status ===
        400,
      "non-integer handle → 400",
    );
    ok(
      (await call("GET", "/api/v4/areas/by-handle/987654321")).status === 404,
      "unknown handle → 404",
    );
    // 🛑 THE ROUTE-MATCHER PROOF for publicRoutes. Anonymous must reach the HANDLER (401), not the
    // edge (404). Without the `publicRoutes` entry this is a 404 — and a logged-in tester never sees it.
    ok(
      (
        await request("GET", `/api/v4/areas/by-handle/${handle}`, {
          as: "anon",
        })
      ).status === 401,
      "anonymous → 401 from the HANDLER, not 404 from the edge (publicRoutes entry present)",
    );

    // --------------------------------------------------------------- 15. provenance-summary
    section("GET /api/v4/areas/{id}/provenance-summary");
    const summary = await call(
      "GET",
      `/api/v4/areas/${area.id}/provenance-summary?last=30d`,
    );
    ok(summary.status === 200, "200", summary);
    ok(
      (await call("GET", `/api/v4/areas/${area.id}/provenance-summary?last=0d`))
        .status === 400,
      "malformed date params → 400",
    );
    ok(
      (await call("GET", "/api/v4/areas/not-a-typeid/provenance-summary"))
        .status === 400,
      "malformed area id → 400",
    );
    ok(
      (await call("GET", `/api/v4/areas/${UNKNOWN_AREA}/provenance-summary`))
        .status === 404,
      "unknown area id → 404 (this gate is cron-reachable, so it cannot use the readable-set 403)",
    );
    ok(
      (
        await request("GET", `/api/v4/areas/${area.id}/provenance-summary`, {
          as: "anon",
        })
      ).status === 401,
      "anonymous → 401 from the HANDLER, not 404 from the edge (publicRoutes entry present)",
    );
    if (process.env.CRON_SECRET) {
      ok(
        (
          await request(
            "GET",
            `/api/v4/areas/${area.id}/provenance-summary?last=30d`,
            { as: "cron" },
          )
        ).status === 200,
        "CRON_SECRET bearer → 200 (headless ops, no Clerk session)",
      );
      ok(
        (
          await request("GET", `/api/v4/areas/by-handle/${handle}`, {
            as: "cron",
          })
        ).status === 200,
        "CRON_SECRET bearer reaches by-handle too",
      );
    } else {
      skip("the CRON_SECRET leg", "CRON_SECRET is not set in this environment");
    }

    // --------------------------------------------------------------- 16. provenance-daily
    // The read path `lib/queries/provenanceDaily.ts` moved onto in this stage.
    section("GET /api/v4/areas/{id}/provenance-daily");
    const daily = await call(
      "GET",
      `/api/v4/areas/${area.id}/provenance-daily?last=7d`,
    );
    ok(daily.status === 200, "200", daily.status);
    ok(
      Array.isArray(daily.body?.days) &&
        Object.values(daily.body?.fields ?? {}).every(
          (col: any) => col.length === daily.body.days.length,
        ),
      "every field column is parallel to `days` (the dense-columnar invariant)",
      { days: daily.body?.days?.length },
    );
    ok(
      (await call("GET", `/api/v4/areas/${area.id}/provenance-daily?last=x`))
        .status === 400,
      "malformed date params → 400",
    );
    // 🛑 THE ROUTE-MATCHER PROOF for shareableRoutes. An anonymous request carrying `?access=` must
    // reach the HANDLER. Without the entry the edge 404s it — invisible to every logged-in tester,
    // broken for every anonymous shared-dashboard viewer, and now the ONLY entry standing (its legacy
    // sibling went with the route in this stage).
    const garbageToken = await request(
      "GET",
      `/api/v4/areas/${area.id}/provenance-daily?access=not-a-real-token`,
      { as: "anon" },
    );
    ok(
      garbageToken.status !== 404,
      "anonymous ?access= reaches the handler (NOT 404 at the edge) — shareableRoutes entry present",
      garbageToken.status,
    );
    ok(
      garbageToken.status === 401 || garbageToken.status === 403,
      "…and a garbage token is then rejected by the handler",
      garbageToken,
    );
    ok(
      (
        await request("GET", `/api/v4/areas/${area.id}/provenance-daily`, {
          as: "anon",
        })
      ).status === 404,
      "anonymous WITHOUT ?access= is still 404'd at the edge (the bypass is token-presence-gated)",
    );
    // …and the real thing: a live share token, no Clerk session at all.
    await driveSharedProvenanceDaily(list);

    // ---------------------------------------------------------------- 17. the legacy trees are GONE
    await assertLegacyTreesDeleted(area.id);

    // ==================================================================
  } finally {
    await trash();
    const swept = await sweepScratchAreas();
    console.log(
      `\ncleaned up scratch dashboards, and hard-deleted ${swept} scratch area(s)`,
    );
  }

  console.log(
    `\n${failures === 0 ? "✓ PASS" : "✗ FAIL"} — ${checks - failures}/${checks} checks`,
  );
  if (failures > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
