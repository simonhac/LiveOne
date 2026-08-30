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
    // These need their OWN entries: middleware runs before next.config's rewrites and matches the
    // ORIGINAL path, so `/api/v4/...` inherited nothing from the `/api/areas/...` entries that used to
    // sit beside them. Without them a headless CRON_SECRET call is 404'd at the edge having never
    // reached the in-handler gate — invisible to a logged-in tester.
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/provenance-summary",
    "/api/v4/areas/by-handle/1000002",
    "/api/v4/areas/ar_01k1abcd2efghjkmnpqrstvwxy/recompute-provenance",
    // The two internal galleries: no-login visual harnesses, pushed onto the allow-list ONLY when
    // VERCEL_ENV !== "production" (unset under jest, so they are public here). `chart-gallery` is the
    // screenshot target for e2e/charts.spec.ts and must stay reachable without a Clerk session, or the
    // whole baseline suite 404s at the edge. The prod case is asserted separately below.
    "/labs/card-gallery",
    "/labs/chart-gallery",
    "/labs/chart-gallery?case=lines-d-power",
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
    // 🛑 The LEGACY `/api/areas` TREE IS DELETED, and so are the three `publicRoutes` entries that
    // used to name its provenance/by-handle suffixes. These paths are now unrouted strings, and they
    // must NOT be public: a leftover allow-list entry is an edge bypass
    // pointing at a 404 today and at whatever occupies the path tomorrow. Nothing else in the suite
    // would notice its reintroduction, which is why the negative assertion is spelled out.
    "/api/areas",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/bindings",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/recompute-provenance",
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/provenance-summary",
    "/api/areas/by-handle/1000002",
    "/api/dashboards",
    "/api/dashboards/5",
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
    // …and the v4 allow-list is just as surgical: only the recompute suffix is public, so every v4 area
    // MUTATION stays Clerk-gated. Adding `/api/v4/areas(.*)` instead of the one suffix would have
    // silently opened all four of these.
    "/api/v4/areas",
    "/api/v4/areas/ar_01k1abcd2efghjkmnpqrstvwxy",
    "/api/v4/areas/ar_01k1abcd2efghjkmnpqrstvwxy/members",
    "/api/v4/areas/ar_01k1abcd2efghjkmnpqrstvwxy/bindings",
  ];
  it.each(protectedPaths)("treats %s as protected", (p) => {
    expect(isPublicRoute(req(p))).toBe(false);
  });

  // 🛑 The galleries are allow-listed by a `process.env.VERCEL_ENV !== "production"` guard evaluated
  // at MODULE LOAD, so the assertions above only ever exercise the non-prod branch. This re-imports
  // the module under VERCEL_ENV=production to prove the other branch: in prod they must be gated, or
  // an internal harness (and, for chart-gallery, a page that renders fabricated data) is world-
  // readable. The page-level notFound() is defense-in-depth for exactly this, not a substitute.
  describe("under VERCEL_ENV=production", () => {
    const prodIsPublic = (p: string): boolean => {
      const prev = process.env.VERCEL_ENV;
      process.env.VERCEL_ENV = "production";
      try {
        let result = true;
        jest.isolateModules(() => {
          const mod =
            require("../route-matchers") as typeof import("../route-matchers");
          result = mod.isPublicRoute(req(p));
        });
        return result;
      } finally {
        if (prev === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = prev;
      }
    };

    it.each(["/labs/card-gallery", "/labs/chart-gallery"])("gates %s", (p) => {
      expect(prodIsPublic(p)).toBe(false);
    });

    it("still treats a genuinely public route as public", () => {
      // Guards the guard: if the isolateModules re-import silently failed, everything would read as
      // "not public" and the assertions above would pass for the wrong reason.
      expect(prodIsPublic("/api/health")).toBe(true);
    });
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
    // 🛑 THIS is the entry a logged-in tester can never miss the absence of: without it the route 404s
    // at the Clerk edge for every ANONYMOUS `?access=` shared-dashboard viewer and works perfectly for
    // everyone else. `lib/queries/provenanceDaily.ts` is the client that reaches it.
    "/api/v4/areas/ar_01k9fahd43fkbb2ge7dwsjhzqf/provenance-daily",
  ];
  it.each(shareable)("allows %s via a share token", (p) => {
    expect(isShareableRoute(req(p))).toBe(true);
  });

  // A stray ?access= must NOT reach these — they stay Clerk-gated. Note the plural `/api/devices`
  // (admin) must NOT be caught by the singular `/api/device/(.*)` rule; likewise the `/api/v4/dashboards`
  // CRUD (there is no `/api/dashboard(.*)` shareable entry).
  const notShareable = [
    "/api/test/cache",
    "/api/admin/storage",
    "/api/devices",
    // 🛑 The OLD spellings, after the compat shim was deleted.
    // `/api/system/(.*)` used to sit in `shareableRoutes` so that an anonymous
    // `?access=` viewer running a stale bundle got past the Clerk edge and into the
    // next.config rewrite to `/api/device/*`. Both halves are gone, so these paths are now
    // just unrouted strings: no rewrite, no bypass. The negative assertion is what keeps the
    // entry from being reintroduced by muscle memory — nothing else in the suite would notice.
    "/api/system/1/points",
    "/api/systems",
    "/api/systems/1/credentials",
    "/api/dashboards/5",
    "/api/share-tokens",
    "/api/user/preferences",
    // 🛑 The deleted legacy tree, on the shareable side. The
    // `/api/areas/(.*)/provenance-daily` entry that used to make the FIRST of these shareable went with
    // the route; an anonymous `?access=` viewer now reaches only the v4 path.
    "/api/areas/019f513a-0d43-7c4b-b133-38f6e399fdd6/provenance-daily",
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
    // 🛑 The SHARING-MANAGEMENT routes themselves. A share token that
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
