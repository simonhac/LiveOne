import { describe, it, expect } from "@jest/globals";
import {
  isPublicRoute,
  isShareableRoute,
  hasAccessToken,
} from "../route-matchers";

// createRouteMatcher's predicate reads the request URL; provide both `url` (used
// by hasAccessToken) and `nextUrl` (used by some Clerk versions) so the same fake
// satisfies both without pulling in the Edge runtime.
const req = (path: string, method = "GET") => {
  const url = `https://liveone.vercel.app${path}`;
  return { url, nextUrl: new URL(url), method } as any;
};

describe("isPublicRoute — middleware allow-list", () => {
  // Self-authenticating / no-auth inbound + auth pages: must bypass Clerk.
  const publicPaths = [
    "/sign-in",
    "/sign-in/factor-one",
    "/sign-up",
    "/.well-known/appspecific/com.tesla.3p.public-key.pem", // Tesla fetches the key unauthenticated
    "/api/health",
    "/api/cron/db-stats",
    "/api/cron/monitor-observations",
    "/api/push/fusher",
    "/api/push/fronius",
    "/api/observations/receive",
    "/api/observations/receive-dev",
    "/api/auth/tesla/callback", // OAuth redirect carries no Clerk session — must be public
    "/api/auth/enphase/connect",
    "/api/auth/tesla/disconnect",
    "/api/enphase-proxy",
    // Battery-provenance ops endpoints — self-authenticate in-handler (owner/admin or CRON_SECRET).
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/recompute-provenance",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/provenance-summary",
    "/api/areas/by-handle/1000002",
  ];
  it.each(publicPaths)("treats %s as public", (p) => {
    expect(isPublicRoute(req(p))).toBe(true);
  });

  // Everything else must be gated by the middleware (NOT public).
  const protectedPaths = [
    "/",
    "/admin",
    "/admin/systems",
    "/dashboard",
    "/labs/kinkora-hws",
    "/api/data",
    "/api/admin/storage",
    "/api/share-tokens",
    "/api/systems",
    "/api/system/1/point/0",
    // The battery-provenance ops allow-list is surgical — sibling area routes stay Clerk-gated.
    "/api/areas",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/bindings",
  ];
  it.each(protectedPaths)("treats %s as protected", (p) => {
    expect(isPublicRoute(req(p))).toBe(false);
  });
});

describe("hasAccessToken — share-link bypass (presence-only)", () => {
  it("is true when ?access=<token> is present", () => {
    expect(
      hasAccessToken(req("/labs/kinkora-hws?access=keen-fruity-tapir")),
    ).toBe(true);
  });
  it("is true even when ?access= is empty (presence-only — token validated downstream)", () => {
    expect(hasAccessToken(req("/labs/kinkora-hws?access="))).toBe(true);
  });
  it("is false without an ?access param", () => {
    expect(hasAccessToken(req("/labs/kinkora-hws"))).toBe(false);
  });
  it("is false for an unrelated query param", () => {
    expect(hasAccessToken(req("/labs/kinkora-hws?foo=bar"))).toBe(false);
  });
});

describe("isShareableRoute — ?access= bypass allow-list", () => {
  // The read-only shared dashboard page + the endpoints its cards fetch (lib/queries/*).
  const shareable = [
    "/dashboard",
    "/dashboard/simon/home",
    "/api/data",
    "/api/history",
    "/api/energy-flow-matrix",
    "/api/system/1/latest",
    "/api/system/1/run-periods",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/provenance-daily",
  ];
  it.each(shareable)("allows %s via a share token", (p) => {
    expect(isShareableRoute(req(p))).toBe(true);
  });

  // A stray ?access= must NOT reach these — they stay Clerk-gated. Note the plural `/api/systems`
  // (admin) must NOT be caught by the singular `/api/system/(.*)` rule; likewise the plural
  // `/api/dashboards` CRUD (there is no `/api/dashboard(.*)` shareable entry).
  const notShareable = [
    "/api/test/cache",
    "/api/admin/storage",
    "/api/systems",
    "/api/dashboards/5",
    "/api/share-tokens",
    "/api/user/preferences",
    // The surgical provenance-daily suffix must not open its CRUD siblings.
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/bindings",
  ];
  it.each(notShareable)("does NOT make %s shareable", (p) => {
    expect(isShareableRoute(req(p))).toBe(false);
  });
});

// The exact predicate middleware.ts uses to decide whether to skip Clerk's auth.protect().
const bypassesAuth = (request: any) =>
  (request.method === "GET" || request.method === "HEAD") &&
  isShareableRoute(request) &&
  hasAccessToken(request);

describe("share-link bypass decision (mirrors middleware.ts)", () => {
  it("bypasses for a GET to a share-eligible route with ?access=", () => {
    expect(bypassesAuth(req("/api/data?systemId=1&access=tok"))).toBe(true);
  });
  it("does NOT bypass a non-shareable route even with ?access= (the closed hole)", () => {
    expect(bypassesAuth(req("/api/test/cache?access=tok"))).toBe(false);
  });
  it("does NOT bypass a write (POST) even on a share-eligible route", () => {
    expect(bypassesAuth(req("/api/data?systemId=1&access=tok", "POST"))).toBe(
      false,
    );
  });
  it("does NOT bypass a share-eligible route without a token", () => {
    expect(bypassesAuth(req("/api/data?systemId=1"))).toBe(false);
  });
});
