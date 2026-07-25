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

import {
  cutoverPaused,
  cutoverPausedForIngest,
  cutoverSkipReason,
  CUTOVER_PAUSED_KEY,
  __resetCutoverIngestGateForTests,
} from "../guard";

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

  /**
   * The receiver variant trades a little staleness for two things the cron variant does not need: it is
   * on the ingest hot path (so an uncached KV round-trip per message is real, permanent cost for a
   * once-ever window), and it is the SINGLE WRITER of the serving store (so an unconditional fail-closed
   * turns any Upstash blip into a total ingest outage). Both properties are asserted here.
   */
  describe("cutoverPausedForIngest", () => {
    beforeEach(() => {
      __resetCutoverIngestGateForTests();
    });

    it("memoizes, so a burst of messages costs ONE KV read", async () => {
      mockGet.mockResolvedValue(null);
      for (let i = 0; i < 25; i++)
        expect(await cutoverPausedForIngest()).toBe(false);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("reports paused once the flag is set", async () => {
      mockGet.mockResolvedValue("1");
      expect(await cutoverPausedForIngest()).toBe(true);
    });

    it("rides out a KV outage on the last good NEGATIVE — ingest must not stop", async () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      mockGet.mockResolvedValue(null);
      expect(await cutoverPausedForIngest()).toBe(false);
      // Expire the TTL but stay inside the grace window.
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
      mockGet.mockRejectedValue(new Error("Upstash 503"));
      expect(await cutoverPausedForIngest()).toBe(false);
      jest.restoreAllMocks();
      spy.mockRestore();
    });

    it("rides out a KV outage on the last good POSITIVE — a live window stays safe", async () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      mockGet.mockResolvedValue("1");
      expect(await cutoverPausedForIngest()).toBe(true);
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
      mockGet.mockRejectedValue(new Error("Upstash 503"));
      expect(await cutoverPausedForIngest()).toBe(true);
      jest.restoreAllMocks();
      spy.mockRestore();
    });

    it("fails CLOSED when KV is down and there is no successful read to fall back on", async () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      mockGet.mockRejectedValue(new Error("KV unreachable"));
      expect(await cutoverPausedForIngest()).toBe(true);
      spy.mockRestore();
    });

    it("fails CLOSED once the cached value is older than the grace window", async () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      const t0 = Date.now();
      mockGet.mockResolvedValue(null);
      expect(await cutoverPausedForIngest()).toBe(false);
      jest.spyOn(Date, "now").mockReturnValue(t0 + 120_000); // > grace
      mockGet.mockRejectedValue(new Error("Upstash 503"));
      expect(await cutoverPausedForIngest()).toBe(true);
      jest.restoreAllMocks();
      spy.mockRestore();
    });
  });
});
