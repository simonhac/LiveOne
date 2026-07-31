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
 * SAFE TO RE-RUN. It creates only its own scratch dashboards (name prefixed `v4-smoke ·`), deletes them
 * in a `finally`, AND sweeps any left behind by a previous crashed run before it starts. It never
 * mutates an area, a device or a pre-existing dashboard. Modelled on `verify-areas-drift-key.ts`.
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

const BASE = process.env.V4_SMOKE_BASE ?? "http://localhost:3001";
const SCRATCH_PREFIX = "v4-smoke ·";
const SCRATCH_SLUG = `v4-smoke-${Math.random().toString(36).slice(2, 8)}`;

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
      "GET /api/v4/dashboards/{id}/shares — key-by-key vs the legacy twin",
    );
    const listed = await call("GET", `/api/v4/dashboards/${sd}/shares`);
    ok(
      listed.body?.tokens?.length === 2,
      "both tokens are listed",
      listed.body,
    );
    const legacyShares = await call("GET", `/api/dashboards/${sd}/share`);
    const legacyKeys = Object.keys(legacyShares.body?.tokens?.[0] ?? {});
    const missingKeys = legacyKeys.filter(
      (k) => !(k in (listed.body?.tokens?.[0] ?? {})),
    );
    ok(
      legacyKeys.length > 0 && missingKeys.length === 0,
      "carries every field GET /api/dashboards/{id}/share does (no silent narrowing)",
      { missingKeys, legacyKeys },
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

    const noMembers = await call("GET", `/api/v4/dashboards/${sd}/grants`);
    ok(
      noMembers.status === 200 && noMembers.body?.members?.length === 0,
      "a fresh dashboard has no members",
      noMembers.body,
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

    section(
      "GET /api/v4/dashboards/{id}/grants — key-by-key vs the legacy twin",
    );
    const legacyGrants = await call("GET", `/api/dashboards/${sd}/grants`);
    const legacyMemberKeys = Object.keys(legacyGrants.body?.members?.[0] ?? {});
    const missingMemberKeys = legacyMemberKeys.filter(
      (k) => !(k in (afterSideways.body?.members?.[0] ?? {})),
    );
    ok(
      legacyMemberKeys.length > 0 && missingMemberKeys.length === 0,
      "carries every field GET /api/dashboards/{id}/grants does — INCLUDING the Clerk decoration",
      { missingMemberKeys, legacyMemberKeys },
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

    // ==================================================================  } finally {
    await trash();
    console.log("\ncleaned up scratch dashboards");
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
