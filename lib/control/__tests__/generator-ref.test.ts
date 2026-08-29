/**
 * The generator's copy layer — the words a user reads about a running diesel engine.
 *
 * Every hub state is pinned, because the distinctions the hub draws are the whole value of it: "we
 * are running it" vs "the inverter is running it" vs "we let go and it did NOT stop" all render as
 * an engine that is turning, and telling them apart is the difference between a Stop button that
 * works and one that lies.
 */
import { describe, it, expect } from "@jest/globals";
import {
  describeGeneratorState,
  firstPresentPath,
  generatorTileLine,
  GENERATOR_RPM_PATHS,
  panelIsAuto,
  runMinutesLeft,
  type GeneratorControlState,
} from "../generator-ref";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const sec = (iso: string) => Date.parse(iso) / 1000;

describe("describeGeneratorState", () => {
  const ALL: GeneratorControlState[] = [
    "idle",
    "running:hub",
    "running:sp-pro",
    "running:other",
    "stopping",
    "stop-failing",
    "latch-released-still-running",
  ];

  it("has copy for EVERY state the supervisor can report", () => {
    for (const s of ALL) {
      const copy = describeGeneratorState(s);
      expect(copy.label).toBeTruthy();
      expect(copy.detail).toBeTruthy();
      expect(copy.label).not.toBe("Unknown");
    }
  });

  it("marks ONLY the states where a run of ours is in progress as `commanded`", () => {
    // `stop-failing` counts: we still hold the latch (the hub is retrying fn 33), so the dialog
    // must offer Stop rather than Start.
    const commanded = ALL.filter((s) => describeGeneratorState(s).commanded);
    expect(commanded).toEqual(["running:hub", "stop-failing"]);
  });

  it("uses the amber `commanded` tone for our own run, and plain `running` for anyone else's", () => {
    expect(describeGeneratorState("running:hub").tone).toBe("commanded");
    expect(describeGeneratorState("running:sp-pro").tone).toBe("running");
    expect(describeGeneratorState("running:other").tone).toBe("running");
    expect(describeGeneratorState("stopping").tone).toBe("running");
  });

  it("🛑 says out loud that a run we did not start cannot be stopped by us", () => {
    // fn 33 clears only OUR latch; it cannot cancel the SP-PRO's input-A request. A bare
    // "Running" would imply a Stop button that works on it.
    expect(describeGeneratorState("running:sp-pro").detail).toMatch(
      /cannot stop a run it did not start/i,
    );
  });

  it("🛑 keeps `released` and `stopped` apart, and flags a failing stop as needing a human", () => {
    expect(describeGeneratorState("latch-released-still-running").tone).toBe(
      "warning",
    );
    expect(
      describeGeneratorState("latch-released-still-running").detail,
    ).toMatch(/still running/i);
    expect(describeGeneratorState("stop-failing").tone).toBe("warning");
    expect(describeGeneratorState("stop-failing").detail).toMatch(
      /retrying every 15 seconds/i,
    );
  });

  it("claims nothing for an unrecognised or absent state", () => {
    for (const s of ["running:martian", "", null, undefined]) {
      expect(describeGeneratorState(s).label).toBe("Unknown");
      expect(describeGeneratorState(s).commanded).toBe(false);
    }
  });
});

describe("runMinutesLeft", () => {
  it("derives minutes from the ABSOLUTE deadline", () => {
    expect(runMinutesLeft(sec("2026-08-29T12:23:00.000Z"), NOW)).toBe(23);
  });

  it("🛑 rounds UP, so a run with seconds left never reads as 0", () => {
    // 0 is the command value for STOP. "0 min left" would read as "no run in progress" — the exact
    // inversion of the truth — which is why the hub rounds up too.
    expect(runMinutesLeft(sec("2026-08-29T12:00:20.000Z"), NOW)).toBe(1);
    expect(runMinutesLeft(sec("2026-08-29T12:00:01.000Z"), NOW)).toBe(1);
  });

  it("returns null once the deadline has passed, or when there is no deadline", () => {
    expect(runMinutesLeft(sec("2026-08-29T11:59:59.000Z"), NOW)).toBeNull();
    expect(runMinutesLeft(sec("2026-08-29T12:00:00.000Z"), NOW)).toBeNull();
    expect(runMinutesLeft(null, NOW)).toBeNull();
    expect(runMinutesLeft(undefined, NOW)).toBeNull();
    expect(runMinutesLeft(Number.NaN, NOW)).toBeNull();
  });
});

describe("firstPresentPath", () => {
  const MODERN = GENERATOR_RPM_PATHS[0];
  const LEGACY = GENERATOR_RPM_PATHS[1];

  it("prefers the manifest-correct path when both are present", () => {
    expect(
      firstPresentPath({ [MODERN]: 1, [LEGACY]: 2 }, GENERATOR_RPM_PATHS),
    ).toBe(MODERN);
  });

  it("🛑 falls back to the legacy path, which is the one PROD actually carries", () => {
    // #150 renamed the manifest stem; `points` rows are keyed on `physical_path` and only their
    // `control` field is drift-healed, so the already-minted row kept `generator.engine`.
    expect(firstPresentPath({ [LEGACY]: 2 }, GENERATOR_RPM_PATHS)).toBe(LEGACY);
  });

  it("returns null when neither is present, or there is no map at all", () => {
    expect(firstPresentPath({}, GENERATOR_RPM_PATHS)).toBeNull();
    expect(firstPresentPath(null, GENERATOR_RPM_PATHS)).toBeNull();
    expect(firstPresentPath(undefined, GENERATOR_RPM_PATHS)).toBeNull();
  });

  it("treats a null-valued entry as absent, so a dead point does not mask a live one", () => {
    expect(
      firstPresentPath({ [MODERN]: null, [LEGACY]: 2 }, GENERATOR_RPM_PATHS),
    ).toBe(LEGACY);
  });

  it("accepts a zero reading — 0 rpm is a fact, not an absence", () => {
    expect(firstPresentPath({ [MODERN]: 0 }, GENERATOR_RPM_PATHS)).toBe(MODERN);
  });
});

describe("panelIsAuto", () => {
  it("accepts only Auto, however it is cased or padded", () => {
    expect(panelIsAuto("Auto")).toBe(true);
    expect(panelIsAuto(" auto ")).toBe(true);
    expect(panelIsAuto("Stop")).toBe(false);
    expect(panelIsAuto("Manual")).toBe(false);
    expect(panelIsAuto(null)).toBe(false);
    expect(panelIsAuto("")).toBe(false);
  });
});

describe("generatorTileLine", () => {
  const line = (over: Partial<Parameters<typeof generatorTileLine>[0]> = {}) =>
    generatorTileLine({
      state: "idle",
      mode: "Auto",
      stopAtEpochSec: null,
      nowMs: NOW,
      ...over,
    });

  it("is just the state when nothing else needs saying", () => {
    expect(line()).toEqual({ text: "Off", tone: "idle" });
  });

  it("appends the countdown to OUR run, from the absolute deadline", () => {
    expect(
      line({
        state: "running:hub",
        stopAtEpochSec: sec("2026-08-29T12:23:00.000Z"),
      }),
    ).toEqual({ text: "Running · 23 min left", tone: "commanded" });
  });

  it("names the inverter when the run is its, rather than showing a countdown we do not own", () => {
    expect(line({ state: "running:sp-pro" })).toEqual({
      text: "Running · called by inverter",
      tone: "running",
    });
  });

  it("drops the countdown once the deadline passes, without changing the state", () => {
    // The state comes from the hub's next push; the clock must not invent a transition.
    expect(
      line({
        state: "running:hub",
        stopAtEpochSec: sec("2026-08-29T11:59:00.000Z"),
      }),
    ).toEqual({ text: "Running", tone: "commanded" });
  });

  it("mentions the panel ONLY when it is not in Auto — so its presence carries the meaning", () => {
    expect(line({ mode: "Auto" }).text).toBe("Off");
    expect(line({ mode: "Stop" }).text).toBe("Off · panel in Stop");
    expect(
      line({
        state: "running:hub",
        stopAtEpochSec: sec("2026-08-29T12:05:00.000Z"),
        mode: "Manual",
      }).text,
    ).toBe("Running · 5 min left · panel in Manual");
  });

  it("carries the warning tone through to the tile", () => {
    expect(line({ state: "stop-failing" })).toEqual({
      text: "Stop failing",
      tone: "warning",
    });
  });
});
