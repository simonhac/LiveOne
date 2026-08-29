/**
 * RunSupervisor — the hub-side owner of a commanded generator run.
 *
 * The DSE's control keys are momentary and parameterless: Telemetry Start (fn 32) is a LATCH the
 * engine runs behind until fn 33 clears it, so "run for N seconds" is whoever holds the latch
 * enforcing a deadline. That holder is this class. The safety invariants live here:
 *
 *  - 🔑 The authority is an ABSOLUTE INSTANT, never a countdown. `runtimeSec` becomes `stopAt`
 *    (epoch ms, persisted ISO) once, at request time. Every timer is a derived wake-up hint
 *    recomputed from `stopAt`; "stop at 17:03:40Z" survives a restart, "180 s remaining" does not.
 *  - Deadline enforcement is doubled: the derived timer AND a 30 s reconcile that stops when
 *    `now >= stopAt`. Neither needs a Modbus read — deadline enforcement is clock + write only.
 *    A monotonic backstop (hrtime-elapsed >= runtime) rides along so an NTP step backward cannot
 *    extend a run within one process lifetime.
 *  - State is persisted (atomically: tmp → fsync → rename) BEFORE the start key is written, and is
 *    NEVER rolled back on a failed start — a timed-out FC16 may still have latched the engine
 *    (frame delivered, response lost). Cleared only after a CONFIRMED fn 33.
 *  - Stop is retried indefinitely (every 15 s, loudly). A failed stop is the only truly bad
 *    outcome; it is never a single best-effort attempt.
 *  - resume(): future `stopAt` → re-arm (a deploy mid-run doesn't cut the run short); past →
 *    stop immediately. Missing/corrupt state with control configured → defensive fn 33 (harmless
 *    when not latched) + a mode check that flags a module stuck in Stop.
 *  - Panel lockout respected: mode ≠ Auto refuses with no override, and Select Auto (fn 1) is
 *    never written as a routine precondition — with input A asserted, fn 1 ALONE starts the engine.
 *  - Never stops a run it didn't start: the only stop this class issues is fn 33, which clears OUR
 *    latch and cannot cancel the SP-PRO's input-A request. Releasing the latch ≠ the engine
 *    stopping, and the two are tracked as distinct facts.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  SourceControl,
  ControlOwnership,
  ControlPreflight,
  Values,
} from "./source";
import type { Manifest } from "./source";
import type { ControlConfig } from "./config";
import type { StructuredMessage } from "./message";

/** Retry cadence for a failed stop, and the passive deadline reconcile. */
export const STOP_RETRY_MS = 15_000;
export const RECONCILE_MS = 30_000;
/** After a confirmed release, the engine cools down (~95 s observed); report "stopping" this long. */
const COOLDOWN_GRACE_MS = 5 * 60_000;

export type ControlState =
  | "idle"
  | "running:hub"
  | "running:sp-pro"
  | "running:other"
  | "stopping"
  | "stop-failing"
  | "latch-released-still-running";

/**
 * The synthetic control-plane points pushed to LiveOne alongside the device registers. Merged into
 * the reading set by tickOnce (NOT produced inside read()) so `stop-failing` still reaches LiveOne
 * during the very Modbus outage that blocks the poll.
 *
 * 🛑 Each entry has a UNIQUE (logicalPathStem, metricType). LiveOne's `points` table enforces
 * uniqueness on (device_id, logical_path, metric_type), and a duplicate fails the ENTIRE batch
 * insert — one careless shared stem takes the whole device's telemetry offline, which is exactly
 * what happened on 2026-08-29 when these five all shared `source.generator.control`.
 */
export const CONTROL_MANIFEST: Manifest = [
  {
    key: "controlRunActive",
    physicalPathTail: "control_run_active",
    logicalPathStem: "source.generator.control.run",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Commanded Run Active",
    subsystem: "generator",
  },
  {
    key: "controlInhibitActive",
    physicalPathTail: "control_inhibit_active",
    logicalPathStem: "source.generator.control.inhibit",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Inhibit Active",
    subsystem: "generator",
  },
  {
    key: "controlStopAt",
    physicalPathTail: "control_stop_at",
    logicalPathStem: "source.generator.control.stop_at",
    metricType: "time",
    metricUnit: "epoch_s",
    defaultName: "Commanded Stop At",
    subsystem: "generator",
  },
  {
    key: "controlState",
    physicalPathTail: "control_state",
    logicalPathStem: "source.generator.control.status",
    metricType: "state",
    metricUnit: "text",
    defaultName: "Control State",
    subsystem: "generator",
  },
  {
    key: "controlLastError",
    physicalPathTail: "control_last_error",
    logicalPathStem: "source.generator.control.error",
    metricType: "state",
    metricUnit: "text",
    defaultName: "Control Last Error",
    subsystem: "generator",
  },
  {
    // The WRITABLE point (LiveOne mints its control descriptor server-side — see
    // lib/control/control-registry.ts; a pusher never asserts its own writability).
    //
    // Value = minutes REMAINING on the commanded run, 0 when idle. Command and readback share one
    // unit deliberately: you set it to 30 to run for 30 minutes, and it counts down to 0. The
    // logicalPathStem + metricType here are the address lib/vendors/deepsea/control.ts dispatches
    // on ("source.generator.control/duration"), so renaming either breaks the command — that pair
    // is a contract, not a label.
    key: "controlRunRequestMin",
    physicalPathTail: "generator_run_request_min",
    logicalPathStem: "source.generator.control.request",
    metricType: "duration",
    metricUnit: "min",
    defaultName: "Generator Run Request",
    subsystem: "generator",
  },
];

/** What resume() finds on disk. `stopAt` is ISO — the absolute instant is the ONLY authority. */
interface PersistedControlState {
  latched: boolean;
  stopAt: string | null;
  requestedAt: string | null;
  /** display/audit only — NEVER used for arithmetic (a countdown doesn't survive a dead process) */
  requestedRuntimeSec: number | null;
  startedByUs: boolean;
}

export interface RunRequestResult {
  ok: boolean;
  /** HTTP-ish status the route maps 1:1 */
  status: 200 | 400 | 409 | 500 | 503;
  action?: "started" | "extended" | "released";
  reason?: string;
  /** `reason`, unrendered, when it carries an instant the reader must spell locally. See message.ts.
   *  The flat `reason` above is always populated too — it is the compatibility leg. */
  reasonMessage?: StructuredMessage;
  stopAt: string | null;
  remainingSec: number | null;
  ownership?: ControlOwnership;
  /** the released-vs-stopped distinction: fn 33 clears OUR latch; input A may keep it running */
  released?: boolean;
  stillRunning?: "remote-start-input" | "unknown" | null;
}

export interface ControlStatus {
  latched: boolean;
  state: ControlState;
  stopAt: string | null;
  remainingSec: number | null;
  requestedAt: string | null;
  lastCommandAt: string | null;
  lastError: string | null;
  maxRuntimeSec: number;
}

/** Injectable clock: wall (ms epoch) + monotonic (ns). Tests drive both. */
export interface ControlClock {
  now(): number;
  mono(): bigint;
}

const realClock: ControlClock = {
  now: () => Date.now(),
  mono: () => process.hrtime.bigint(),
};

export interface RunSupervisorOptions {
  siteId: string;
  target: SourceControl;
  config: ControlConfig;
  /** store root (Fly volume); null = in-memory only, loudly degraded */
  dataDir: string | null;
  log?: (m: string) => void;
  clock?: ControlClock;
}

export class RunSupervisor {
  readonly siteId: string;
  private readonly target: SourceControl;
  private readonly config: ControlConfig;
  private readonly stateFile: string | null;
  private readonly log: (m: string) => void;
  private readonly clock: ControlClock;

  // ── the authoritative state ──────────────────────────────────────────────
  private latched = false;
  private stopAtMs: number | null = null;
  private requestedAt: string | null = null;
  private requestedRuntimeSec: number | null = null;
  /** monotonic backstop: mono() at request + runtime ns; null across restarts (wall clock rules) */
  private monoDeadline: bigint | null = null;

  // ── derived / observational ──────────────────────────────────────────────
  private stopFailing = false;
  private lastError: string | null = null;
  private lastCommandAt: string | null = null;
  private releasedAtMs: number | null = null;
  private lastObs: {
    running: boolean;
    remoteStartInput: ControlOwnership["remoteStartInput"];
    atMs: number;
  } | null = null;

  /** bumped on every state transition — the run loop's edge-triggered-delivery signal */
  stateVersion = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStateString: string | null = null;

  constructor(opts: RunSupervisorOptions) {
    this.siteId = opts.siteId;
    this.target = opts.target;
    this.config = opts.config;
    this.log = opts.log ?? (() => {});
    this.clock = opts.clock ?? realClock;
    this.stateFile = opts.dataDir
      ? path.join(opts.dataDir, "control", `${opts.siteId}.json`)
      : null;
    if (!this.stateFile) {
      this.log(
        `[control] ⚠️ no dataDir — run state is IN-MEMORY ONLY; a restart mid-run loses the deadline`,
      );
    }
    // The passive reconcile: clock + (at worst) a stop write. Never a Modbus read.
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      RECONCILE_MS,
    );
    this.reconcileTimer.unref?.();
  }

  get maxRuntimeSec(): number {
    return this.config.maxRuntimeSec;
  }

  get passkeyEnv(): string {
    return this.config.passkeyEnv;
  }

  // ── request handling ─────────────────────────────────────────────────────

  /**
   * The one entry point: `runtimeSec > 0` starts (or extends) a supervised run; `0` releases our
   * latch. Validation, pre-flight, persistence and the write are all here so the route stays thin.
   */
  async request(
    runtimeSec: number,
    opts: { overrideRemoteStart?: boolean } = {},
  ): Promise<RunRequestResult> {
    if (!Number.isFinite(runtimeSec) || runtimeSec < 0) {
      return this.result({
        ok: false,
        status: 400,
        reason: "runtimeSec must be a non-negative number",
      });
    }
    if (runtimeSec === 0) return this.release("requested");
    if (runtimeSec > this.config.maxRuntimeSec) {
      return this.result({
        ok: false,
        status: 400,
        reason: `runtimeSec ${runtimeSec} exceeds the configured maximum ${this.config.maxRuntimeSec}`,
      });
    }

    // Extension: already latched → recompute stopAt from NOW. (This makes maxRuntimeSec a
    // per-request cap — repeated requests can chain runs. Intended; the response says "extended"
    // so an HTTP retry / double-click is observable rather than silent.)
    if (this.latched) {
      this.setDeadline(runtimeSec);
      await this.persist();
      this.armTimer();
      this.bump("extended");
      return this.result({ ok: true, status: 200, action: "extended" });
    }

    // Pre-flight: FRESH reads, never a cached poll (a decision must not ride on 15 s old data).
    let ownership: ControlOwnership;
    try {
      ownership = await this.target.readOwnership();
    } catch (e) {
      return this.result({
        ok: false,
        status: 503,
        reason: `pre-flight read failed: ${msg(e)} — refusing to command blind`,
      });
    }

    const gate = gateStart(ownership, opts.overrideRemoteStart === true);
    if (gate)
      return this.result({ ok: false, status: 409, reason: gate, ownership });

    // Persist BEFORE the write: a crash between "engine latched" and "state recorded" must not
    // orphan a running engine.
    this.latched = true;
    this.releasedAtMs = null;
    this.stopFailing = false;
    this.setDeadline(runtimeSec);
    this.lastCommandAt = new Date(this.clock.now()).toISOString();
    await this.persist();

    try {
      await this.target.start();
      this.lastError = null;
    } catch (e) {
      // Ambiguous outcome: the FC16 may have been actioned with only the response lost. State is
      // NOT rolled back — stopAt stays armed, the next poll reveals the truth, and the deadline
      // stop fires either way (fn 33 is harmless if the start never took).
      this.lastError = `start write failed (may still have taken effect): ${msg(e)}`;
      this.log(
        `[control] ⚠️ ${this.lastError} — deadline stays armed for ${this.stopAtIso()}`,
      );
      this.armTimer();
      this.bump("start-ambiguous");
      return this.result({
        ok: false,
        status: 500,
        reason: `start may have taken effect (write failed after delivery was possible); a stop is scheduled for ${this.stopAtIso()}`,
        reasonMessage: {
          template:
            "start may have taken effect (write failed after delivery was possible); a stop is scheduled for {stopAt, time, short}",
          values: { stopAt: this.stopAtIso() },
        },
        ownership,
      });
    }

    this.armTimer();
    this.bump("started");
    this.log(
      `[control] ▶ run started — stop at ${this.stopAtIso()} (${runtimeSec}s)`,
    );
    return this.result({ ok: true, status: 200, action: "started", ownership });
  }

  /** Clear OUR latch (fn 33). Never touches anyone else's start request. */
  private async release(why: string): Promise<RunRequestResult> {
    this.log(`[control] ■ releasing telemetry latch (${why})`);
    this.lastCommandAt = new Date(this.clock.now()).toISOString();
    try {
      await this.target.stop();
    } catch (e) {
      // Could not confirm the release — keep everything armed and enter the retry loop.
      this.lastError = `stop write failed: ${msg(e)}`;
      this.stopFailing = true;
      this.log(
        `[control] 🛑 ${this.lastError} — retrying every ${STOP_RETRY_MS / 1000}s`,
      );
      this.scheduleStopRetry();
      this.bump("stop-failed");
      return this.result({
        ok: false,
        status: 500,
        reason: `stop failed (${msg(e)}) — retrying every ${STOP_RETRY_MS / 1000}s until confirmed`,
        released: false,
      });
    }

    // Confirmed: only now is the persisted latch cleared.
    this.latched = false;
    this.stopFailing = false;
    this.lastError = null;
    this.stopAtMs = null;
    this.monoDeadline = null;
    this.requestedAt = null;
    this.requestedRuntimeSec = null;
    this.releasedAtMs = this.clock.now();
    this.clearTimers();
    await this.persist();
    this.bump("released");

    const obs = this.lastObs;
    const stillRunning =
      obs?.running === true
        ? obs.remoteStartInput === "closed"
          ? ("remote-start-input" as const)
          : ("unknown" as const)
        : null;
    if (stillRunning) {
      this.log(
        `[control] released our latch but the engine is still commanded by ${stillRunning} — it will NOT stop until that request clears`,
      );
    }
    return this.result({
      ok: true,
      status: 200,
      action: "released",
      released: true,
      stillRunning,
    });
  }

  /**
   * The `noop` command: exercise the ENTIRE chain — Access, passkey, registry lookup, supervisor,
   * musher's device mutex, Modbus over WireGuard, the DSE itself — and report exactly what a real
   * run would decide, WITHOUT writing anything.
   *
   * It reaches the device only through `target.preflight()`, which is FC3-only; there is no code
   * path from here to `writeControlKey`. The verdict comes from the same `gateStart()` the real
   * request path uses, so this cannot drift into telling you a comforting lie.
   */
  async noop(runtimeSec = 60): Promise<{
    ok: boolean;
    status: 200 | 503;
    preflight?: ControlPreflight;
    wouldStart?: boolean;
    verdict: string;
    /** `verdict`, unrendered, when it carries an instant. See message.ts. */
    verdictMessage?: StructuredMessage;
    status_?: ControlStatus;
  }> {
    let pre: ControlPreflight;
    try {
      pre = await this.target.preflight();
    } catch (e) {
      return {
        ok: false,
        status: 503,
        verdict: `device unreachable: ${msg(e)} — the hub could not read the controller, so a real run would refuse too`,
      };
    }

    const reasons: string[] = [];
    if (runtimeSec > this.config.maxRuntimeSec) {
      reasons.push(
        `runtimeSec ${runtimeSec} exceeds the configured maximum ${this.config.maxRuntimeSec}`,
      );
    }
    const gate = gateStart(pre.ownership, false);
    if (gate) reasons.push(gate);
    if (!pre.scfSupported.telemetryStart)
      reasons.push("the module does not advertise Telemetry Start (fn 32)");
    if (!pre.scfSupported.telemetryCancel)
      reasons.push(
        "the module does not advertise Cancel Telemetry Start (fn 33) — a run could not be stopped",
      );

    const wouldStart = reasons.length === 0 && !this.latched;
    return {
      ok: true,
      status: 200,
      preflight: pre,
      wouldStart,
      verdict: this.latched
        ? `a run is already latched (stop at ${this.stopAtIso()}); a request would EXTEND it`
        : wouldStart
          ? `a ${runtimeSec}s run would START now`
          : `a run would be REFUSED: ${reasons.join("; ")}`,
      // Only the latched verdict names an instant, so only it needs spelling by the reader.
      verdictMessage: this.latched
        ? {
            template:
              "a run is already latched (stop at {stopAt, time, short}); a request would EXTEND it",
            values: { stopAt: this.stopAtIso() },
          }
        : undefined,
    };
  }

  // ── deadline machinery ───────────────────────────────────────────────────

  private setDeadline(runtimeSec: number): void {
    const now = this.clock.now();
    this.stopAtMs = now + runtimeSec * 1000;
    this.requestedAt = new Date(now).toISOString();
    this.requestedRuntimeSec = runtimeSec; // audit only
    this.monoDeadline =
      this.clock.mono() + BigInt(Math.round(runtimeSec * 1e9));
  }

  /** (Re)arm the derived wake-up hint from stopAt. Never the source of truth. */
  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopAtMs == null) return;
    const delay = Math.max(0, this.stopAtMs - this.clock.now());
    this.timer = setTimeout(() => void this.reconcile(), delay);
    this.timer.unref?.();
  }

  /**
   * The doubled enforcement: called by the derived timer, the 30 s interval, and tests. Purely
   * clock + write — no Modbus reads. Stops iff the wall deadline OR the monotonic backstop has
   * passed (whichever fires first wins; an NTP step backward cannot extend a run).
   */
  async reconcile(): Promise<void> {
    if (!this.latched || this.stopAtMs == null) return;
    const wallDue = this.clock.now() >= this.stopAtMs;
    const monoDue =
      this.monoDeadline != null && this.clock.mono() >= this.monoDeadline;
    if (wallDue || monoDue) {
      await this.release(wallDue ? "deadline reached" : "monotonic backstop");
    }
  }

  private scheduleStopRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopFailing) void this.release("stop retry");
    }, STOP_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Tear down interval + timers (tests / shutdown). */
  dispose(): void {
    this.clearTimers();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  /**
   * Recover after a restart. The persisted `stopAt` is the only authority:
   *  - future → re-arm and stop at the ORIGINALLY intended time (a deploy mid-run doesn't cut the
   *    run short);
   *  - past → stop immediately (the hub was down through the deadline);
   *  - missing/corrupt → defensive: fn 33 (harmless when not latched) + a mode check that flags a
   *    module inexplicably sitting in Stop, the signature of a crash mid-inhibit.
   */
  async resume(): Promise<void> {
    let state: PersistedControlState | null = null;
    let readable = false;
    if (this.stateFile) {
      try {
        const raw = await fs.readFile(this.stateFile, "utf8");
        state = JSON.parse(raw) as PersistedControlState;
        readable = true;
      } catch (e) {
        const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
        if (!missing)
          this.log(
            `[control] ⚠️ state file unreadable (${msg(e)}) — treating as unknown`,
          );
      }
    }

    if (readable && state && typeof state.latched === "boolean") {
      if (state.latched && state.stopAt) {
        const stopAtMs = Date.parse(state.stopAt);
        if (Number.isFinite(stopAtMs)) {
          this.latched = true;
          this.stopAtMs = stopAtMs;
          this.requestedAt = state.requestedAt;
          this.requestedRuntimeSec = state.requestedRuntimeSec;
          this.monoDeadline = null; // the wall instant rules across restarts
          if (stopAtMs > this.clock.now()) {
            this.log(
              `[control] resume: run in progress, stop at ${state.stopAt} — re-armed`,
            );
            this.armTimer();
          } else {
            this.log(
              `[control] resume: deadline ${state.stopAt} passed while down — stopping now`,
            );
            await this.release("resume: deadline passed while hub was down");
          }
          this.bump("resumed");
          return;
        }
        this.log(
          `[control] ⚠️ persisted stopAt unparseable (${state.stopAt}) — falling through to defensive path`,
        );
      } else {
        // Clean idle state — nothing to do.
        return;
      }
    }

    // Unknown state (first boot, corrupt file, unparseable deadline). Defensive: clear any latch we
    // might hold (harmless otherwise), and look for a module stuck in Stop.
    this.log(
      `[control] resume: no readable state — defensive fn 33 + mode check`,
    );
    try {
      await this.target.stop();
    } catch (e) {
      this.lastError = `defensive stop at boot failed: ${msg(e)}`;
      this.log(`[control] ⚠️ ${this.lastError}`);
    }
    try {
      const own = await this.target.readOwnership();
      if (own.mode === 0) {
        this.lastError =
          "module is in STOP mode at boot with no persisted reason — auto-start is DISABLED; check the panel (possible crash mid-inhibit)";
        this.log(`[control] 🛑 ${this.lastError}`);
      }
    } catch {
      /* device unreachable at boot — the collector's polls will surface it */
    }
    await this.persist();
    this.bump("resumed-defensive");
  }

  // ── persistence ──────────────────────────────────────────────────────────

  /** Atomic: tmp → fsync → rename. The spool is designed to fill this volume to 75 %. */
  private async persist(): Promise<void> {
    if (!this.stateFile) return;
    const state: PersistedControlState = {
      latched: this.latched,
      stopAt: this.stopAtIso(),
      requestedAt: this.requestedAt,
      requestedRuntimeSec: this.requestedRuntimeSec,
      startedByUs: this.latched,
    };
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      const fh = await fs.open(tmp, "w");
      try {
        await fh.writeFile(JSON.stringify(state, null, 2));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, this.stateFile);
    } catch (e) {
      // A persistence failure must not block the command path — but it must be LOUD, because it
      // reopens the restart hole the file exists to close.
      this.log(`[control] 🛑 could not persist control state: ${msg(e)}`);
    }
  }

  // ── observation + reporting ──────────────────────────────────────────────

  /**
   * Fed by the run loop after each successful poll. This is how the supervisor knows whether the
   * engine ACTUALLY stopped after a release (fn 33 clears only our latch — input A can keep it
   * running), without issuing reads of its own.
   */
  noteObservation(obs: {
    running: boolean;
    remoteStartInput: ControlOwnership["remoteStartInput"];
  }): void {
    this.lastObs = { ...obs, atMs: this.clock.now() };
    if (!obs.running && this.releasedAtMs != null) this.releasedAtMs = null; // stop confirmed
    this.bumpIfStateChanged();
  }

  /** Adapter for the run loop: extract the observation from a poll's Values (musher's derived keys). */
  observeValues(values: Values): void {
    const rsi = values.remoteStartInput;
    this.noteObservation({
      running:
        Number(values.engineRpm ?? 0) > 0 || Number(values.genFreqHz ?? 0) > 0,
      remoteStartInput: rsi == null ? "unknown" : rsi ? "closed" : "open",
    });
  }

  state(): ControlState {
    if (this.stopFailing) return "stop-failing";
    if (this.latched) return "running:hub";
    if (this.lastObs?.running) {
      if (this.releasedAtMs != null) {
        return this.clock.now() - this.releasedAtMs < COOLDOWN_GRACE_MS
          ? "stopping"
          : "latch-released-still-running";
      }
      return this.lastObs.remoteStartInput === "closed"
        ? "running:sp-pro"
        : "running:other";
    }
    return "idle";
  }

  status(): ControlStatus {
    return {
      latched: this.latched,
      state: this.state(),
      stopAt: this.stopAtIso(),
      remainingSec: this.remainingSec(),
      requestedAt: this.requestedAt,
      lastCommandAt: this.lastCommandAt,
      lastError: this.lastError,
      maxRuntimeSec: this.config.maxRuntimeSec,
    };
  }

  /** The synthetic points (CONTROL_MANIFEST keys). Available even when the device read failed. */
  syntheticValues(): Values {
    return {
      controlRunActive: this.latched ? 1 : 0,
      controlInhibitActive: 0, // inhibit is a designed-but-deferred state; see docs/plans/dse-inhibit-command.md
      controlStopAt:
        this.stopAtMs != null ? Math.round(this.stopAtMs / 1000) : null,
      controlState: this.state(),
      controlLastError: this.lastError,
      // Minutes remaining, rounded UP so a run with 20 s left reads 1 rather than 0 — 0 is the
      // command value for "stop" and must mean "no run in progress", never "nearly done".
      controlRunRequestMin:
        this.remainingSec() != null
          ? Math.ceil((this.remainingSec() as number) / 60)
          : 0,
    };
  }

  private remainingSec(): number | null {
    if (!this.latched || this.stopAtMs == null) return null;
    return Math.max(0, Math.round((this.stopAtMs - this.clock.now()) / 1000));
  }

  private stopAtIso(): string | null {
    return this.stopAtMs != null ? new Date(this.stopAtMs).toISOString() : null;
  }

  private result(
    partial: Omit<RunRequestResult, "stopAt" | "remainingSec"> &
      Partial<RunRequestResult>,
  ): RunRequestResult {
    return {
      stopAt: this.stopAtIso(),
      remainingSec: this.remainingSec(),
      ...partial,
    };
  }

  private bump(_why: string): void {
    this.stateVersion++;
    this.lastStateString = this.state();
  }

  private bumpIfStateChanged(): void {
    const s = this.state();
    if (s !== this.lastStateString) {
      this.lastStateString = s;
      this.stateVersion++;
    }
  }
}

/**
 * The start gate, shared by the real request path and `noop` so the two can never disagree.
 * Returns a refusal reason, or null when a start may proceed.
 *
 * Panel lockout: mode ≠ Auto means someone may have deliberately taken the module out of service
 * (refuelling, hands in the engine bay). No override is offered — remote requests do not get to
 * force a module back to Auto; with input A asserted, the fn 1 write ALONE would start the engine
 * before any of our bookkeeping existed.
 */
export function gateStart(
  ownership: ControlOwnership,
  overrideRemoteStart: boolean,
): string | null {
  if (ownership.mode !== 1) {
    return `module is not in Auto (mode=${ownership.modeName ?? ownership.mode ?? "unreadable"}) — possible local lockout; not overridable remotely`;
  }
  if (ownership.running && !overrideRemoteStart) {
    const who =
      ownership.remoteStartInput === "closed"
        ? "the SP-PRO (remote-start input closed)"
        : "an unknown source (remote-start input open — possibly its cool-down tail)";
    return `engine is already running, commanded by ${who}. Pass overrideRemoteStart to layer our latch on top — note our stop can only release OUR latch, never theirs.`;
  }
  return null;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
