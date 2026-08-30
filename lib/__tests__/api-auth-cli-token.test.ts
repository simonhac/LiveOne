/**
 * `getAuthContext` on the CLI-token path — the single enforcement point for a request the
 * middleware has deliberately let past the edge without authorizing.
 *
 * The load-bearing assertion is the negative one: on an invalid token this branch RETURNS, and
 * `auth()` is never consulted. Falling through would let a request presenting a garbage CLI
 * credential still succeed on a browser session cookie — an overlap that is confusing at best and
 * exploitable at worst.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { NextRequest } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: "user_from_cookie" })),
  clerkClient: jest.fn(),
}));
jest.mock("@/lib/auth-utils", () => ({
  isUserAdmin: jest.fn(async () => false),
}));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/dashboard/sharing", () => ({
  validateDashboardShareToken: jest.fn(),
}));
jest.mock("@/lib/dashboard/dashboards", () => ({ getDashboard: jest.fn() }));
jest.mock("@/lib/dashboard/access", () => ({ allowedSystemIds: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle: jest.fn(), areaByHandle: jest.fn() },
}));

import { getAuthContext } from "@/lib/api-auth";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { mintToken, METADATA_KEY } from "@/lib/cli-auth/tokens";

const mockAuth = jest.mocked(auth);
const mockClerkClient = jest.mocked(clerkClient);

const USER_ID = "user_31xcrIbiSrjjTIKlXShEPilRow7";
const NOW = new Date();

/** A Clerk client whose getUser returns `user`, or throws for an unknown id. */
function clerkReturning(user: unknown) {
  return jest.fn(async () => ({
    users: {
      getUser: jest.fn(async (id: string) => {
        if (!user || (user as { id: string }).id !== id)
          throw new Error("Not Found");
        return user;
      }),
    },
  }));
}

const req = (authorization?: string): NextRequest =>
  ({
    url: "http://localhost/api/v4/dashboards",
    method: "GET",
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "authorization" ? (authorization ?? null) : null,
    },
  }) as unknown as NextRequest;

/** A live token for USER_ID, plus the user record that holds it. */
function liveToken(opts: { isAdmin?: boolean } = {}) {
  const bare = { id: USER_ID, privateMetadata: {} };
  const { token, records } = mintToken(bare, { label: "test", now: NOW });
  return {
    token,
    user: {
      id: USER_ID,
      privateMetadata: { [METADATA_KEY]: records },
      publicMetadata: opts.isAdmin ? { isPlatformAdmin: true } : {},
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("a valid CLI token", () => {
  it("authenticates as its user, without consulting the session", () => {
    // Deliberately synchronous-looking: the point is that auth() is untouched.
    const { token, user } = liveToken();
    mockClerkClient.mockImplementation(clerkReturning(user) as never);
    return getAuthContext(req(`Bearer ${token}`)).then((ctx) => {
      expect(ctx).toEqual({
        userId: USER_ID,
        isAdmin: false,
        isCron: false,
        isClaudeDev: false,
      });
      expect(mockAuth).not.toHaveBeenCalled();
    });
  });

  it("carries admin from the same user record it verified against", async () => {
    // No second Clerk call for a fact the fetched record already contains.
    const { token, user } = liveToken({ isAdmin: true });
    mockClerkClient.mockImplementation(clerkReturning(user) as never);
    const ctx = await getAuthContext(req(`Bearer ${token}`));
    expect(ctx.isAdmin).toBe(true);
  });
});

describe("an invalid CLI token", () => {
  const cases: Array<[string, () => Promise<string>]> = [
    ["garbage", async () => "lo_cli_garbage"],
    [
      "well-formed but unknown secret",
      async () => {
        const { token } = liveToken();
        return token; // the client below will hold NO records for this user
      },
    ],
    [
      "another user's id spliced on",
      async () => {
        const { token } = liveToken();
        const [, , ...rest] = token.split("_");
        void rest;
        return token.replace(
          token.split("_")[2],
          Buffer.from("user_someone_else").toString("base64url"),
        );
      },
    ],
  ];

  for (const [name, make] of cases) {
    it(`is a clean 401 — no user, and auth() is NOT consulted (${name})`, async () => {
      const token = await make();
      // A user record with no CLI tokens at all: every case above must fail against it.
      mockClerkClient.mockImplementation(
        clerkReturning({
          id: USER_ID,
          privateMetadata: {},
          publicMetadata: {},
        }) as never,
      );
      const ctx = await getAuthContext(req(`Bearer ${token}`));
      expect(ctx.userId).toBeNull();
      expect(ctx.isAdmin).toBe(false);
      // 🛑 The whole point: it returned rather than falling through to the cookie session.
      expect(mockAuth).not.toHaveBeenCalled();
    });
  }

  it("is a clean 401 when Clerk cannot resolve the user at all", async () => {
    const { token } = liveToken();
    mockClerkClient.mockImplementation(clerkReturning(null) as never);
    const ctx = await getAuthContext(req(`Bearer ${token}`));
    expect(ctx.userId).toBeNull();
    expect(mockAuth).not.toHaveBeenCalled();
  });
});

describe("every other credential still takes the session path", () => {
  it("falls through to auth() when there is no CLI bearer", async () => {
    for (const header of [
      undefined,
      "Bearer eyJhbGciOiJSUzI1NiJ9.a.b", // a Clerk JWT
      "Bearer gk_gusherKey",
      "Basic bG86Y2xp",
    ]) {
      jest.clearAllMocks();
      const ctx = await getAuthContext(req(header));
      expect(ctx.userId).toBe("user_from_cookie");
      expect(mockAuth).toHaveBeenCalledTimes(1);
    }
  });
});
