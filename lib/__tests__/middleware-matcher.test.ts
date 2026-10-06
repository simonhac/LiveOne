/**
 * Which paths `middleware.ts` runs on, compiled with Next's own matcher compiler so the lookaheads
 * are tested as Next will read them, not as a hand-written RegExp would.
 *
 * `/api/observations/receive` is excluded to save its ~20k edge invocations a day of log-drain
 * volume (see the note on `config` in middleware.ts). The danger is excluding too much: anything
 * else that skips middleware also skips Clerk.
 */
import { describe, it, expect } from "@jest/globals";
import { config } from "../../middleware";

// Exported at runtime but not in Next's published types.
const { getMiddlewareMatchers } =
  require("next/dist/build/analysis/get-page-static-info") as {
    getMiddlewareMatchers: (
      matcher: string[],
      nextConfig: object,
    ) => { regexp: string }[];
  };

const matchers = getMiddlewareMatchers(config.matcher, {});
const runsMiddleware = (path: string) =>
  matchers.some((m) => new RegExp(m.regexp).test(path));

describe("middleware matcher", () => {
  it("skips the QStash observations receiver", () => {
    expect(runsMiddleware("/api/observations/receive")).toBe(false);
  });

  it.each([
    "/api/observations/receive-dev",
    "/api/observations/info",
    "/api/admin/observations/info",
    "/api/cron/minutely",
    "/api/gush",
    "/api/health",
    "/dashboard",
    "/",
  ])("still runs on %s", (path) => {
    expect(runsMiddleware(path)).toBe(true);
  });

  it("skips Next internals and static assets", () => {
    expect(runsMiddleware("/_next/static/chunk.js")).toBe(false);
    expect(runsMiddleware("/favicon.ico")).toBe(false);
  });
});
