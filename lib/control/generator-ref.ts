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
/** Engine speed, rpm. */
export const GENERATOR_RPM_PATH = "source.generator.engine/speed";

/**
 * The paths the tile's control would COMMAND, most specific first — what `datumCanControlPoint`
 * uses to gate the cog on ownership of the DEVICE that would be commanded, rather than on the area
 * the tile happened to fetch under. See components/dashboard/tiles/types.ts `controlPaths`.
 */
export const GENERATOR_CONTROL_PATHS = [GENERATOR_RUN_REQUEST_PATH] as const;

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
  /** The short line a tile shows. */
  label: string;
  /**
   * `commanded` = this run is ours and the hub is holding the deadline (the one amber state);
   * `running` = it is running, but not at our request; `warning` = something needs a human.
   */
  tone: "idle" | "running" | "commanded" | "warning";
  /** True ⇒ a run of ours is in progress, so the dialog shows Extend/Stop rather than Start. */
  commanded: boolean;
  /** A fuller sentence for the dialog header, where there is room to be explicit. */
  detail: string;
}

const UNKNOWN: GeneratorStatusCopy = {
  label: "Unknown",
  tone: "idle",
  commanded: false,
  detail: "The generator's state has not been reported.",
};

const COPY: Record<GeneratorControlState, GeneratorStatusCopy> = {
  idle: {
    label: "Off",
    tone: "idle",
    commanded: false,
    detail: "The generator is stopped.",
  },
  "running:hub": {
    label: "Running",
    tone: "commanded",
    commanded: true,
    detail: "Running on a request from LiveOne.",
  },
  "running:sp-pro": {
    label: "Running",
    tone: "running",
    commanded: false,
    // Worth spelling out: this run is the inverter's, and our Stop cannot end it — fn 33 clears
    // only OUR latch. Saying "running" alone would imply a stop button that works.
    detail:
      "Running at the inverter's request. LiveOne cannot stop a run it did not start.",
  },
  "running:other": {
    label: "Running",
    tone: "running",
    commanded: false,
    detail: "Running, but not at LiveOne's request.",
  },
  stopping: {
    label: "Cooling down",
    tone: "running",
    commanded: false,
    detail: "The run request was released; the engine is cooling down.",
  },
  "stop-failing": {
    label: "Stop failing",
    tone: "warning",
    commanded: true,
    // The one truly bad outcome. The hub retries every 15 s indefinitely, and saying so is the
    // difference between "something is broken" and "something is broken and being handled".
    detail:
      "The hub could not confirm the stop and is retrying every 15 seconds. Check the generator.",
  },
  "latch-released-still-running": {
    label: "Still running",
    tone: "warning",
    commanded: false,
    // 🛑 Released ≠ stopped. We let go and it kept turning past the cool-down grace, so something
    // else is commanding it.
    detail:
      "LiveOne released its run request, but the engine is still running — something else is commanding it.",
  },
};

/** What a hub state is called. An unrecognised state claims nothing rather than guessing. */
export function describeGeneratorState(
  state: string | null | undefined,
): GeneratorStatusCopy {
  if (!state) return UNKNOWN;
  return COPY[state as GeneratorControlState] ?? UNKNOWN;
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

/** Whether the DSE's front panel is in Auto — the precondition no remote request may override. */
export function panelIsAuto(mode: string | null | undefined): boolean {
  return (mode ?? "").trim().toLowerCase() === "auto";
}

/**
 * The tile's one-line state, assembled from the pieces above.
 *
 * The panel-mode suffix is here rather than only in the dialog because it is the single fact that
 * most often explains a refusal, it costs one word, and a user who can see "Panel in Stop" on the
 * dashboard does not need to open anything to know why nothing will start.
 */
export function generatorTileLine(input: {
  state: string | null | undefined;
  mode: string | null | undefined;
  stopAtEpochSec: number | null | undefined;
  nowMs: number;
}): { text: string; tone: GeneratorStatusCopy["tone"] } {
  const copy = describeGeneratorState(input.state);
  const parts = [copy.label];

  if (copy.commanded) {
    const mins = runMinutesLeft(input.stopAtEpochSec, input.nowMs);
    if (mins != null) parts.push(`${mins} min left`);
  } else if (input.state === "running:sp-pro") {
    parts.push("called by inverter");
  }

  // Only ever mentioned when it is NOT the normal case, so its presence carries the meaning.
  if (input.mode && !panelIsAuto(input.mode)) {
    parts.push(`panel in ${input.mode}`);
  }

  return { text: parts.join(" · "), tone: copy.tone };
}
