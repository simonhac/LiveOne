import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The cutover gate is a SAFETY mechanism for an irreversible maintenance window, so the property that
 * actually matters is the failure mode: a KV read that throws must report PAUSED, not "carry on". A cron
 * that wrongly runs against a half-transformed database is unrecoverable; a cron that wrongly skips is
 * picked up by the next tick.
 */

const mockGet = jest.fn<(key: string) => Promise<unknown>>();

jest.mock("@/lib/kv", () => ({
  kv: {
    get: (key: string) => mockGet(key),
  },
  kvKey: (pattern: string) => `test:${pattern}`,
}));

import { cutoverPaused, cutoverSkipReason, CUTOVER_PAUSED_KEY } from "../guard";

type Ctx = { isAdmin: boolean; isClaudeDev: boolean };
const ctx = (over: Partial<Ctx> = {}): any => ({
  isAdmin: false,
  isClaudeDev: false,
  isCron: true,
  userId: null,
  ...over,
});
const req = (force = false): any => ({
  nextUrl: { searchParams: new URLSearchParams(force ? "force=true" : "") },
});

describe("cutover gate", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe("cutoverPaused", () => {
    it("reads the environment-namespaced key", async () => {
      mockGet.mockResolvedValue(null);
      await cutoverPaused();
      expect(mockGet).toHaveBeenCalledWith(`test:${CUTOVER_PAUSED_KEY}`);
    });

    it.each([
      ["null (key absent)", null],
      ["undefined", undefined],
      ["0 (number)", 0],
      ['"0" (string)', "0"],
      ["false", false],
    ])("is NOT paused for %s", async (_label, value) => {
      mockGet.mockResolvedValue(value);
      expect(await cutoverPaused()).toBe(false);
    });

    it.each([
      ['"1"', "1"],
      ["1 (number)", 1],
      ["true", true],
      ['"yes"', "yes"],
    ])("IS paused for %s", async (_label, value) => {
      mockGet.mockResolvedValue(value);
      expect(await cutoverPaused()).toBe(true);
    });

    it("FAILS CLOSED when the KV read throws", async () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      mockGet.mockRejectedValue(new Error("KV unreachable"));
      expect(await cutoverPaused()).toBe(true);
      spy.mockRestore();
    });
  });

  describe("cutoverSkipReason", () => {
    it("returns null (proceed) when not paused", async () => {
      mockGet.mockResolvedValue(null);
      expect(await cutoverSkipReason(req(), ctx())).toBeNull();
    });

    it("skips a scheduled CRON_SECRET run while paused", async () => {
      mockGet.mockResolvedValue("1");
      const skip = await cutoverSkipReason(req(), ctx());
      expect(skip).toMatchObject({ skipped: true });
      expect(skip!.reason).toContain(CUTOVER_PAUSED_KEY);
    });

    it.each([
      ["an admin session", ctx({ isAdmin: true }), req()],
      ["the dev x-claude header", ctx({ isClaudeDev: true }), req()],
      ["?force=true", ctx(), req(true)],
    ])("lets %s through as the operator escape hatch", async (_l, c, r) => {
      mockGet.mockResolvedValue("1");
      expect(await cutoverSkipReason(r, c)).toBeNull();
    });

    it("still skips a scheduled run when KV is down (fail-closed end to end)", async () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      mockGet.mockRejectedValue(new Error("KV unreachable"));
      expect(await cutoverSkipReason(req(), ctx())).toMatchObject({
        skipped: true,
      });
      spy.mockRestore();
    });
  });
});
