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
const hubProbe =
  jest.fn<(siteId: string, passkey: string) => Promise<unknown>>();
jest.mock("../hub-client", () => ({
  hubRun: (...args: [string, string, number]) => hubRun(...args),
  hubProbe: (...args: [string, string]) => hubProbe(...args),
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
    hubProbe.mockReset();
    hubProbe.mockResolvedValue({
      ok: true,
      wouldStart: true,
      verdict: "Ready to start",
      mode: 1,
      modeName: "Auto",
      remoteStartInput: "open",
      running: false,
      scfSupported: {
        selectAuto: true,
        telemetryStart: true,
        telemetryCancel: true,
      },
      scfMap: [0, 0],
      maxRuntimeSec: 7200,
      latched: false,
      state: "idle",
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
    it("🛑 proposes NO runtime, whatever the caller names", async () => {
      // A probe asks about the MOMENT. The only length-sensitive term in a start decision is the
      // hub's cap, and the cap comes back in the answer — so proposing a length would only put a
      // number in a verdict nobody asked about, which is exactly what forced the browser to throw
      // the hub's sentence away and write its own.
      for (const value of [30, 0, undefined]) {
        hubProbe.mockClear();
        await cap.preflight({ ...ctx(), value });
        expect(hubProbe).toHaveBeenCalledWith("sheephouse", "pk-secret");
      }
    });

    it("passes the hub's verdict and wouldStart through UNCHANGED", async () => {
      const result = await cap.preflight(ctx());
      expect(result.ok).toBe(true);
      expect(result.wouldProceed).toBe(true);
      // Verbatim, and this is the central invariant: the hub derives the sentence from the same
      // gateStart() a real run consults, so restating it here in our own words could only
      // introduce a disagreement. The ACCEPTANCE is included — it used to be the exception.
      expect(result.verdict).toBe("Ready to start");
    });

    it("hands the whole probe on as `detail`, flat, minus the verdict fields", async () => {
      // `state` and `modeName` together are everything a caller needs to re-derive the status
      // sentence from this LIVE read instead of from a pushed point that may be a poll behind.
      const result = await cap.preflight(ctx());
      expect(result.detail).toEqual({
        mode: 1,
        modeName: "Auto",
        remoteStartInput: "open",
        running: false,
        scfSupported: {
          selectAuto: true,
          telemetryStart: true,
          telemetryCancel: true,
        },
        scfMap: [0, 0],
        maxRuntimeSec: 7200,
        latched: false,
        state: "idle",
      });
    });

    it("transcribes ownership into the displayable checklist", async () => {
      const { checks } = await cap.preflight(ctx());
      expect(checks).toEqual([
        { label: "Panel mode", value: "Auto", ok: true },
        { label: "Engine", value: "stopped", ok: true },
        { label: "Inverter demand", value: "not calling", ok: true },
      ]);
    });

    it("🛑 fails the panel-mode check for any mode but Auto — the one thing not overridable remotely", async () => {
      hubProbe.mockResolvedValue({
        ok: true,
        wouldStart: false,
        verdict:
          "A run would be refused: the module is not in Auto (mode=Stop) — a possible local lockout at the panel, and not overridable remotely",
        mode: 0,
        modeName: "Stop",
        remoteStartInput: "open",
        running: false,
        scfSupported: {
          selectAuto: true,
          telemetryStart: true,
          telemetryCancel: true,
        },
        scfMap: [],
        latched: false,
        state: "idle",
        maxRuntimeSec: 7200,
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
      hubProbe.mockResolvedValue({
        ok: true,
        wouldStart: false,
        verdict:
          "A run would be refused: the engine is already running, commanded by the SP-PRO (remote-start input closed)",
        mode: 1,
        modeName: "Auto",
        remoteStartInput: "closed",
        running: true,
        scfSupported: {
          selectAuto: true,
          telemetryStart: true,
          telemetryCancel: true,
        },
        scfMap: [],
        latched: false,
        state: "running:sp-pro",
        maxRuntimeSec: 7200,
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

    /**
     * SCF support is not a checklist row — it reads "start / cancel" on every module in service, so
     * a row spends a line on a constant. What must NOT be lost is the failing case, and it isn't:
     * the hub refuses and says why, which is a stronger signal than a red tick because it also
     * disables Start.
     */
    it("🛑 a module that cannot CANCEL still refuses, through the verdict rather than a row", async () => {
      hubProbe.mockResolvedValue({
        ok: true,
        wouldStart: false,
        verdict:
          "A run would be refused: the module does not advertise Cancel Telemetry Start (fn 33), so a run could not be stopped",
        mode: 1,
        modeName: "Auto",
        remoteStartInput: "open",
        running: false,
        scfSupported: {
          selectAuto: true,
          telemetryStart: true,
          telemetryCancel: false,
        },
        scfMap: [],
        latched: false,
        state: "idle",
        maxRuntimeSec: 7200,
      });
      const result = await cap.preflight(ctx());
      expect(result.wouldProceed).toBe(false);
      expect(result.verdict).toContain("could not be stopped");
      expect(result.checks?.map((c) => c.label)).not.toContain(
        "Module supports",
      );
    });

    it("🛑 REPORTS an unreachable hub rather than throwing — bad news is the answer, not an error", async () => {
      hubProbe.mockRejectedValue(
        new Error(
          "The hub could not read the controller: timeout — a run would be refused too.",
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
      expect(hubProbe).not.toHaveBeenCalled();
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
      expect(hubProbe).not.toHaveBeenCalled();
    });
  });
});
