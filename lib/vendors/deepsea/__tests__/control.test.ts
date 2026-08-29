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
  jest.fn<
    (siteId: string, passkey: string, runtimeSec: number) => Promise<unknown>
  >();
const hubNoop =
  jest.fn<
    (siteId: string, passkey: string, runtimeSec?: number) => Promise<unknown>
  >();
jest.mock("../hub-client", () => ({
  hubRun: (...args: [string, string, number]) => hubRun(...args),
  hubNoop: (...args: [string, string, number | undefined]) => hubNoop(...args),
}));

const getDeviceCredentials =
  jest.fn<(userId: string, systemId: number) => Promise<unknown>>();
jest.mock("@/lib/secure-credentials", () => ({
  getDeviceCredentials: (...args: [string, number]) =>
    getDeviceCredentials(...args),
}));

import { DeepSeaControlCapability } from "../control";
import type { ControlInvokeContext } from "../../types";

function ctx(
  overrides: Partial<ControlInvokeContext> = {},
): ControlInvokeContext {
  return {
    device: { vendorSiteId: "sheephouse", ownerClerkUserId: "user_1", id: 14 },
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
    getDeviceCredentials.mockReset();
    getDeviceCredentials.mockResolvedValue({ controlPasskey: "pk-secret" });
    hubNoop.mockReset();
    hubNoop.mockResolvedValue({
      ok: true,
      wouldStart: true,
      verdict: "a 1800s run would START now",
      preflight: {
        ownership: {
          mode: 1,
          modeName: "Auto",
          remoteStartInput: "open",
          running: false,
        },
        scfSupported: {
          selectAuto: true,
          telemetryStart: true,
          telemetryCancel: true,
        },
        scfMap: [0, 0],
      },
      controlStatus: { maxRuntimeSec: 7200, latched: false, state: "idle" },
    });
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
    expect(hubRun).toHaveBeenCalledWith("sheephouse", "pk-secret", 1800);
  });

  it("passes 0 through unchanged — the hub's 'stop' semantics", async () => {
    hubRun.mockResolvedValue({
      ok: true,
      action: "released",
      stopAt: null,
      remainingSec: null,
    });
    const r = await cap.invoke(ctx({ value: 0 }));
    expect(hubRun).toHaveBeenCalledWith("sheephouse", "pk-secret", 0);
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

  describe("the deadline it reports", () => {
    /**
     * 🛑 This used to render the deadline with a hardcoded `en-AU` locale in a hardcoded
     * `Australia/Melbourne`, which was wrong twice: it named the wrong clock for any site that is
     * not Daylesford, and it froze a presentation choice into `point_commands.vendorResult`, which
     * outlives the dialog that showed it. The audit sentence now carries the INSTANT and the
     * display sentence is a template the reader spells.
     */
    it("keeps the instant unambiguous in the audit sentence", async () => {
      const r = await cap.invoke(ctx());
      expect(r.reason).toContain("2026-08-29T08:00:00.000Z");
      expect(r.reason).not.toMatch(/Melbourne|AEST|AEDT/);
    });

    it("names no timezone of its own", async () => {
      const r = await cap.invoke(ctx());
      // Nothing here may decide which clock the reader is on.
      expect(r.reason).not.toMatch(/\b\d{1,2}:\d{2}\s?(am|pm|AM|PM)\b/);
    });

    it("sends a template whose instant the reader will spell", async () => {
      const r = await cap.invoke(ctx());
      expect(r.reasonMessage).toEqual({
        template: "Generator starting — runs until {stopAt, time, short}.",
        values: { stopAt: "2026-08-29T08:00:00.000Z" },
      });
    });

    it("templates the EXTENDED sentence too", async () => {
      hubRun.mockResolvedValue({
        ok: true,
        action: "extended",
        stopAt: "2026-08-29T08:00:00.000Z",
        remainingSec: 1800,
      });
      const r = await cap.invoke(ctx());
      expect(r.reasonMessage?.template).toBe(
        "Run extended — now stops at {stopAt, time, short}.",
      );
    });

    it("sends no template when the hub reported no deadline", async () => {
      hubRun.mockResolvedValue({
        ok: true,
        action: "started",
        stopAt: null,
        remainingSec: null,
      });
      const r = await cap.invoke(ctx());
      expect(r.reasonMessage).toBeUndefined();
      // The sentence still stands on its own — a missing slot must never surface as "undefined".
      expect(r.reason).toContain("an unknown time");
    });

    it("passes the HUB's own template through on a decline, unaltered", async () => {
      hubRun.mockResolvedValue({
        ok: false,
        reason:
          "start may have taken effect (write failed after delivery was possible); a stop is scheduled for 2026-08-29T08:00:00.000Z",
        reasonMessage: {
          template:
            "start may have taken effect (write failed after delivery was possible); a stop is scheduled for {stopAt, time, short}",
          values: { stopAt: "2026-08-29T08:00:00.000Z" },
        },
        stopAt: "2026-08-29T08:00:00.000Z",
        remainingSec: null,
      });
      const r = await cap.invoke(ctx());
      expect(r.ok).toBe(false);
      expect(r.reasonMessage?.values?.stopAt).toBe("2026-08-29T08:00:00.000Z");
    });

    it("is undefined for a hub that sends no template (an older build)", async () => {
      hubRun.mockResolvedValue({
        ok: false,
        reason: "module is not in Auto (mode=Stop)",
        stopAt: null,
        remainingSec: null,
      });
      const r = await cap.invoke(ctx());
      expect(r.reasonMessage).toBeUndefined();
      expect(r.reason).toContain("not in Auto");
    });
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

  it("resolves the passkey from the DEVICE OWNER's credentials, not from env", async () => {
    await cap.invoke(ctx());
    expect(getDeviceCredentials).toHaveBeenCalledWith("user_1", 14);
  });

  it("refuses an OWNERLESS device — commandable by nobody, no credentials to command it with", async () => {
    await expect(
      cap.invoke(
        ctx({
          device: {
            vendorSiteId: "sheephouse",
            ownerClerkUserId: null,
            id: 14,
          } as never,
        }),
      ),
    ).rejects.toThrow(/no owner/i);
    expect(hubRun).not.toHaveBeenCalled();
  });

  it("refuses when the owner has no stored control passkey (501, not a silent no-op)", async () => {
    getDeviceCredentials.mockResolvedValue({ apiKey: "gk_only" });
    await expect(cap.invoke(ctx())).rejects.toThrow(/no control passkey/i);
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

  // ── preflight — the read-only dry run behind the dialog's Start gate ─────────────────────────

  describe("preflight", () => {
    it("converts minutes to seconds on the SAME seam invoke() uses", async () => {
      await cap.preflight({ ...ctx(), value: 30 });
      expect(hubNoop).toHaveBeenCalledWith("sheephouse", "pk-secret", 1800);
    });

    it("asks about the hub's DEFAULT when the caller names no runtime (or names 0)", async () => {
      // 0 is the command value for STOP, which is not a start decision at all — asking "would a
      // 0-second run be accepted" would produce a meaningless verdict.
      await cap.preflight({ ...ctx(), value: 0 });
      expect(hubNoop).toHaveBeenCalledWith(
        "sheephouse",
        "pk-secret",
        undefined,
      );
      hubNoop.mockClear();
      await cap.preflight({ ...ctx(), value: undefined });
      expect(hubNoop).toHaveBeenCalledWith(
        "sheephouse",
        "pk-secret",
        undefined,
      );
    });

    it("passes the hub's verdict and wouldStart through UNCHANGED", async () => {
      const result = await cap.preflight(ctx());
      expect(result.ok).toBe(true);
      expect(result.wouldProceed).toBe(true);
      // Verbatim: the hub derives it from the same gateStart() a real run consults, so restating
      // it here in our own words could only introduce a disagreement.
      expect(result.verdict).toBe("a 1800s run would START now");
      expect(result.detail).toEqual({
        maxRuntimeSec: 7200,
        latched: false,
        state: "idle",
      });
    });

    it("transcribes ownership + SCF support into the displayable checklist", async () => {
      const { checks } = await cap.preflight(ctx());
      expect(checks).toEqual([
        { label: "Panel mode", value: "Auto", ok: true },
        { label: "Engine", value: "stopped", ok: true },
        { label: "Inverter demand", value: "not calling", ok: true },
        { label: "Module supports", value: "start / cancel", ok: true },
      ]);
    });

    it("🛑 fails the panel-mode check for any mode but Auto — the one thing not overridable remotely", async () => {
      hubNoop.mockResolvedValue({
        ok: true,
        wouldStart: false,
        verdict: "a run would be REFUSED: module is not in Auto (mode=Stop)",
        preflight: {
          ownership: {
            mode: 0,
            modeName: "Stop",
            remoteStartInput: "open",
            running: false,
          },
          scfSupported: {
            selectAuto: true,
            telemetryStart: true,
            telemetryCancel: true,
          },
          scfMap: [],
        },
      });
      const result = await cap.preflight(ctx());
      expect(result.wouldProceed).toBe(false);
      expect(result.checks?.[0]).toEqual({
        label: "Panel mode",
        value: "Stop",
        ok: false,
      });
    });

    it("reports a running engine and an inverter that is calling for it", async () => {
      hubNoop.mockResolvedValue({
        ok: true,
        wouldStart: false,
        verdict: "a run would be REFUSED: engine is already running",
        preflight: {
          ownership: {
            mode: 1,
            modeName: "Auto",
            remoteStartInput: "closed",
            running: true,
          },
          scfSupported: {
            selectAuto: true,
            telemetryStart: true,
            telemetryCancel: true,
          },
          scfMap: [],
        },
      });
      const { checks } = await cap.preflight(ctx());
      expect(checks?.[1]).toEqual({
        label: "Engine",
        value: "running",
        ok: false,
      });
      // Informational, not a gate of its own: the engine row above already carries the refusal.
      expect(checks?.[2]).toEqual({
        label: "Inverter demand",
        value: "calling for the generator",
        ok: null,
      });
    });

    it("🛑 flags a module that cannot CANCEL — a run that could not be stopped", async () => {
      hubNoop.mockResolvedValue({
        ok: true,
        wouldStart: false,
        verdict: "a run would be REFUSED: no fn 33",
        preflight: {
          ownership: {
            mode: 1,
            modeName: "Auto",
            remoteStartInput: "open",
            running: false,
          },
          scfSupported: {
            selectAuto: true,
            telemetryStart: true,
            telemetryCancel: false,
          },
          scfMap: [],
        },
      });
      const { checks } = await cap.preflight(ctx());
      expect(checks?.[3]).toEqual({
        label: "Module supports",
        value: "start / NO CANCEL",
        ok: false,
      });
    });

    it("🛑 REPORTS an unreachable hub rather than throwing — bad news is the answer, not an error", async () => {
      hubNoop.mockRejectedValue(
        new Error(
          "device unreachable: timeout — the hub could not read the controller, so a real run would refuse too",
        ),
      );
      const result = await cap.preflight(ctx());
      expect(result.ok).toBe(false);
      expect(result.wouldProceed).toBeUndefined();
      expect(result.verdict).toMatch(/could not read the controller/);
    });

    it("still THROWS for a configuration failure — a missing passkey is not a state report", async () => {
      getDeviceCredentials.mockResolvedValue({ apiKey: "gk_only" });
      await expect(cap.preflight(ctx())).rejects.toThrow(/no control passkey/i);
      expect(hubNoop).not.toHaveBeenCalled();
    });

    it("refuses a point it has no command for, exactly as invoke() does", async () => {
      await expect(
        cap.preflight({
          ...ctx(),
          point: {
            logicalPath: "source.generator.engine",
            metricType: "speed",
          } as never,
        }),
      ).rejects.toThrow(/no command for/);
      expect(hubNoop).not.toHaveBeenCalled();
    });
  });
});
