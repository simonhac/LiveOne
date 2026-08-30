/**
 * The generator control plane's PURE layer: which latest-map points it reads, and what each hub
 * state is called in words.
 *
 * Lives in `lib/` rather than beside the tile and dialog that consume it for the reason
 * `lib/control/point-ref.ts` gives in its own header — `components/` is not a jest root
 * (`jest.config.js` roots: lib/app/scripts/packages), so a test placed there would silently never
 * run. This is the module where a wrong word about a running diesel engine would live, so it is the
 * one that most needs to be tested.
 *
 * 🛑 THE STATE VOCABULARY IS THE HUB'S, AND IS NEVER RE-DERIVED HERE. `source.generator.control.
 * status/state` carries `RunSupervisor.state()` verbatim (packages/usher/core/control.ts), which
 * already distinguishes the four things a human actually needs to tell apart: we are running it, the
 * INVERTER is running it, we let go and it is cooling down, and we let go and it did NOT stop.
 * Reconstructing that client-side from rpm + relays would be a second, lower-quality opinion that is
 * free to disagree with the hub's — and the hub's is the one holding the latch.
 */
import { pointIdOf } from "./point-ref";

// --- the points ------------------------------------------------------------------------------

/** Minutes remaining on a commanded run, and the ONLY writable point here (0 = stop). */
export const GENERATOR_RUN_REQUEST_PATH =
  "source.generator.control.request/duration";
/** `RunSupervisor.state()` as text — the state vocabulary below. */
export const GENERATOR_STATUS_PATH = "source.generator.control.status/state";
/** The commanded run's absolute deadline, epoch SECONDS. See `runMinutesLeft`. */
export const GENERATOR_STOP_AT_PATH = "source.generator.control.stop_at/time";
/** The supervisor's last error, as text. Empty/absent when healthy. */
export const GENERATOR_ERROR_PATH = "source.generator.control.error/state";
/** DSE control/operating mode as text — "Auto", "Stop", "Manual"… */
export const GENERATOR_MODE_PATH = "source.generator.mode/state";
/**
 * Engine speed, rpm — the one number that says the engine is actually turning, independently of
 * anything the hub believes.
 *
 * 🛑 TWO PATHS, MOST-CORRECT FIRST, AND BOTH ARE LIVE. `points` rows are looked up by
 * `physical_path` (`engine_rpm`) — see `PointManager.ensurePointInfo` — and the only field the
 * drift-heal repairs on an existing row is `control`. So when #150 renamed this signal's
 * `logicalPathStem` from `generator.engine` to `source.generator.engine` in the musher manifest, the
 * ALREADY-MINTED row kept its old `logical_path` and kept receiving the data. On prod today the
 * readings arrive at `generator.engine/speed`; the manifest-correct path does not exist.
 *
 * A single path would therefore be wrong for one environment or the other. Read both until the point
 * rows are migrated, at which point the legacy entry can be deleted and nothing else changes.
 * This is the same class of half-done rename as a card `type` inside `dashboards.doc` (CLAUDE.md),
 * except the persisted copy is a `points` row.
 */
export const GENERATOR_RPM_PATHS = [
  "source.generator.engine/speed",
  "generator.engine/speed",
] as const;

/** Alternator output frequency, Hz. Same two-path story as {@link GENERATOR_RPM_PATHS}. */
export const GENERATOR_HZ_PATHS = [
  "source.generator.output/frequency",
  "generator.output/frequency",
] as const;

/** The derived run-detector point, whose `sourceSystemId` names the device that owns the runs. */
export const GENERATOR_RUNNING_PATH = "source.generator/running";

/**
 * The paths the tile's control would COMMAND, most specific first — what `datumCanControlPoint`
 * uses to gate the cog on ownership of the DEVICE that would be commanded, rather than on the area
 * the tile happened to fetch under. See components/dashboard/tiles/types.ts `controlPaths`.
 */
export const GENERATOR_CONTROL_PATHS = [GENERATOR_RUN_REQUEST_PATH] as const;

/**
 * The first of `paths` that the latest map actually carries, or null. For a signal whose logical
 * path has been renamed without its stored `points` row being migrated — see
 * {@link GENERATOR_RPM_PATHS}.
 */
export function firstPresentPath(
  latest: Record<string, unknown> | null | undefined,
  paths: readonly string[],
): string | null {
  if (!latest) return null;
  return paths.find((p) => latest[p] != null) ?? null;
}

/** The `pt_` TypeID of the run-request point, or null when KV has not seen it yet. */
export function generatorRunRequestTarget(
  latest: Parameters<typeof pointIdOf>[0],
): string | null {
  return pointIdOf(latest, GENERATOR_RUN_REQUEST_PATH);
}

// --- the state vocabulary --------------------------------------------------------------------

/** `RunSupervisor.ControlState`, as it arrives over the wire. */
export type GeneratorControlState =
  | "idle"
  | "running:hub"
  | "running:sp-pro"
  | "running:other"
  | "stopping"
  | "stop-failing"
  | "latch-released-still-running";

export interface GeneratorStatusCopy {
  /**
   * The tile's HERO word — what the generator is, in one glance. Short by construction: it sits in
   * the same slot as the Grid tile's "Idle" and the Battery tile's "67.8%".
   */
  label: string;
  /** The qualifying line under the hero ("Inverter request"), or null when the hero says it all. */
  detail: string | null;
  /**
   * `commanded` = this run is ours and the hub is holding the deadline (the one amber state);
   * `running` = it is running, but not at our request; `warning` = something needs a human.
   */
  tone: "idle" | "running" | "commanded" | "warning";
  /** True ⇒ a run of ours is in progress, so the dialog shows Extend/Stop rather than Start. */
  isCommandedRun: boolean;
  /** True ⇒ the engine is turning (or cooling), so the rpm/Hz row is worth showing. */
  isRunning: boolean;
}

const UNKNOWN: GeneratorStatusCopy = {
  label: "—",
  detail: "No status reported",
  tone: "idle",
  isCommandedRun: false,
  isRunning: false,
};

/**
 * Crank-disconnect speed, rpm — below this the starter motor may still be doing the work, and the
 * engine is STARTING rather than running.
 *
 * 500 is the conventional threshold for a 1500 rpm genset. The hub's own `running` flag is
 * deliberately a different, looser test (`rpm > 0 || hz > 0`, four places in packages/usher): it
 * feeds SAFETY decisions — "is something already turning that our start would collide with", "did
 * the engine actually stop after we let go" — where any shaft motion must count. This constant is
 * about what to CALL the state on screen, which is a different question, so the two are not shared.
 */
export const CRANK_RPM = 500;

/**
 * The first seconds of a run of ours: latched, but the engine has not reached crank-disconnect.
 *
 * The hub reports `running:hub` the instant it closes the latch, which is correct — it IS holding a
 * run request — but the tile was rendering the hero "Running" over an `Engine 0 rpm 0.0 Hz` row.
 * Both facts were true and together they read as a fault.
 */
const STARTING: GeneratorStatusCopy = {
  label: "Starting",
  detail: "LiveOne request",
  tone: "commanded",
  isCommandedRun: true,
  // True: the engine is being started, so the vitals row is worth showing — watching rpm climb is
  // precisely the point of naming this state.
  isRunning: true,
};

/**
 * 🛑 IDLE IS NOT ONE STATE, and this is the distinction the whole vocabulary turns on. A stopped
 * generator whose panel is in Auto is ARMED — it will start on its own when the inverter calls for
 * it. A stopped generator whose panel is in Stop is LOCKED OUT: nothing, local or remote, will
 * start it, and no remote request can override that (see `gateStart` on the hub). Rendering both as
 * "Off" would hide the difference between a site with backup power and a site without it, which is
 * the single most consequential fact this tile carries. So `idle` resolves against the panel mode
 * below rather than having a fixed entry here.
 */
const COPY: Record<
  Exclude<GeneratorControlState, "idle">,
  GeneratorStatusCopy
> = {
  "running:hub": {
    label: "Running",
    detail: "LiveOne request",
    tone: "commanded",
    isCommandedRun: true,
    isRunning: true,
  },
  "running:sp-pro": {
    label: "Running",
    // 🛑 The detail line is load-bearing, not decoration: this run is the INVERTER's, and our Stop
    // cannot end it — fn 33 clears only OUR latch. A bare "Running" would imply a Stop button that
    // works on it, and `isCommandedRun: false` below is what actually withholds that button.
    detail: "Inverter request",
    tone: "running",
    isCommandedRun: false,
    isRunning: true,
  },
  "running:other": {
    label: "Running",
    detail: null,
    tone: "running",
    isCommandedRun: false,
    isRunning: true,
  },
  stopping: {
    label: "Cooling",
    detail: "Request released",
    tone: "running",
    isCommandedRun: false,
    isRunning: true,
  },
  "stop-failing": {
    label: "Stop failing",
    // The one truly bad outcome — and the detail is what keeps it from reading as abandonment: the
    // hub retries every 15 s indefinitely, which is the difference between "something is broken"
    // and "something is broken and is being handled".
    detail: "Hub is retrying",
    tone: "warning",
    // We still hold the latch, so the dialog must offer Stop rather than Start.
    isCommandedRun: true,
    isRunning: true,
  },
  "latch-released-still-running": {
    label: "Running",
    // Just "Released": the tile appends the elapsed clause to this line ("Released, running
    // 76 min"), so saying "still running" here as well produced "Released, still running, running
    // 76 min". The fact survives — the time clause is what states it.
    detail: "Released",
    // 🛑 Released ≠ stopped: we let go and it kept turning past the cool-down grace, so something
    // else is commanding it. That is a state needing a human, hence `warning` rather than the
    // ordinary `running`.
    tone: "warning",
    isCommandedRun: false,
    isRunning: true,
  },
};

const AUTO: GeneratorStatusCopy = {
  label: "Auto",
  detail: "Ready to start",
  tone: "idle",
  isCommandedRun: false,
  isRunning: false,
};

const LOCKED_OUT: GeneratorStatusCopy = {
  label: "Locked out",
  detail: "Panel not in Auto",
  tone: "warning",
  isCommandedRun: false,
  isRunning: false,
};

/**
 * What the generator is doing, in words, from the hub's state and the DSE's panel mode.
 *
 * An unrecognised state claims nothing rather than guessing. The panel mode only decides the IDLE
 * case: a turning engine is a turning engine whatever the panel says, and "Running" is the more
 * urgent fact — the lockout still rides along on the `lockedOut` flag for the caller to append.
 */
export function describeGeneratorState(
  state: string | null | undefined,
  mode?: string | null,
  opts?: {
    /**
     * Engine speed, rpm, when the caller has it. Splits a commanded run into STARTING and RUNNING —
     * see {@link CRANK_RPM}. Omitted or null ⇒ "Running", because a phase we cannot see is one we
     * must not claim.
     */
    rpm?: number | null;
  },
): GeneratorStatusCopy {
  if (!state) return UNKNOWN;
  if (state === "idle") {
    // Mode unknown (the point has not arrived) is NOT the same as "in Auto" — claiming a generator
    // is armed when we cannot see the panel would be the one lie that matters here.
    //
    // 🛑 "Stopped", not "Off". Both describe the ENGINE, which the hub's `idle` positively tells us
    // is not turning — the unknown is the PANEL, i.e. whether this stopped generator is armed to
    // start on its own or locked out of starting at all. "Off" leans toward "switched off / out of
    // service", which is what LOCKED_OUT means, so it quietly asserts the very thing we cannot see.
    // "Stopped" states what is known and stops there; the blank detail line is the withheld claim.
    if (mode == null) return { ...AUTO, label: "Stopped", detail: null };
    return panelIsAuto(mode) ? AUTO : LOCKED_OUT;
  }
  // 🛑 OUR run only. `running:sp-pro` and `running:other` are runs we did not start and whose start
  // instant we do not know, so a low rpm there is as likely to be a cool-down tail as a start —
  // calling it "Starting" would be a guess. For `running:hub` the latch tells us the run began just
  // now, which is what makes the inference sound.
  if (
    state === "running:hub" &&
    opts?.rpm != null &&
    Number.isFinite(opts.rpm) &&
    opts.rpm < CRANK_RPM
  ) {
    return STARTING;
  }
  return COPY[state as Exclude<GeneratorControlState, "idle">] ?? UNKNOWN;
}

// --- derivations -----------------------------------------------------------------------------

/**
 * Minutes left on a commanded run, from the ABSOLUTE deadline.
 *
 * 🛑 Derived from `stop_at` (epoch seconds) and never from the pushed `request/duration`, which is
 * the hub's own invariant restated on the client: "stop at 17:03:40Z" stays true while the page sits
 * open and the pushes go stale; "23 minutes remaining" silently does not. Rounded UP for the same
 * reason the hub rounds up — 0 is the command value for STOP and must never mean "nearly done".
 */
export function runMinutesLeft(
  stopAtEpochSec: number | null | undefined,
  nowMs: number,
): number | null {
  if (stopAtEpochSec == null || !Number.isFinite(stopAtEpochSec)) return null;
  const remainingMs = stopAtEpochSec * 1000 - nowMs;
  if (remainingMs <= 0) return null;
  return Math.ceil(remainingMs / 60_000);
}

/** Whole minutes a run has been going, from its ISO start. Null when there is no open run. */
export function runMinutesElapsed(
  startIso: string | null | undefined,
  nowMs: number,
): number | null {
  if (!startIso) return null;
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return null;
  return Math.max(0, Math.floor((nowMs - startMs) / 60_000));
}

/** Whether the DSE's front panel is in Auto — the precondition no remote request may override. */
export function panelIsAuto(mode: string | null | undefined): boolean {
  return (mode ?? "").trim().toLowerCase() === "auto";
}

/**
 * The tile's time row: how long OUR run has left, or how long ANY run has been going.
 *
 * Remaining wins where we have it, because a deadline is actionable where an elapsed count is only
 * informational — and it is the number the user set.
 *
 * 🛑 The `\u00A0` between the number and its unit is a NON-BREAKING space and is load-bearing: the
 * value lands in a tile's grid cell and in a one-line clause under the hero, and a plain space lets
 * "23" and "min" land on different lines. Same rule as `lib/fe-date-format.ts`, which NBSP-joins
 * every number/unit pair it spells.
 */
export function runTimeWords(input: {
  isCommandedRun: boolean;
  isRunning: boolean;
  stopAtEpochSec: number | null | undefined;
  runStartIso: string | null | undefined;
  nowMs: number;
}): { short: string; long: string; value: string } | null {
  if (input.isCommandedRun) {
    const left = runMinutesLeft(input.stopAtEpochSec, input.nowMs);
    if (left != null)
      return {
        short: "Stops",
        long: "Stops in",
        value: `${left}\u00A0min`,
      };
  }
  if (input.isRunning) {
    const elapsed = runMinutesElapsed(input.runStartIso, input.nowMs);
    if (elapsed != null)
      return {
        short: "Run",
        long: "Running",
        value: `${elapsed}\u00A0min`,
      };
  }
  return null;
}
