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
import { createClerkClient } from "@clerk/nextjs/server";

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

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const jwt = await mintJwt();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
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
  } finally {
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
