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
  it("covers the dashboard surface and the CLI's own token management", () => {
    for (const p of [
      "/api/v4/dashboards",
      "/api/v4/dashboards/db_01kyf18tp3e5brm474zf0fzvkm",
      "/api/v4/dashboards/db_x/grants",
      "/api/cli-auth/tokens",
      "/api/cli-auth/tokens/cli_abc",
    ])
      expect(isCliTokenRoute(req(p))).toBe(true);
  });

  it("does NOT cover admin, control, vendor, cron or page routes", () => {
    // A CLI credential is a real user credential, so widening this list is a real decision. These
    // are the surfaces a stray or stolen token must not reach at the edge.
    for (const p of [
      "/api/admin/storage",
      "/api/admin/devices/1/config",
      "/api/control/command",
      "/api/auth/tesla/callback",
      "/api/cron/db-stats",
      "/api/data",
      "/api/history",
      "/api/device/1/latest",
      "/api/v4/areas/ar_x/members",
      "/api/v4/devices",
      "/dashboard/simon/kink",
      "/",
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
  const AUTH_CALLS = [
    "loadOwnedDashboard",
    "requireAuth",
    "requireAdmin",
    "requireDashboardAccess",
  ];

  const routesUnder = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "route.ts") out.push(p);
      }
    };
    walk(dir);
    return out;
  };

  // Mirrors cliTokenRoutes in lib/route-matchers.ts. Kept as a literal list so that widening the
  // matcher without widening this check is a visible omission rather than an invisible one.
  const dirs = ["app/api/v4/dashboards", "app/api/cli-auth"];

  it("finds the dashboard routes (so the check cannot silently cover nothing)", () => {
    const found = dirs.flatMap(routesUnder);
    expect(found.length).toBeGreaterThanOrEqual(5);
  });

  it("has an authorization call in every one of them", () => {
    for (const file of dirs.flatMap(routesUnder)) {
      const src = fs.readFileSync(file, "utf8");
      const has = AUTH_CALLS.some((c) => src.includes(c));
      expect(has ? "ok" : `${file} has no authorization call`).toBe("ok");
    }
  });
});
