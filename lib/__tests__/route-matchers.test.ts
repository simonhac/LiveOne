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
    // …and the config-v4 twins (Phase 14 stage 12). These need their OWN entries: middleware runs
    // before next.config's rewrites and matches the ORIGINAL path, so `/api/v4/...` inherits nothing
    // from the `/api/areas/...` lines above. Without them a headless CRON_SECRET call is 404'd at the
    // edge having never reached the in-handler gate — invisible to a logged-in tester.
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/provenance-summary",
    "/api/v4/areas/by-handle/1000002",
  ];
  it.each(publicPaths)("treats %s as public", (p) => {
    expect(isPublicRoute(req(p))).toBe(true);
  });

  // Everything else must be gated by the middleware (NOT public).
  const protectedPaths = [
    "/",
    "/admin",
    "/admin/devices",
    "/dashboard",
    "/labs/kinkora-hws",
    "/api/data",
    "/api/admin/storage",
    "/api/share-tokens",
    "/api/devices",
    "/api/device/1/point/0",
    // The battery-provenance ops allow-list is surgical — sibling area routes stay Clerk-gated.
    "/api/areas",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/bindings",
    // The v4 allow-list is surgical in exactly the same way: the two public suffixes above must not
    // open the rest of the (owner-facing, Clerk-gated) `/api/v4` tree.
    "/api/v4/areas",
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf",
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/default-group",
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/eligibility",
    // provenance-DAILY is shareable, never public — a ?access= viewer reaches it, an anonymous
    // request with no token must still be stopped at the edge.
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/provenance-daily",
    "/api/v4/devices",
    "/api/v4/dashboards",
    "/api/v4/dashboards/db_01k9fahd43fkbb2ge7dwsjhzqf",
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
    "/api/device/1/latest",
    "/api/device/1/run-periods",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/provenance-daily",
    // 🛑 Its config-v4 twin (Phase 14 stage 12). THIS is the entry a logged-in tester can never miss
    // the absence of: without it the v4 route 404s at the Clerk edge for every ANONYMOUS `?access=`
    // shared-dashboard viewer and works perfectly for everyone else.
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/provenance-daily",
    // Phase-13 compat shim: the PRE-rename spelling must stay shareable, because middleware
    // sees the ORIGINAL path and the next.config rewrite to `/api/device/*` runs after it.
    // Delete this entry with the shim.
    "/api/system/1/points",
  ];
  it.each(shareable)("allows %s via a share token", (p) => {
    expect(isShareableRoute(req(p))).toBe(true);
  });

  // A stray ?access= must NOT reach these — they stay Clerk-gated. Note the plural `/api/devices`
  // (admin) must NOT be caught by the singular `/api/device/(.*)` rule; likewise the plural
  // `/api/dashboards` CRUD (there is no `/api/dashboard(.*)` shareable entry).
  const notShareable = [
    "/api/test/cache",
    "/api/admin/storage",
    "/api/devices",
    // The compat shim is singular-only: the legacy PLURAL spelling (now `/api/devices`,
    // admin) must NOT become shareable via `/api/system/(.*)`.
    "/api/systems",
    "/api/systems/1/credentials",
    "/api/dashboards/5",
    "/api/share-tokens",
    "/api/user/preferences",
    // The surgical provenance-daily suffix must not open its CRUD siblings.
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/bindings",
    // Same, on the v4 tree: a stray ?access= must not reach the owner-facing management surface, and
    // in particular must not reach a MUTATION (the whole point of the shareable/public split).
    "/api/v4/areas",
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf",
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/members",
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/bindings",
    // The CRON_SECRET pair is public, NOT shareable — a share token grants a dashboard's read scope,
    // which is not the same authority as ops.
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/provenance-summary",
    "/api/v4/areas/by-handle/1000002",
    "/api/v4/devices",
    "/api/v4/dashboards/db_01k9fahd43fkbb2ge7dwsjhzqf",
    // 🛑 config-v4 Phase 14 stage 11 — the SHARING-MANAGEMENT routes themselves. A share token that
    // could reach these would be a self-extending credential: it could mint further tokens, relabel
    // its own, or hand a stranger a grant. `middleware.ts` also refuses any non-GET on the bypass,
    // so this is belt AND braces — but the belt is the one an accidental `/api/v4/dashboards/(.*)`
    // entry would cut, and the GET legs (listing every live token for a dashboard) are exactly what
    // an anonymous holder must not see.
    "/api/v4/dashboards/db_01k9abcdefghijkmnpqrstuvwx/shares",
    "/api/v4/dashboards/db_01k9abcdefghijkmnpqrstuvwx/grants",
    "/api/v4/dashboards/db_01k9abcdefghijkmnpqrstuvwx",
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
