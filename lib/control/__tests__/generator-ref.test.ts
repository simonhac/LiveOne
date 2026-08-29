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
  GENERATOR_RPM_PATHS,
  panelIsAuto,
  runMinutesElapsed,
  runMinutesLeft,
  runTimeWords,
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
      const copy = describeGeneratorState(s, "Auto");
      expect(copy.label).toBeTruthy();
      expect(copy.sentence).toBeTruthy();
      expect(copy.label).not.toBe("—");
    }
  });

  it("🛑 splits idle into ARMED and LOCKED OUT on the panel mode", () => {
    // The single most consequential fact this tile carries: a stopped generator in Auto will start
    // on its own; one in Stop will not start for anybody. "Off" would hide the difference.
    expect(describeGeneratorState("idle", "Auto")).toMatchObject({
      label: "Auto",
      tone: "idle",
    });
    expect(describeGeneratorState("idle", "Stop")).toMatchObject({
      label: "Locked out",
      tone: "warning",
    });
    expect(describeGeneratorState("idle", "Manual").label).toBe("Locked out");
  });

  it("🛑 does not claim a generator is armed when the panel cannot be seen", () => {
    // Mode absent is not mode Auto. Saying "Auto" here would be the one lie that matters.
    expect(describeGeneratorState("idle", null)).toMatchObject({
      label: "Off",
      tone: "idle",
    });
    expect(describeGeneratorState("idle", undefined).label).toBe("Off");
  });

  it("lets a turning engine outrank the panel state — running is the more urgent fact", () => {
    expect(describeGeneratorState("running:hub", "Stop")).toMatchObject({
      label: "Running",
      isRunning: true,
    });
  });

  it("marks ONLY the states where a run of ours is in progress as commanded", () => {
    // `stop-failing` counts: we still hold the latch (the hub is retrying fn 33), so the dialog
    // must offer Stop rather than Start.
    const commanded = ALL.filter(
      (s) => describeGeneratorState(s, "Auto").isCommandedRun,
    );
    expect(commanded).toEqual(["running:hub", "stop-failing"]);
  });

  it("marks every turning-or-cooling state as running, and no idle state", () => {
    const running = ALL.filter(
      (s) => describeGeneratorState(s, "Auto").isRunning,
    );
    expect(running).toEqual([
      "running:hub",
      "running:sp-pro",
      "running:other",
      "stopping",
      "stop-failing",
      "latch-released-still-running",
    ]);
  });

  it("uses the amber commanded tone for our own run, and plain running for anyone else's", () => {
    expect(describeGeneratorState("running:hub", "Auto").tone).toBe(
      "commanded",
    );
    expect(describeGeneratorState("running:sp-pro", "Auto").tone).toBe(
      "running",
    );
    expect(describeGeneratorState("running:other", "Auto").tone).toBe(
      "running",
    );
    expect(describeGeneratorState("stopping", "Auto").tone).toBe("running");
  });

  it("🛑 says out loud that a run we did not start cannot be stopped by us", () => {
    // fn 33 clears only OUR latch; it cannot cancel the SP-PRO's input-A request. A bare
    // "Running" would imply a Stop button that works on it.
    expect(describeGeneratorState("running:sp-pro", "Auto").sentence).toMatch(
      /cannot stop a run it did not start/i,
    );
    expect(describeGeneratorState("running:sp-pro", "Auto").detail).toBe(
      "called by inverter",
    );
  });

  it("🛑 keeps released and stopped apart, and flags a failing stop as needing a human", () => {
    const stuck = describeGeneratorState(
      "latch-released-still-running",
      "Auto",
    );
    expect(stuck.tone).toBe("warning");
    expect(stuck.sentence).toMatch(/still running/i);
    const failing = describeGeneratorState("stop-failing", "Auto");
    expect(failing.tone).toBe("warning");
    expect(failing.sentence).toMatch(/retrying every 15 seconds/i);
  });

  it("keeps every hero word short enough for the tile's value slot", () => {
    for (const s of ALL) {
      expect(
        describeGeneratorState(s, "Stop").label.length,
      ).toBeLessThanOrEqual(12);
    }
  });

  it("claims nothing for an unrecognised or absent state", () => {
    for (const s of ["running:martian", "", null, undefined]) {
      expect(describeGeneratorState(s, "Auto").label).toBe("—");
      expect(describeGeneratorState(s, "Auto").isCommandedRun).toBe(false);
      expect(describeGeneratorState(s, "Auto").isRunning).toBe(false);
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

describe("runMinutesElapsed", () => {
  it("counts whole minutes from an ISO start", () => {
    expect(runMinutesElapsed("2026-08-29T11:48:00.000Z", NOW)).toBe(12);
  });

  it("floors, so a run 59 s old reads 0 rather than 1", () => {
    expect(runMinutesElapsed("2026-08-29T11:59:01.000Z", NOW)).toBe(0);
  });

  it("never goes negative on a clock skew, and is null without a start", () => {
    expect(runMinutesElapsed("2026-08-29T12:05:00.000Z", NOW)).toBe(0);
    expect(runMinutesElapsed(null, NOW)).toBeNull();
    expect(runMinutesElapsed("not a date", NOW)).toBeNull();
  });
});

describe("runTimeWords", () => {
  const stopAt = Date.parse("2026-08-29T12:23:00.000Z") / 1000;
  const startedAt = "2026-08-29T11:48:00.000Z";

  it("prefers the REMAINING time on our own run — it is the number the user set", () => {
    expect(
      runTimeWords({
        isCommandedRun: true,
        isRunning: true,
        stopAtEpochSec: stopAt,
        runStartIso: startedAt,
        nowMs: NOW,
      }),
    ).toEqual({ short: "Stops", long: "Stops in", value: "23 min" });
  });

  it("falls back to elapsed for a run we did not command, and so have no deadline for", () => {
    expect(
      runTimeWords({
        isCommandedRun: false,
        isRunning: true,
        stopAtEpochSec: null,
        runStartIso: startedAt,
        nowMs: NOW,
      }),
    ).toEqual({ short: "Run", long: "Running", value: "12 min" });
  });

  it("🛑 falls back to elapsed when OUR deadline has already passed, rather than showing nothing", () => {
    // The hub is late releasing the latch, or the push is stale. The run is still real.
    expect(
      runTimeWords({
        isCommandedRun: true,
        isRunning: true,
        stopAtEpochSec: Date.parse("2026-08-29T11:59:00.000Z") / 1000,
        runStartIso: startedAt,
        nowMs: NOW,
      }),
    ).toEqual({ short: "Run", long: "Running", value: "12 min" });
  });

  it("says nothing at all when the engine is stopped", () => {
    expect(
      runTimeWords({
        isCommandedRun: false,
        isRunning: false,
        stopAtEpochSec: stopAt,
        runStartIso: startedAt,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("says nothing when running but with no start to count from", () => {
    expect(
      runTimeWords({
        isCommandedRun: false,
        isRunning: true,
        stopAtEpochSec: null,
        runStartIso: null,
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});
