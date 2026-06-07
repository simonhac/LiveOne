import { describe, it, expect } from "@jest/globals";
import { isPublicRoute, hasAccessToken } from "../route-matchers";

// createRouteMatcher's predicate reads the request URL; provide both `url` (used
// by hasAccessToken) and `nextUrl` (used by some Clerk versions) so the same fake
// satisfies both without pulling in the Edge runtime.
const req = (path: string) => {
  const url = `https://liveone.vercel.app${path}`;
  return { url, nextUrl: new URL(url), method: "GET" } as any;
};

describe("isPublicRoute — middleware allow-list", () => {
  // Self-authenticating / no-auth inbound + auth pages: must bypass Clerk.
  const publicPaths = [
    "/sign-in",
    "/sign-in/factor-one",
    "/sign-up",
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
  ];
  it.each(protectedPaths)("treats %s as protected", (p) => {
    expect(isPublicRoute(req(p))).toBe(false);
  });
});

describe("hasAccessToken — share-link bypass (presence-only)", () => {
  it("is true when ?access=<token> is present", () => {
    expect(hasAccessToken(req("/labs/kinkora-hws?access=keen-fruity-tapir"))).toBe(true);
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
