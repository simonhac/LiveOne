/**
 * The DeepSea control capability — the unit seam and the honesty of its reported outcomes.
 * (The hub's own safety invariants are tested in packages/usher/core/__tests__/control.test.ts.)
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const hubRun =
  jest.fn<(siteId: string, runtimeSec: number) => Promise<unknown>>();
jest.mock("../hub-client", () => ({
  hubRun: (...args: [string, number]) => hubRun(...args),
}));

import { DeepSeaControlCapability } from "../control";
import type { ControlInvokeContext } from "../../types";

function ctx(
  overrides: Partial<ControlInvokeContext> = {},
): ControlInvokeContext {
  return {
    device: { vendorSiteId: "sheephouse" },
    point: {
      logicalPath: "source.generator.control.request",
      metricType: "duration",
    },
    action: "set_value",
    value: 30,
    ...overrides,
  } as unknown as ControlInvokeContext;
}

describe("DeepSeaControlCapability", () => {
  const cap = new DeepSeaControlCapability();

  beforeEach(() => {
    hubRun.mockReset();
    hubRun.mockResolvedValue({
      ok: true,
      action: "started",
      stopAt: "2026-08-29T08:00:00.000Z",
      remainingSec: 1800,
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("converts MINUTES to SECONDS exactly once (the unit seam)", async () => {
    await cap.invoke(ctx({ value: 30 }));
    expect(hubRun).toHaveBeenCalledWith("sheephouse", 1800);
  });

  it("passes 0 through unchanged — the hub's 'stop' semantics", async () => {
    hubRun.mockResolvedValue({
      ok: true,
      action: "released",
      stopAt: null,
      remainingSec: null,
    });
    const r = await cap.invoke(ctx({ value: 0 }));
    expect(hubRun).toHaveBeenCalledWith("sheephouse", 0);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("cool down");
  });

  it("does NOT claim the engine stopped when the SP-PRO is still commanding it", async () => {
    hubRun.mockResolvedValue({
      ok: true,
      action: "released",
      stopAt: null,
      remainingSec: null,
      released: true,
      stillRunning: "remote-start-input",
    });
    const r = await cap.invoke(ctx({ value: 0 }));
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("still running");
    expect(r.reason).toContain("SP-PRO");
  });

  it("returns a hub refusal as a benign decline, preserving the hub's wording", async () => {
    hubRun.mockResolvedValue({
      ok: false,
      reason: "module is not in Auto (mode=Stop) — possible local lockout",
      stopAt: null,
      remainingSec: null,
    });
    const r = await cap.invoke(ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not in Auto");
  });

  it("distinguishes an extension from a start in what it tells the user", async () => {
    hubRun.mockResolvedValue({
      ok: true,
      action: "extended",
      stopAt: "2026-08-29T08:00:00.000Z",
      remainingSec: 1800,
    });
    const r = await cap.invoke(ctx());
    expect(r.reason).toContain("extended");
  });

  it("rejects a negative or non-numeric runtime before touching the hub", async () => {
    await expect(cap.invoke(ctx({ value: -5 }))).rejects.toThrow(
      /non-negative/,
    );
    await expect(cap.invoke(ctx({ value: undefined }))).rejects.toThrow(
      /non-negative/,
    );
    expect(hubRun).not.toHaveBeenCalled();
  });

  it("throws for an action/address it has no command for (a server config bug)", async () => {
    await expect(cap.invoke(ctx({ action: "turn_on" }))).rejects.toThrow(
      /no command for/,
    );
    await expect(
      cap.invoke(
        ctx({
          point: {
            logicalPath: "source.generator.engine",
            metricType: "speed",
          } as never,
        }),
      ),
    ).rejects.toThrow(/no command for/);
  });
});
