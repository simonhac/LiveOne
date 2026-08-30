/**
 * The edge boundary for CLI tokens.
 *
 * `middleware.ts` lets a request carrying `Authorization: Bearer lo_cli_…` PAST `auth.protect()` on
 * a bounded set of routes, because protect() rewrites an unauthenticated /api request to a 404
 * before the handler can look at a credential it would understand. That bypass is presence-only:
 * the handler's `requireAuth` is the single enforcement point.
 *
 * These are the invariants that keep "let it past the edge" from becoming "let it in". Each names
 * what it forecloses; if one of them ever needs relaxing, that is a security decision, not a test
 * fix.
 */
import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import {
  isPublicRoute,
  isShareableRoute,
  isCliTokenRoute,
  hasCliBearer,
  cliBearerToken,
} from "../route-matchers";

// createRouteMatcher reads the URL; hasCliBearer reads the headers. One fake satisfies both,
// typed loosely because the matchers take a NextRequest and we deliberately avoid the Edge runtime.
const req = (path: string, headers: Record<string, string> = {}): any => {
  const url = `https://liveone.energy${path}`;
  return {
    url,
    nextUrl: new URL(url),
    method: "GET",
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  };
};

const withAuth = (v: string) => req("/api/v4/dashboards", { authorization: v });

describe("isCliTokenRoute — what the bypass is bounded to", () => {
  it("covers the dashboard surface, the read routes, and the CLI's own token management", () => {
    for (const p of [
      "/api/v4/dashboards",
      "/api/v4/dashboards/db_01kyf18tp3e5brm474zf0fzvkm",
      "/api/v4/dashboards/db_x/grants",
      // The operator-CLI read surface: devices/areas/users aggregates plus the card-data reads.
      "/api/v4/devices",
      "/api/v4/devices/dv_x",
      "/api/v4/areas",
      "/api/v4/areas/ar_x",
      "/api/v4/areas/ar_x/derivations",
      "/api/v4/users",
      "/api/v4/users/user_x",
      "/api/data",
      "/api/history",
      "/api/cli-auth/tokens",
      "/api/cli-auth/tokens/cli_abc",
      "/api/cli-auth/whoami",
    ])
      expect(isCliTokenRoute(req(p))).toBe(true);
  });

  it("does NOT cover admin, control, vendor, cron or page routes", () => {
    // A CLI credential is a real user credential, so widening this list is a real decision. These
    // are the surfaces a stray or stolen token must not reach at the edge.
    for (const p of [
      "/api/admin/storage",
      "/api/admin/users",
      "/api/admin/devices/1/config",
      "/api/control/command",
      "/api/auth/tesla/callback",
      "/api/cron/db-stats",
      "/api/device/1/latest",
      // The areas matcher is a single named segment (`:id`), NOT `(.*)` — the sub-resources and the
      // control surface stay outside the bypass, each to be judged on its own.
      "/api/v4/areas/ar_x/members",
      "/api/v4/areas/ar_x/bindings",
      // `derivations` itself is bypassed, but its per-derivation control route is not.
      "/api/v4/areas/ar_x/derivations/dx_x",
      "/api/v4/points/pt_x/action",
      "/dashboard/simon/kink",
      "/",
      // 🛑 A CLI token must not be able to mint its own successor: `authorize` is what binds a code
      // to a user, so it requires a real browser session and is NOT reachable with a token.
      "/api/cli-auth/authorize",
    ])
      expect(isCliTokenRoute(req(p))).toBe(false);
  });

  it("keeps the dashboard surface OUT of publicRoutes and shareableRoutes", () => {
    // A guard against "fixing" a CLI 404 by making the route public — which would hand every
    // unauthenticated request straight to the handler, and (for shareable) let a share token reach
    // dashboard CRUD, a self-extending credential.
    expect(isPublicRoute(req("/api/v4/dashboards"))).toBe(false);
    expect(isPublicRoute(req("/api/v4/dashboards/db_x"))).toBe(false);
    expect(isShareableRoute(req("/api/v4/dashboards"))).toBe(false);
    expect(isPublicRoute(req("/api/cli-auth/tokens"))).toBe(false);
    // `authorize` is the session-bound half of the hand-off — public would defeat the entire flow.
    expect(isPublicRoute(req("/api/cli-auth/authorize"))).toBe(false);
    // `exchange` IS public: it authenticates on the signed code plus the PKCE verifier.
    expect(isPublicRoute(req("/api/cli-auth/exchange"))).toBe(true);
    // …but public must not also mean CLI-token-eligible, or the bypass would be pointless there.
    expect(isCliTokenRoute(req("/api/cli-auth/exchange"))).toBe(false);
  });
});

describe("cliBearerToken — what counts as presenting a CLI token", () => {
  it("extracts the token, tolerating scheme case and extra spacing", () => {
    expect(cliBearerToken(withAuth("Bearer lo_cli_abc_def"))).toBe(
      "lo_cli_abc_def",
    );
    expect(cliBearerToken(withAuth("bearer lo_cli_abc_def"))).toBe(
      "lo_cli_abc_def",
    );
    expect(cliBearerToken(withAuth("BEARER    lo_cli_abc_def"))).toBe(
      "lo_cli_abc_def",
    );
    // A naive header.slice(7) would return "  lo_cli_abc_def" for the third case and fail to
    // verify — which is why extraction lives in one place.
  });

  it("is false for every OTHER credential this app accepts", () => {
    // Each of these is a real credential elsewhere in the codebase; none may take the CLI path.
    for (const v of [
      "Bearer eyJhbGciOiJSUzI1NiJ9.abc.def", // a Clerk session JWT
      "Bearer gk_someGusherKey", // a gusher push key
      "Bearer some-cron-secret", // CRON_SECRET
      "Basic bG86Y2xp", // not bearer at all
      "Bearerlo_cli_x", // no separator — not a bearer credential
      "Bearer notlo_cli_x", // prefix must be at the start
      "",
    ])
      expect(hasCliBearer(withAuth(v))).toBe(false);
    expect(hasCliBearer(req("/api/v4/dashboards"))).toBe(false); // no header at all
  });

  it("recognises a garbage token — presence, not validity, is the edge's question", () => {
    // This is the point of the design: the edge lets it THROUGH so the handler can reject it with
    // a 401. The corresponding "…and the handler does reject it" half is covered by the
    // getAuthContext tests.
    expect(hasCliBearer(withAuth("Bearer lo_cli_garbage"))).toBe(true);
  });
});

describe("the bypass condition, as middleware composes it", () => {
  // middleware.ts itself cannot be imported without the Edge runtime, so reproduce its expression
  // exactly. If the middleware changes, this must change with it — deliberately duplicated so the
  // composition is asserted somewhere.
  const bypasses = (path: string, auth?: string) =>
    isCliTokenRoute(req(path, auth ? { authorization: auth } : {})) &&
    hasCliBearer(req(path, auth ? { authorization: auth } : {}));

  it("requires BOTH an eligible route and a CLI bearer", () => {
    expect(bypasses("/api/v4/dashboards", "Bearer lo_cli_x_y")).toBe(true);
    // Right credential, wrong route: still gated at the edge.
    expect(bypasses("/api/admin/storage", "Bearer lo_cli_x_y")).toBe(false);
    // Right route, no credential: still gated at the edge.
    expect(bypasses("/api/v4/dashboards")).toBe(false);
    // Right route, someone else's credential: still gated.
    expect(bypasses("/api/v4/dashboards", "Bearer gk_x")).toBe(false);
  });
});

describe("every route the bypass exposes authorizes for itself", () => {
  // 🛑 THE STRUCTURAL INVARIANT. The edge bypass is presence-only, so a route under
  // isCliTokenRoute that forgets to authorize is reachable by ANY caller who sends a `lo_cli_`
  // string — no valid token needed, because nothing would ever check it. A new sibling route
  // inherits the bypass automatically; this is what stops it inheriting it silently.
  //
  // The set is derived by asking isCliTokenRoute itself, not from a directory list, so widening the
  // matcher automatically widens this check. (A directory list got this wrong first time: it swept
  // in /api/cli-auth/exchange, which is deliberately public and self-authenticating rather than
  // session-authorized, and is NOT under the bypass.)
  const AUTH_CALLS = [
    "loadOwnedDashboard",
    "requireAuth",
    "requireAdmin",
    "requireDashboardAccess",
    // The `/api/v4/areas/{id}` loader (lib/areas/http.ts): it WRAPS requireAuth and then resolves
    // the id within the caller's readable set, so it is an authorization call, not a shortcut past
    // one. Exactly this one widening — a new wrapper does not belong here until it provably calls
    // requireAuth on every path.
    "loadReadableArea",
    // The owner-scoped sibling (same file): requireAuth then owner-or-admin on the resolved area.
    // Needed by `/api/v4/areas/{id}/derivations`, whose GET and POST both use it.
    "loadAreaForOwner",
  ];

  /** Every route.ts under app/api, with the URL path it serves. */
  const routes = (): Array<{ file: string; urlPath: string }> => {
    const out: Array<{ file: string; urlPath: string }> = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "route.ts")
          out.push({
            file: p,
            // app/api/x/[id]/route.ts -> /api/x/placeholder
            urlPath:
              "/" +
              path
                .dirname(p)
                .replace(/^app\//, "")
                .replace(/\[[^\]]+\]/g, "placeholder"),
          });
      }
    };
    walk("app/api");
    return out;
  };

  const exposed = routes().filter((r) => isCliTokenRoute(req(r.urlPath)));

  it("finds the exposed routes (so the check cannot silently cover nothing)", () => {
    // The dashboard surface, the devices/areas/users read surface, the card-data reads, plus the
    // CLI's own token management and whoami.
    expect(exposed.length).toBeGreaterThanOrEqual(15);
    expect(exposed.map((r) => r.file)).toEqual(
      expect.arrayContaining([
        "app/api/v4/dashboards/route.ts",
        "app/api/v4/devices/[id]/route.ts",
        "app/api/v4/areas/[id]/route.ts",
        "app/api/v4/areas/[id]/derivations/route.ts",
        "app/api/v4/users/[id]/route.ts",
        "app/api/data/route.ts",
        "app/api/history/route.ts",
        "app/api/cli-auth/whoami/route.ts",
      ]),
    );
  });

  it("has an authorization call in every one of them", () => {
    for (const r of exposed) {
      const src = fs.readFileSync(r.file, "utf8");
      const has = AUTH_CALLS.some((c) => src.includes(c));
      expect(has ? "ok" : `${r.file} has no authorization call`).toBe("ok");
    }
  });

  it("does not expose the self-authenticating exchange endpoint", () => {
    // It authenticates on a signed code plus the PKCE verifier and has no session, so it is public
    // rather than bypassed — and must stay outside this set.
    expect(exposed.map((r) => r.file)).not.toContain(
      "app/api/cli-auth/exchange/route.ts",
    );
  });
});
