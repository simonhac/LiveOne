/**
 * RunSupervisor — the safety invariants, pinned.
 *
 * These tests use a fake ControlClock (no fake timers for the deadline itself: enforcement is
 * exercised through reconcile(), the same method the derived timer and the 30 s interval call —
 * the timers are wake-up hints, reconcile() is the authority) and a fake ControlTarget in place
 * of the Modbus device. State files live in a real tmpdir so persistence/resume is tested for real.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { RunSupervisor, type ControlClock } from "../control";
import type {
  SourceControl,
  ControlOwnership,
  ControlPreflight,
} from "../source";

class FakeClock implements ControlClock {
  wallMs = 1_000_000_000_000; // arbitrary epoch
  monoNs = BigInt(0);
  now(): number {
    return this.wallMs;
  }
  mono(): bigint {
    return this.monoNs;
  }
  /** advance both clocks together (the normal passage of time) */
  tick(ms: number): void {
    this.wallMs += ms;
    this.monoNs += BigInt(ms) * BigInt(1_000_000);
  }
}

class FakeTarget implements SourceControl {
  starts = 0;
  stops = 0;
  failStart = false;
  failStop = false;
  ownership: ControlOwnership = {
    mode: 1,
    modeName: "Auto",
    remoteStartInput: "open",
    running: false,
  };
  ownershipError: Error | null = null;

  async start(): Promise<void> {
    this.starts++;
    if (this.failStart) throw new Error("write timeout");
  }
  async stop(): Promise<void> {
    this.stops++;
    if (this.failStop) throw new Error("write timeout");
  }
  async readOwnership(): Promise<ControlOwnership> {
    if (this.ownershipError) throw this.ownershipError;
    return this.ownership;
  }
  async preflight(): Promise<ControlPreflight> {
    if (this.ownershipError) throw this.ownershipError;
    return {
      ownership: this.ownership,
      scfMap: [0xffff, 0xffff, 0, 0, 0, 0, 0, 0],
      scfSupported: this.scf,
    };
  }
  scf = { selectAuto: true, telemetryStart: true, telemetryCancel: true };
}

const CONFIG = { passkeyEnv: "TEST_CONTROL_KEY", maxRuntimeSec: 3600 };

describe("RunSupervisor", () => {
  let dir: string;
  let clock: FakeClock;
  let target: FakeTarget;
  let sup: RunSupervisor;

  function make(
    overrides: Partial<{ dataDir: string | null }> = {},
  ): RunSupervisor {
    return new RunSupervisor({
      siteId: "testsite",
      target,
      config: CONFIG,
      dataDir: overrides.dataDir === undefined ? dir : overrides.dataDir,
      clock,
    });
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "usher-control-"));
    clock = new FakeClock();
    target = new FakeTarget();
    sup = make();
  });

  afterEach(async () => {
    sup.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects a runtime above the configured maximum, naming the max", async () => {
    const r = await sup.request(CONFIG.maxRuntimeSec + 1);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.reason).toContain(String(CONFIG.maxRuntimeSec));
    expect(target.starts).toBe(0);
  });

  it("starts a run: pre-flight, latch, absolute stopAt", async () => {
    const r = await sup.request(600);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("started");
    expect(target.starts).toBe(1);
    expect(r.stopAt).toBe(new Date(clock.wallMs + 600_000).toISOString());
    expect(r.remainingSec).toBe(600);
    expect(sup.status().state).toBe("running:hub");
  });

  it("runtimeSec 0 releases the latch (fn 33) even when not latched — harmless and idempotent", async () => {
    const r = await sup.request(0);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("released");
    expect(target.stops).toBe(1);
  });

  it("a second request extends: stopAt recomputed from now, no second start write", async () => {
    await sup.request(600);
    clock.tick(300_000);
    const r = await sup.request(600);
    expect(r.action).toBe("extended");
    expect(target.starts).toBe(1); // no second fn 32
    expect(r.stopAt).toBe(new Date(clock.wallMs + 600_000).toISOString());
  });

  it("the deadline fires the stop (reconcile is the authority, not the timer)", async () => {
    await sup.request(600);
    clock.tick(599_000);
    await sup.reconcile();
    expect(target.stops).toBe(0); // not yet
    clock.tick(2_000);
    await sup.reconcile();
    expect(target.stops).toBe(1);
    expect(sup.status().latched).toBe(false);
  });

  it("the monotonic backstop stops the run even if the wall clock stepped backwards", async () => {
    await sup.request(600);
    // NTP steps the wall clock back 10 minutes; monotonic time still advances past the runtime.
    clock.wallMs -= 600_000;
    clock.monoNs += BigInt(601) * BigInt(1_000_000_000);
    await sup.reconcile();
    expect(target.stops).toBe(1);
  });

  it("mode ≠ Auto refuses with no override (panel lockout)", async () => {
    target.ownership = {
      mode: 0,
      modeName: "Stop",
      remoteStartInput: "open",
      running: false,
    };
    const r = await sup.request(600);
    expect(r.status).toBe(409);
    expect(r.reason).toContain("Auto");
    expect(target.starts).toBe(0);
  });

  it("already running (input A closed) yields 409 unless overridden", async () => {
    target.ownership = {
      mode: 1,
      modeName: "Auto",
      remoteStartInput: "closed",
      running: true,
    };
    const refused = await sup.request(600);
    expect(refused.status).toBe(409);
    expect(refused.reason).toContain("SP-PRO");
    expect(target.starts).toBe(0);

    const forced = await sup.request(600, { overrideRemoteStart: true });
    expect(forced.ok).toBe(true);
    expect(target.starts).toBe(1);
  });

  it("a failed pre-flight read refuses to command blind (503)", async () => {
    target.ownershipError = new Error("modbus timeout");
    const r = await sup.request(600);
    expect(r.status).toBe(503);
    expect(target.starts).toBe(0);
  });

  it("a failed START never rolls back state — the deadline stays armed (ambiguous write)", async () => {
    target.failStart = true;
    const r = await sup.request(600);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.reason).toContain("may have taken effect");
    // The latch is still recorded and the deadline still enforced:
    expect(sup.status().latched).toBe(true);
    clock.tick(601_000);
    await sup.reconcile();
    expect(target.stops).toBe(1);
  });

  it("a failed STOP keeps everything armed and reports the retry loop", async () => {
    await sup.request(600);
    target.failStop = true;
    clock.tick(601_000);
    await sup.reconcile();
    expect(sup.status().state).toBe("stop-failing");
    expect(sup.status().latched).toBe(true); // never cleared without a CONFIRMED stop
    // The retry path succeeds later:
    target.failStop = false;
    await sup.reconcile();
    expect(sup.status().latched).toBe(false);
  });

  it("released ≠ stopped: input A can keep the engine running after our latch clears", async () => {
    await sup.request(600);
    sup.observeValues({ engineRpm: 1500, genFreqHz: 500, remoteStartInput: 1 });
    const r = await sup.request(0);
    expect(r.ok).toBe(true);
    expect(r.released).toBe(true);
    expect(r.stillRunning).toBe("remote-start-input");
  });

  it("state machine: sp-pro run is visible without any latch of ours", () => {
    sup.observeValues({ engineRpm: 1500, genFreqHz: 500, remoteStartInput: 1 });
    expect(sup.status().state).toBe("running:sp-pro");
    sup.observeValues({ engineRpm: 0, genFreqHz: 0, remoteStartInput: 0 });
    expect(sup.status().state).toBe("idle");
  });

  describe("restart / resume — the countdown-vs-instant invariant", () => {
    it("future stopAt: a fresh supervisor from the same file stops at the ORIGINAL instant", async () => {
      await sup.request(600);
      clock.tick(300_000);
      sup.dispose(); // hub "restarts"; state only on disk now

      const sup2 = make();
      await sup2.resume();
      expect(sup2.status().latched).toBe(true);
      expect(sup2.status().remainingSec).toBe(300); // NOT 600 — the instant survived, not the countdown
      clock.tick(301_000);
      await sup2.reconcile();
      expect(target.stops).toBe(1);
      sup2.dispose();
    });

    it("past stopAt: stops immediately on resume (hub was down through the deadline)", async () => {
      await sup.request(600);
      sup.dispose();
      clock.tick(3_600_000); // down for an hour

      const sup2 = make();
      await sup2.resume();
      expect(target.stops).toBe(1);
      expect(sup2.status().latched).toBe(false);
      sup2.dispose();
    });

    it("corrupt state file: defensive fn 33 + mode check, flags a module stuck in Stop", async () => {
      await fs.mkdir(path.join(dir, "control"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "control", "testsite.json"),
        "{not json!",
      );
      target.ownership = {
        mode: 0,
        modeName: "Stop",
        remoteStartInput: "open",
        running: false,
      };

      const sup2 = make();
      await sup2.resume();
      expect(target.stops).toBe(1); // defensive release
      expect(sup2.status().lastError).toContain("STOP mode");
      sup2.dispose();
    });

    it("missing state file (first boot): defensive fn 33, no error when the module is in Auto", async () => {
      const sup2 = make();
      await sup2.resume();
      expect(target.stops).toBe(1);
      expect(sup2.status().lastError).toBeNull();
      sup2.dispose();
    });

    it("clean idle state on disk: resume does nothing (no defensive writes)", async () => {
      await sup.request(0); // persists an idle state
      const stopsAfterRelease = target.stops;
      sup.dispose();

      const sup2 = make();
      await sup2.resume();
      expect(target.stops).toBe(stopsAfterRelease); // no defensive fn 33 — the state was readable
      sup2.dispose();
    });
  });

  describe("noop — the safe end-to-end probe", () => {
    it("writes NOTHING and reports that a run would start", async () => {
      const r = await sup.noop(120);
      expect(r.ok).toBe(true);
      expect(r.wouldStart).toBe(true);
      expect(r.verdict).toContain("would START");
      expect(target.starts).toBe(0);
      expect(target.stops).toBe(0); // the whole point
      expect(r.preflight?.scfSupported.telemetryStart).toBe(true);
    });

    it("predicts the SAME refusal the real request path gives (shared gate)", async () => {
      target.ownership = {
        mode: 0,
        modeName: "Stop",
        remoteStartInput: "open",
        running: false,
      };
      const probe = await sup.noop(120);
      const real = await sup.request(120);
      expect(probe.wouldStart).toBe(false);
      expect(probe.verdict).toContain("not in Auto");
      expect(real.reason).toContain("not in Auto"); // same wording, one implementation
      expect(target.starts).toBe(0);
    });

    it("flags an over-max hypothetical runtime without touching the device state", async () => {
      const r = await sup.noop(CONFIG.maxRuntimeSec + 1);
      expect(r.wouldStart).toBe(false);
      expect(r.verdict).toContain(String(CONFIG.maxRuntimeSec));
    });

    it("reports an unreachable device as a 503, exactly as a real run would refuse", async () => {
      target.ownershipError = new Error("connect ETIMEDOUT");
      const r = await sup.noop();
      expect(r.status).toBe(503);
      expect(r.verdict).toContain("unreachable");
    });

    it("says a latched run would be EXTENDED rather than started", async () => {
      await sup.request(600);
      const r = await sup.noop(120);
      expect(r.verdict).toContain("EXTEND");
      expect(r.wouldStart).toBe(false);
    });

    it("warns when the module does not advertise the stop function", async () => {
      target.scf = {
        selectAuto: true,
        telemetryStart: true,
        telemetryCancel: false,
      };
      const r = await sup.noop(120);
      expect(r.wouldStart).toBe(false);
      expect(r.verdict).toContain("could not be stopped");
    });
  });

  describe("synthetic control points", () => {
    it("carries the latch, the absolute stop instant, and the state string", async () => {
      await sup.request(600);
      const v = sup.syntheticValues();
      expect(v.controlRunActive).toBe(1);
      expect(v.controlStopAt).toBe(Math.round((clock.wallMs + 600_000) / 1000));
      expect(v.controlState).toBe("running:hub");
      expect(v.controlLastError).toBeNull();
    });

    it("stateVersion bumps on command edges (the delivery trigger)", async () => {
      const v0 = sup.stateVersion;
      await sup.request(600);
      expect(sup.stateVersion).toBeGreaterThan(v0);
      const v1 = sup.stateVersion;
      await sup.request(0);
      expect(sup.stateVersion).toBeGreaterThan(v1);
    });
  });
});
