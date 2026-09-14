import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Device } from "@/lib/ids";

jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/secure-credentials", () => ({
  getDeviceCredentials: jest.fn(),
}));
jest.mock("@/lib/vendors/amber/device-name", () => ({
  readAmberIdentity: jest.fn(),
}));
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { readAmberIdentity } from "@/lib/vendors/amber/device-name";
import { GET } from "../devices/[id]/vendor-identity/route";

const id = Device.generate();
const row = {
  rid: 9,
  ownerUserId: "owner",
  vendor: "amber",
  vendorSiteId: "stored",
};
function db(rows: unknown[]) {
  jest.mocked(requirePlanetscaleDb).mockReturnValue({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    }),
  } as never);
}
function call() {
  return GET(
    new NextRequest(`http://localhost/api/v4/devices/${id}/vendor-identity`),
    { params: Promise.resolve({ id }) },
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(requireAuth)
    .mockResolvedValue({ userId: "owner", isAdmin: false } as never);
  db([row]);
  jest
    .mocked(getDeviceCredentials)
    .mockResolvedValue({ apiKey: "secret", siteId: "different" } as never);
  jest.mocked(readAmberIdentity).mockResolvedValue({
    vendorSiteId: "stored",
    distributor: "CitiPower",
    nmi: "0123456789",
    suggestedName: "Amber CitiPower NMI 0123456789",
  });
});
describe("vendor identity authorization", () => {
  it.each([false, true])(
    "reads with the device owner's credentials and exact stored site (admin=%s)",
    async (isAdmin) => {
      jest.mocked(requireAuth).mockResolvedValue({
        userId: isAdmin ? "admin" : "owner",
        isAdmin,
        actingAsAdmin: isAdmin,
      } as never);
      const response = await call();
      expect(response.status).toBe(200);
      expect(getDeviceCredentials).toHaveBeenCalledWith("owner", 9);
      expect(readAmberIdentity).toHaveBeenCalledWith("secret", "stored");
      expect(JSON.stringify(await response.json())).not.toContain("secret");
    },
  );
  it("refuses a reader before loading credentials", async () => {
    jest
      .mocked(requireAuth)
      .mockResolvedValue({ userId: "viewer", isAdmin: false } as never);
    expect((await call()).status).toBe(404);
    expect(getDeviceCredentials).not.toHaveBeenCalled();
    expect(readAmberIdentity).not.toHaveBeenCalled();
  });
  it("requires an admin to opt in before reading another owner's identity", async () => {
    jest.mocked(requireAuth).mockResolvedValue({
      userId: "admin",
      isAdmin: true,
      actingAsAdmin: false,
    } as never);
    expect((await call()).status).toBe(404);
    expect(getDeviceCredentials).not.toHaveBeenCalled();
  });
  it("refuses anonymous requests", async () => {
    jest
      .mocked(requireAuth)
      .mockResolvedValue(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      );
    expect((await call()).status).toBe(401);
    expect(getDeviceCredentials).not.toHaveBeenCalled();
  });
  it("refuses other vendors without loading credentials", async () => {
    db([{ ...row, vendor: "tesla" }]);
    expect((await call()).status).toBe(422);
    expect(getDeviceCredentials).not.toHaveBeenCalled();
  });
  it("refuses missing credentials", async () => {
    jest.mocked(getDeviceCredentials).mockResolvedValue(null);
    expect((await call()).status).toBe(422);
    expect(readAmberIdentity).not.toHaveBeenCalled();
  });
  it("does not disclose an upstream error", async () => {
    jest.mocked(readAmberIdentity).mockRejectedValue(new Error("secret"));
    const response = await call();
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
