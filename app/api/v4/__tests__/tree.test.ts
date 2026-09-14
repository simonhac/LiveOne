import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/inventory/read", () => ({ readTreeInventory: jest.fn() }));
import { requireAuth } from "@/lib/api-auth";
import { readTreeInventory } from "@/lib/inventory/read";
import { GET } from "../tree/route";
const call = (query = "") =>
  GET(new NextRequest(`http://localhost/api/v4/tree${query}`));
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(requireAuth).mockResolvedValue({
    userId: "owner",
    isAdmin: true,
    actingAsAdmin: false,
  } as never);
  jest.mocked(readTreeInventory).mockResolvedValue({ version: 1 } as never);
});
describe("tree authorization", () => {
  it("does not expand an admin's default scope", async () => {
    const res = await call("?admin=true&sharing=true");
    expect(res.status).toBe(200);
    expect(readTreeInventory).toHaveBeenCalledWith("owner", false, true);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("uses the authenticated admin opt-in for fleet scope", async () => {
    jest.mocked(requireAuth).mockResolvedValue({
      userId: "admin",
      isAdmin: true,
      actingAsAdmin: true,
    } as never);
    await call();
    expect(readTreeInventory).toHaveBeenCalledWith("admin", true, false);
  });
  it("does not read any inventory without authentication", async () => {
    jest
      .mocked(requireAuth)
      .mockResolvedValue(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      );
    expect((await call()).status).toBe(401);
    expect(readTreeInventory).not.toHaveBeenCalled();
  });
  it("rejects an invalid sharing flag", async () => {
    expect((await call("?sharing=yes")).status).toBe(400);
    expect(readTreeInventory).not.toHaveBeenCalled();
  });
});
