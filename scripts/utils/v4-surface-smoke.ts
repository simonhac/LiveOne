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

/**
 * The assertion this file exists for. Compare a v4 payload against its legacy twin KEY BY KEY and
 * VALUE BY VALUE, with every rename spelled out. A dropped field is a defect (STEP 0's D2: the
 * dashboard renders permanent skeletons, no error anywhere); a rename must be declared, so a field
 * that quietly changes name shows up as "dropped" here rather than passing unnoticed.
 */
function compareKeyByKey(
  label: string,
  legacy: Record<string, unknown>,
  v4: Record<string, unknown>,
  opts: { rename?: Record<string, string>; valueMayDiffer?: string[] } = {},
): void {
  const rename = opts.rename ?? {};
  const mayDiffer = new Set(opts.valueMayDiffer ?? []);
  const dropped: string[] = [];
  const changed: { key: string; legacy: unknown; v4: unknown }[] = [];
  for (const k of Object.keys(legacy)) {
    const target = rename[k] ?? k;
    if (!(target in v4)) {
      dropped.push(`${k}${target === k ? "" : ` (→ ${target})`}`);
      continue;
    }
    if (!mayDiffer.has(k) && !isDeepStrictEqual(legacy[k], v4[target]))
      changed.push({ key: k, legacy: legacy[k], v4: v4[target] });
  }
  ok(
    Object.keys(legacy).length > 0 &&
      dropped.length === 0 &&
      changed.length === 0,
    `${label}: carries every legacy key, same values (no silent narrowing)`,
    { dropped, changed, legacyKeys: Object.keys(legacy) },
  );
}

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
      const path = `/api/areas/${a.id}/provenance-daily?last=3d&access=${token}`;
      const legacy = await request("GET", path, { as: "anon" });
      if (legacy.status !== 200) continue;
      console.log(`  using token …${token.slice(-6)} on ${a.displayName}`);
      const v4 = await request(
        "GET",
        `/api/v4/areas/${a.id}/provenance-daily?last=3d&access=${token}`,
        { as: "anon" },
      );
      // 404 here is EXACTLY the missing-`shareableRoutes`-entry failure, and it is why this check is
      // worth the DB read: it is invisible to every other assertion in this file.
      ok(
        v4.status !== 404,
        "an anonymous share-token viewer reaches the v4 route (not 404'd at the Clerk edge)",
        v4.status,
      );
      ok(v4.status === 200, "…and is authorized by the handler", v4.status);
      ok(
        isDeepStrictEqual(v4.body, legacy.body),
        "…and gets a payload identical to the legacy twin's",
        {
          v4: Object.keys(v4.body ?? {}),
          legacy: Object.keys(legacy.body ?? {}),
        },
      );
      // The token must not become a skeleton key: another area outside the dashboard's scope stays shut.
      const other = areas.find((o) => o.id !== a.id);
      if (other) {
        const escalate = await request(
          "GET",
          `/api/v4/areas/${other.id}/provenance-daily?last=3d&access=${token}`,
          { as: "anon" },
        );
        const legacyEscalate = await request(
          "GET",
          `/api/areas/${other.id}/provenance-daily?last=3d&access=${token}`,
          { as: "anon" },
        );
        ok(
          escalate.status === legacyEscalate.status,
          "an out-of-scope area answers the token exactly as the legacy twin does (no widened scope)",
          { v4: escalate.status, legacy: legacyEscalate.status },
        );
      }
      return;
    }
  }
  skip(
    "the share-token leg",
    "no (token, area) pair is authorized even on the LEGACY route — nothing to compare against",
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
    const legacyTwin = await call("GET", "/api/areas/readable");
    const twinKeys = Object.keys(legacyTwin.body?.areas?.[0] ?? {});
    const narrowed = twinKeys.filter((k) => !(k in (list[0] ?? {})));
    ok(
      twinKeys.length > 0 && narrowed.length === 0,
      "carries every field GET /api/areas/readable does (no silent narrowing)",
      { narrowed, twinKeys },
    );
    // Prefer a chart-capable area: it exercises the richest seed strategy.
    const area = list.find((a: any) => a.chartCapable) ?? list[0];
    if (!area) throw new Error("no readable areas — cannot continue");
    console.log(`  using area ${area.id} (${area.displayName})`);

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

    // The key-by-key diff against the legacy twin, on a real second creation.
    const legacyCreated = await call("POST", "/api/areas", {
      body: {
        displayName: `${AREA_PREFIX} legacy-twin`,
        memberSystemIds: [handleA, handleB],
      },
    });
    ok(legacyCreated.status === 200, "legacy POST /api/areas still works", {
      status: legacyCreated.status,
    });
    ok(
      missingKeys(createdArea.body, legacyCreated.body).length === 0,
      "the v4 create echoes every key the legacy twin does (no silent narrowing)",
      { missing: missingKeys(createdArea.body, legacyCreated.body) },
    );

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
    // The legacy twin, driven on the same area, for the key diff. It returns the editor projection
    // (role/metricType/pointId/transform); v4 must carry all of it plus `id` and `priority`.
    const legacyBindings = await call("PUT", `/api/areas/${areaId}/bindings`, {
      body: { bindings: wantBindings },
    });
    ok(
      legacyBindings.status === 200,
      "legacy PUT bindings still works",
      legacyBindings.status,
    );
    ok(
      missingKeys(
        putBindings.body.bindings[0],
        legacyBindings.body?.bindings?.[0],
      ).length === 0,
      "the v4 bindings PUT echoes every key the legacy twin does",
      {
        missing: missingKeys(
          putBindings.body.bindings[0],
          legacyBindings.body?.bindings?.[0],
        ),
      },
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
    // The legacy twins still work on the same area — PR 13 has not moved them yet.
    const legacyAddRemove = await call(
      "DELETE",
      `/api/areas/${areaId}/devices`,
      { body: { systemId: handleB } },
    );
    ok(
      legacyAddRemove.status === 200 && legacyAddRemove.body?.ok === true,
      "legacy DELETE /devices still works and still answers { ok: true }",
      legacyAddRemove,
    );
    await call("PUT", `/api/v4/areas/${areaId}/members`, {
      body: { members: [fixture.deviceA, fixture.deviceB] },
    });

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
    const legacyRecompute = await call(
      "POST",
      `/api/areas/${area.id}/recompute-provenance`,
      { body: { start: day, end: day, cursor: day, limit: 1 } },
    );
    ok(
      missingKeys(recompute.body, legacyRecompute.body).length === 0,
      "the v4 recompute echoes every key the legacy twin does (one shared implementation)",
      { missing: missingKeys(recompute.body, legacyRecompute.body) },
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

    // =========================================================================
    // config-v4 Phase 14 stage 12 — the four orphan legacy reads and their v4 twins.
    // Every one of these is compared against the legacy route it replaces, on the SAME database, in
    // the SAME run. That is the only check that can see a narrowed payload.
    // =========================================================================

    // --------------------------------------------------------------- 14. GET /v4/devices
    section("GET /api/v4/devices — the candidate-devices twin");
    const v4Devices = await call("GET", "/api/v4/devices");
    const legacyCandidates = await call("GET", "/api/areas/candidate-devices");
    ok(v4Devices.status === 200, "200", v4Devices.status);
    ok(
      legacyCandidates.status === 200,
      "legacy twin also 200 (the oracle is live)",
      legacyCandidates.status,
    );
    const v4Devs: any[] = v4Devices.body?.devices ?? [];
    const legacyDevs: any[] = legacyCandidates.body?.devices ?? [];
    ok(
      v4Devs.length > 0 && v4Devs.length === legacyDevs.length,
      "same device COUNT as the legacy twin (same visible set)",
      { v4: v4Devs.length, legacy: legacyDevs.length },
    );
    ok(
      v4Devs.every((d) => typeof d.id === "string" && d.id.startsWith("dv_")),
      "every device id is a dv_ TypeID",
      v4Devs[0],
    );
    // Key-by-key, every device, with the rename map written out. `id` is the ONE key whose value
    // legitimately differs (int → TypeID) — and it is not dropped: it is carried as `legacySystemId`.
    const DEVICE_RENAMES = {
      id: "legacySystemId",
      displayName: "name",
      vendorType: "vendor",
      alias: "slug",
      ownerClerkUserId: "ownerUserId",
    };
    for (const legacyDev of legacyDevs) {
      const twin = v4Devs.find((d) => d.legacySystemId === legacyDev.id);
      if (!twin) {
        ok(false, `v4 has no device for legacy id ${legacyDev.id}`, legacyDev);
        continue;
      }
      compareKeyByKey(
        `device ${legacyDev.id} (${legacyDev.displayName})`,
        legacyDev,
        twin,
        { rename: DEVICE_RENAMES },
      );
    }
    // A Clerk-gated route with NO route-matcher entry: anonymous is 404'd at the edge. This is the
    // control for the two 401 assertions below — it shows what a MISSING matcher entry looks like.
    const anonDevices = await request("GET", "/api/v4/devices", { as: "anon" });
    ok(
      anonDevices.status === 404,
      "anonymous → 404 at the Clerk edge (no matcher entry, and none wanted)",
      anonDevices.status,
    );

    // --------------------------------------------------------------- 15. by-handle
    section("GET /api/v4/areas/by-handle/{handle}");
    const handle = area.legacySystemId;
    const v4ByHandle = await call("GET", `/api/v4/areas/by-handle/${handle}`);
    const legacyByHandle = await call("GET", `/api/areas/by-handle/${handle}`);
    ok(v4ByHandle.status === 200, "200", v4ByHandle);
    compareKeyByKey(
      `by-handle/${handle}`,
      legacyByHandle.body ?? {},
      v4ByHandle.body ?? {},
    );
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
    const anonByHandle = await request(
      "GET",
      `/api/v4/areas/by-handle/${handle}`,
      { as: "anon" },
    );
    ok(
      anonByHandle.status === 401,
      "anonymous → 401 from the HANDLER, not 404 from the edge (publicRoutes entry present)",
      anonByHandle,
    );

    // --------------------------------------------------------------- 16. provenance-summary
    section("GET /api/v4/areas/{id}/provenance-summary");
    const SUMMARY_Q = "?last=30d";
    const v4Summary = await call(
      "GET",
      `/api/v4/areas/${area.id}/provenance-summary${SUMMARY_Q}`,
    );
    const legacySummary = await call(
      "GET",
      `/api/areas/${area.id}/provenance-summary${SUMMARY_Q}`,
    );
    ok(v4Summary.status === 200, "200", v4Summary);
    compareKeyByKey(
      "provenance-summary",
      legacySummary.body ?? {},
      v4Summary.body ?? {},
    );
    ok(
      isDeepStrictEqual(v4Summary.body, legacySummary.body),
      "payload is IDENTICAL to the legacy twin's (two independent implementations agree)",
      { v4: v4Summary.body, legacy: legacySummary.body },
    );
    ok(
      (await call("GET", `/api/v4/areas/${area.id}/provenance-summary?last=0d`))
        .status === 400,
      "malformed date params → 400",
    );
    ok(
      (await call("GET", `/api/v4/areas/not-a-typeid/provenance-summary`))
        .status === 400,
      "malformed area id → 400",
    );
    ok(
      (await call("GET", `/api/v4/areas/${UNKNOWN_AREA}/provenance-summary`))
        .status === 404,
      "unknown area id → 404 (this gate is cron-reachable, so it cannot use the readable-set 403)",
    );
    const anonSummary = await request(
      "GET",
      `/api/v4/areas/${area.id}/provenance-summary`,
      { as: "anon" },
    );
    ok(
      anonSummary.status === 401,
      "anonymous → 401 from the HANDLER, not 404 from the edge (publicRoutes entry present)",
      anonSummary,
    );
    if (process.env.CRON_SECRET) {
      const cronSummary = await request(
        "GET",
        `/api/v4/areas/${area.id}/provenance-summary${SUMMARY_Q}`,
        { as: "cron" },
      );
      ok(
        cronSummary.status === 200,
        "CRON_SECRET bearer → 200 (headless ops, no Clerk session)",
        cronSummary.status,
      );
      const cronByHandle = await request(
        "GET",
        `/api/v4/areas/by-handle/${handle}`,
        { as: "cron" },
      );
      ok(
        cronByHandle.status === 200,
        "CRON_SECRET bearer reaches by-handle too",
        cronByHandle.status,
      );
    } else {
      skip("the CRON_SECRET leg", "CRON_SECRET is not set in this environment");
    }

    // --------------------------------------------------------------- 17. provenance-daily
    section("GET /api/v4/areas/{id}/provenance-daily");
    const DAILY_Q = "?last=7d";
    const v4Daily = await call(
      "GET",
      `/api/v4/areas/${area.id}/provenance-daily${DAILY_Q}`,
    );
    const legacyDaily = await call(
      "GET",
      `/api/areas/${area.id}/provenance-daily${DAILY_Q}`,
    );
    ok(v4Daily.status === 200, "200", v4Daily.status);
    compareKeyByKey(
      "provenance-daily",
      legacyDaily.body ?? {},
      v4Daily.body ?? {},
    );
    ok(
      isDeepStrictEqual(v4Daily.body, legacyDaily.body),
      "payload is IDENTICAL to the legacy twin's — the same ProvenanceDailyResponse its client imports",
      { v4Keys: Object.keys(v4Daily.body ?? {}) },
    );
    ok(
      Array.isArray(v4Daily.body?.days) &&
        Object.values(v4Daily.body?.fields ?? {}).every(
          (col: any) => col.length === v4Daily.body.days.length,
        ),
      "every field column is parallel to `days` (the dense-columnar invariant)",
      { days: v4Daily.body?.days?.length },
    );
    ok(
      (await call("GET", `/api/v4/areas/${area.id}/provenance-daily?last=x`))
        .status === 400,
      "malformed date params → 400",
    );

    // 🛑 THE ROUTE-MATCHER PROOF for shareableRoutes — the trap this whole PR was warned about.
    // An anonymous request carrying a ?access= token must reach the HANDLER. Without the
    // `shareableRoutes` entry the edge 404s it — invisible to every logged-in tester, and broken for
    // every anonymous shared-dashboard viewer.
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
    const noToken = await request(
      "GET",
      `/api/v4/areas/${area.id}/provenance-daily`,
      { as: "anon" },
    );
    ok(
      noToken.status === 404,
      "anonymous WITHOUT ?access= is still 404'd at the edge (the bypass is token-presence-gated)",
      noToken.status,
    );

    // …and now the real thing: a live share token, no Clerk session at all. The LEGACY route is the
    // oracle for which (token, area) pair is authorized; the v4 twin must then match it exactly.
    await driveSharedProvenanceDaily(list);
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
