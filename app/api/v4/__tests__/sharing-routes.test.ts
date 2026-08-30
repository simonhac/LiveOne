/**
 * ROUTE-level tests for `/api/v4/dashboards/{id}/shares` and `/api/v4/dashboards/{id}/grants`
 *.
 *
 * Companion to `scripts/utils/v4-surface-smoke.ts`, which drives the same handlers against a live dev
 * server, a real Clerk session and a real Postgres. This file covers what only a mock reaches — the
 * 403-not-owner branch, a Clerk lookup that THROWS (a deleted grantee), and the exact shape of the
 * all-or-nothing 422.
 *
 * 🛑 Sharing is the one genuinely multi-party surface in this system: a token authorizes an anonymous
 * reader. So the assertions below are about the difference between "changed nothing" and "succeeded",
 * which the legacy twin conflated into `200 {ok:false}`.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

const OWNER = "user_owner";
const OTHER = "user_other";
const ALICE = "user_alice";
const BOB = "user_bob";
const DASHBOARD_ID = "db_00000000000000000000000001";

jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/dashboard/dashboards", () => ({ getDashboard: jest.fn() }));
jest.mock("@/lib/dashboard/sharing", () => ({
  createDashboardShareToken: jest.fn(),
  getDashboardShareToken: jest.fn(),
  listDashboardShareTokens: jest.fn(),
  renameDashboardShareToken: jest.fn(),
  revokeDashboardShareToken: jest.fn(),
}));
jest.mock("@/lib/dashboard/grants", () => ({
  listGrantsForDashboard: jest.fn(),
  replaceDashboardGrants: jest.fn(),
}));
jest.mock("@/lib/user-cache", () => ({
  getUserIdByEmail: jest.fn(),
  getUserIdByUsername: jest.fn(),
}));
const getUser = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({ users: { getUser } }),
}));

import { requireAuth } from "@/lib/api-auth";
import { getDashboard } from "@/lib/dashboard/dashboards";
import {
  createDashboardShareToken,
  getDashboardShareToken,
  listDashboardShareTokens,
  renameDashboardShareToken,
  revokeDashboardShareToken,
} from "@/lib/dashboard/sharing";
import {
  listGrantsForDashboard,
  replaceDashboardGrants,
} from "@/lib/dashboard/grants";
import { getUserIdByEmail, getUserIdByUsername } from "@/lib/user-cache";
import {
  GET as sharesGET,
  POST as sharesPOST,
  PATCH as sharesPATCH,
  DELETE as sharesDELETE,
} from "../dashboards/[id]/shares/route";
import {
  GET as grantsGET,
  PUT as grantsPUT,
} from "../dashboards/[id]/grants/route";

const mockAuth = jest.mocked(requireAuth);
const mockGetDashboard = jest.mocked(getDashboard);
const mockMint = jest.mocked(createDashboardShareToken);
const mockGetToken = jest.mocked(getDashboardShareToken);
const mockList = jest.mocked(listDashboardShareTokens);
const mockRename = jest.mocked(renameDashboardShareToken);
const mockRevoke = jest.mocked(revokeDashboardShareToken);
const mockListGrants = jest.mocked(listGrantsForDashboard);
const mockReplace = jest.mocked(replaceDashboardGrants);
const mockByEmail = jest.mocked(getUserIdByEmail);
const mockByUsername = jest.mocked(getUserIdByUsername);

const params = Promise.resolve({ id: DASHBOARD_ID });
const req = (url: string, init?: RequestInit) =>
  new NextRequest(new Request(url, init));
const json = (url: string, method: string, body: unknown) =>
  req(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const SHARES_URL = `http://localhost/api/v4/dashboards/${DASHBOARD_ID}/shares`;
const GRANTS_URL = `http://localhost/api/v4/dashboards/${DASHBOARD_ID}/grants`;

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    token: "leaping-fizzy-wombat",
    label: "Kitchen TV",
    createdAtMs: 1_700_000_000_000,
    expiresAtMs: null,
    revokedAtMs: null,
    lastUsedAtMs: null,
    ...over,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: OWNER, isAdmin: false } as never);
  mockGetDashboard.mockResolvedValue({
    id: DASHBOARD_ID,
    ownerClerkUserId: OWNER,
  } as never);
  getUser.mockImplementation((async (id: string) => ({
    emailAddresses: [{ emailAddress: `${id}@example.com` }],
    username: id.replace("user_", ""),
    firstName: null,
    lastName: null,
  })) as never);
});

// ───────────────────────────────────────────────────────────── shares

describe("GET /api/v4/dashboards/{id}/shares", () => {
  it("returns the token list under the legacy twin's key and shape", async () => {
    mockList.mockResolvedValue([row()] as never);
    const res = await sharesGET(req(SHARES_URL), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Key-by-key against `GET /api/dashboards/{id}/share`: same container key, same entry keys.
    expect(Object.keys(body)).toEqual(["tokens"]);
    expect(Object.keys(body.tokens[0]).sort()).toEqual([
      "createdAtMs",
      "expiresAtMs",
      "label",
      "lastUsedAtMs",
      "revokedAtMs",
      "token",
    ]);
  });

  it("404s an unknown dashboard and 403s someone else's", async () => {
    mockGetDashboard.mockResolvedValueOnce(null as never);
    expect((await sharesGET(req(SHARES_URL), { params })).status).toBe(404);

    mockAuth.mockResolvedValue({ userId: OTHER, isAdmin: false } as never);
    expect((await sharesGET(req(SHARES_URL), { params })).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("401s when there is no session (the handler's own gate, behind the Clerk edge)", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never,
    );
    expect((await sharesGET(req(SHARES_URL), { params })).status).toBe(401);
  });
});

describe("POST /api/v4/dashboards/{id}/shares", () => {
  it("mints and answers 201 with the PERSISTED row", async () => {
    mockMint.mockResolvedValue({
      token: "leaping-fizzy-wombat",
      expiresAtMs: null,
    } as never);
    mockGetToken.mockResolvedValue(row() as never);
    const res = await sharesPOST(
      json(SHARES_URL, "POST", { label: "Kitchen TV" }),
      { params },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    // A superset of the legacy twin's `{token, expiresAtMs}`.
    expect(body.token).toBe("leaping-fizzy-wombat");
    expect(body.expiresAtMs).toBeNull();
    expect(body.createdAtMs).toBe(1_700_000_000_000);
    expect(mockMint).toHaveBeenCalledWith({
      dashboardId: DASHBOARD_ID,
      label: "Kitchen TV",
      expiresInDays: null,
    });
  });

  it("defaults the label but REFUSES a non-numeric expiresInDays", async () => {
    mockMint.mockResolvedValue({ token: "t", expiresAtMs: null } as never);
    mockGetToken.mockResolvedValue(row({ token: "t" }) as never);
    await sharesPOST(json(SHARES_URL, "POST", {}), { params });
    expect(mockMint).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Shared link" }),
    );

    // 🛑 The legacy twin coerced this to `null` — a link the caller believes expires in a week and
    // which in fact never does. Widening a credential silently is the wrong way to fail.
    const res = await sharesPOST(
      json(SHARES_URL, "POST", { expiresInDays: "7" }),
      { params },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).errors[0]).toMatch(/expiresInDays/);
    expect(mockMint).toHaveBeenCalledTimes(1); // the bad call never reached the DAO
  });

  it("422s a blank label rather than minting an unnameable link", async () => {
    const res = await sharesPOST(json(SHARES_URL, "POST", { label: "   " }), {
      params,
    });
    expect(res.status).toBe(422);
    expect(mockMint).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v4/dashboards/{id}/shares", () => {
  it("relabels and echoes the updated row", async () => {
    mockRename.mockResolvedValue(true as never);
    mockGetToken.mockResolvedValue(row({ label: "Lounge TV" }) as never);
    const res = await sharesPATCH(
      json(SHARES_URL, "PATCH", {
        token: "leaping-fizzy-wombat",
        label: "Lounge TV",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).label).toBe("Lounge TV");
  });

  it("404s an unknown token instead of the legacy 200 {ok:false}", async () => {
    mockRename.mockResolvedValue(false as never);
    mockGetToken.mockResolvedValue(null as never);
    const res = await sharesPATCH(
      json(SHARES_URL, "PATCH", { token: "no-such-token", label: "x" }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409s a REVOKED token — it exists, but relabelling it would imply it is live", async () => {
    mockRename.mockResolvedValue(false as never);
    mockGetToken.mockResolvedValue(
      row({ revokedAtMs: 1_700_000_100_000 }) as never,
    );
    const res = await sharesPATCH(
      json(SHARES_URL, "PATCH", { token: "leaping-fizzy-wombat", label: "x" }),
      { params },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).revokedAtMs).toBe(1_700_000_100_000);
  });

  it("422s a missing token", async () => {
    const res = await sharesPATCH(json(SHARES_URL, "PATCH", { label: "x" }), {
      params,
    });
    expect(res.status).toBe(422);
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v4/dashboards/{id}/shares", () => {
  it("revokes and PROVES it by echoing revokedAtMs read back from the row", async () => {
    mockRevoke.mockResolvedValue(true as never);
    mockGetToken.mockResolvedValue(
      row({ revokedAtMs: 1_700_000_100_000 }) as never,
    );
    const res = await sharesDELETE(
      req(`${SHARES_URL}?token=leaping-fizzy-wombat`, { method: "DELETE" }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // 🛑 Not asserted by the handler — READ BACK. An under-delete would show revokedAtMs null here.
    expect(body.revokedAtMs).toBe(1_700_000_100_000);
    expect(mockRevoke).toHaveBeenCalledWith(
      "leaping-fizzy-wombat",
      DASHBOARD_ID,
    );
  });

  it("404s an unknown token (or one belonging to another dashboard)", async () => {
    mockRevoke.mockResolvedValue(false as never);
    mockGetToken.mockResolvedValue(null as never);
    const res = await sharesDELETE(
      req(`${SHARES_URL}?token=someone-elses-token`, { method: "DELETE" }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("is idempotent: re-revoking an already-revoked token is a 200", async () => {
    mockRevoke.mockResolvedValue(false as never);
    mockGetToken.mockResolvedValue(
      row({ revokedAtMs: 1_700_000_100_000 }) as never,
    );
    const res = await sharesDELETE(
      req(`${SHARES_URL}?token=leaping-fizzy-wombat`, { method: "DELETE" }),
      { params },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).revokedAtMs).toBe(1_700_000_100_000);
  });

  it("422s a missing ?token", async () => {
    const res = await sharesDELETE(req(SHARES_URL, { method: "DELETE" }), {
      params,
    });
    expect(res.status).toBe(422);
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────── grants

describe("GET /api/v4/dashboards/{id}/grants", () => {
  it("carries the legacy twin's Clerk decoration key-for-key", async () => {
    mockListGrants.mockResolvedValue([
      { userId: ALICE, role: "viewer", createdAt: new Date(1_700_000_000_000) },
    ] as never);
    const res = await grantsGET(req(GRANTS_URL), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["members"]);
    // 🛑 The exact key set of `GET /api/dashboards/{id}/grants`. `email`/`name` are the Clerk
    // decoration — the kind of field a v4 port drops silently (STEP 0 defect D2).
    expect(Object.keys(body.members[0]).sort()).toEqual([
      "clerkUserId",
      "createdAtMs",
      "email",
      "name",
      "role",
    ]);
    expect(body.members[0].email).toBe(`${ALICE}@example.com`);
  });

  it("keeps a DELETED Clerk user's row (null email/name), so it stays removable", async () => {
    getUser.mockImplementation((async () => {
      throw new Error("clerk 404");
    }) as never);
    mockListGrants.mockResolvedValue([
      { userId: BOB, role: "viewer", createdAt: new Date(0) },
    ] as never);
    const body = await (await grantsGET(req(GRANTS_URL), { params })).json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({
      clerkUserId: BOB,
      email: null,
      name: null,
    });
  });

  it("403s someone else's dashboard", async () => {
    mockAuth.mockResolvedValue({ userId: OTHER, isAdmin: false } as never);
    expect((await grantsGET(req(GRANTS_URL), { params })).status).toBe(403);
  });
});

describe("PUT /api/v4/dashboards/{id}/grants — full replace", () => {
  beforeEach(() => {
    mockReplace.mockResolvedValue({
      added: [],
      updated: [],
      unchanged: [],
      removed: [],
    } as never);
    mockListGrants.mockResolvedValue([] as never);
  });

  it("resolves email/username/clerkUserId and hands the DAO the whole target list", async () => {
    mockByEmail.mockResolvedValue(ALICE as never);
    mockByUsername.mockResolvedValue(BOB as never);
    const res = await grantsPUT(
      json(GRANTS_URL, "PUT", {
        members: [
          { email: "alice@example.com" },
          { username: "bob", role: "admin" },
          { clerkUserId: "user_carla" },
        ],
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(mockReplace).toHaveBeenCalledWith(DASHBOARD_ID, [
      { clerkUserId: ALICE, role: "viewer" },
      { clerkUserId: BOB, role: "admin" },
      { clerkUserId: "user_carla", role: "viewer" },
    ]);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["changed", "members"]);
  });

  it("an empty list is the REMOVE-EVERYONE case, not a no-op", async () => {
    const res = await grantsPUT(json(GRANTS_URL, "PUT", { members: [] }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(mockReplace).toHaveBeenCalledWith(DASHBOARD_ID, []);
  });

  it("a MISSING members key is 422, not an accidental remove-everyone", async () => {
    // 🛑 The whole point of separating this from `[]`: a client that forgets the key, or sends
    // `{member: …}`, must not silently wipe the membership.
    const res = await grantsPUT(json(GRANTS_URL, "PUT", {}), { params });
    expect(res.status).toBe(422);
    expect((await res.json()).errors[0].code).toBe("members-required");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("is ALL-OR-NOTHING: one unresolvable invitee rejects the whole replace", async () => {
    mockByEmail.mockImplementation((async (email: string) =>
      email === "alice@example.com" ? ALICE : null) as never);
    const res = await grantsPUT(
      json(GRANTS_URL, "PUT", {
        members: [
          { email: "alice@example.com" },
          { email: "ghost@example.com" },
        ],
      }),
      { params },
    );
    expect(res.status).toBe(422);
    const errors = (await res.json()).errors;
    expect(errors).toEqual([
      { code: "user-not-found", index: 1, detail: "ghost@example.com" },
    ]);
    // Alice resolved fine — and still nothing was applied.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("refuses the owner, a duplicate, an unknown role and a malformed id", async () => {
    mockByEmail.mockResolvedValue(OWNER as never);
    const cases: Array<[unknown, string]> = [
      [{ email: "owner@example.com" }, "owner-already-has-full-access"],
      [{ clerkUserId: "alice" }, "malformed-clerk-user-id"],
      [{ clerkUserId: ALICE, role: "superuser" }, "unknown-role"],
      [
        { clerkUserId: ALICE, email: "a@b.c" },
        "member-needs-exactly-one-identifier",
      ],
      [{}, "member-needs-exactly-one-identifier"],
      ["alice", "member-must-be-an-object"],
    ];
    for (const [member, code] of cases) {
      const res = await grantsPUT(
        json(GRANTS_URL, "PUT", { members: [member] }),
        { params },
      );
      expect(res.status).toBe(422);
      expect((await res.json()).errors[0].code).toBe(code);
    }
    const dup = await grantsPUT(
      json(GRANTS_URL, "PUT", {
        members: [{ clerkUserId: ALICE }, { clerkUserId: ALICE }],
      }),
      { params },
    );
    expect((await dup.json()).errors[0].code).toBe("duplicate-member");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("403s someone else's dashboard before touching the DAO", async () => {
    mockAuth.mockResolvedValue({ userId: OTHER, isAdmin: false } as never);
    const res = await grantsPUT(json(GRANTS_URL, "PUT", { members: [] }), {
      params,
    });
    expect(res.status).toBe(403);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("an ADMIN who is not the owner may manage grants", async () => {
    mockAuth.mockResolvedValue({ userId: OTHER, isAdmin: true } as never);
    const res = await grantsPUT(json(GRANTS_URL, "PUT", { members: [] }), {
      params,
    });
    expect(res.status).toBe(200);
  });
});
