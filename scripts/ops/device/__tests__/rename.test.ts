import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Ctx } from "@/lib/cli/cli";
import type { ApiSession } from "@/lib/cli-kit/api-session";

jest.mock("@/lib/cli-kit/api-session", () => ({ withApiSession: jest.fn() }));
jest.mock("@/lib/cli-kit/http", () => ({ apiFetch: jest.fn() }));
jest.mock("../../shared", () => ({
  ...jest.requireActual<typeof import("../../shared")>("../../shared"),
  resolveDevice: jest.fn(),
}));
import { withApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { resolveDevice } from "../../shared";
import { runDevice } from "../cli";
const get = jest.fn<(path: string) => Promise<unknown>>();
const emit = jest.fn();
const ctx = (dryRun: boolean): Ctx =>
  ({
    args: ["9", "New name"],
    flags: {},
    subcommandPath: ["device", "rename"],
    dryRun,
    emit,
  }) as unknown as Ctx;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(withApiSession).mockImplementation(async (_ctx, fn) =>
    fn({
      origin: "https://example.test",
      token: "token",
      get,
    } as unknown as ApiSession),
  );
  jest
    .mocked(resolveDevice)
    .mockResolvedValue({ id: "dv_test", name: "Old name" } as never);
  jest.mocked(apiFetch).mockResolvedValue({
    status: 200,
    body: { name: "New name", renamed: true },
  } as never);
  get.mockResolvedValue({ name: "New name" });
});
describe("device rename execution", () => {
  it("previews without any write or verification fetch", async () => {
    expect(await runDevice(ctx(true))).toBe(0);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        previousName: "Old name",
        name: "New name",
        applied: false,
      }),
      expect.any(Function),
    );
  });
  it("sends only the name, then verifies the saved value", async () => {
    expect(await runDevice(ctx(false))).toBe(0);
    expect(apiFetch).toHaveBeenCalledWith(
      "https://example.test",
      "/api/v4/devices/dv_test",
      { method: "PATCH", token: "token", body: { name: "New name" } },
    );
    expect(get).toHaveBeenCalledWith("/api/v4/devices/dv_test");
  });
  it("does not claim success when read-back disagrees", async () => {
    get.mockResolvedValue({ name: "Old name" });
    await expect(runDevice(ctx(false))).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
  it("does not claim success when the write is refused", async () => {
    jest.mocked(apiFetch).mockRejectedValue(new Error("forbidden"));
    await expect(runDevice(ctx(false))).rejects.toThrow("forbidden");
    expect(get).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
