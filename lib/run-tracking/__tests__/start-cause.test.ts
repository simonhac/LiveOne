/**
 * `classifyRunStart` — why a generator run started, from stored evidence around its start.
 *
 * The case that motivated it, from the dev mirror: Daylesford's 17 Sep 2026 7:55 pm run was
 * published as "(unscheduled)" with "No scheduled slot accounts for this run", while DSE input 1 —
 * the SP PRO's run demand — had closed at 09:55:15 UTC, the minute the engine started.
 */
import { describe, expect, it } from "@jest/globals";
import {
  classifyRunStart,
  type StartEvidence,
} from "@/lib/run-tracking/start-cause";

const START = Date.parse("2026-09-17T09:55:30Z");
const S = 1000;
const MIN = 60 * S;

const num = (tMs: number, value: number) => ({ tMs, value, valueStr: null });
const text = (tMs: number, valueStr: string) => ({
  tMs,
  value: null,
  valueStr,
});

const none: StartEvidence = {
  commands: [],
  remoteStart: [],
  latch: [],
  mode: [],
};

describe("classifyRunStart", () => {
  it("🛑 the inverter: input 1 closed at the start (the 17 Sep run)", () => {
    expect(
      classifyRunStart(START, {
        ...none,
        remoteStart: [num(START - 6 * MIN, 0), num(START - 15 * S, 1)],
        latch: [num(START - 15 * S, 0)],
      }),
    ).toEqual({ cause: "inverter", requestedBy: null });
  });

  it("an automation's dispatch, named by who asked", () => {
    expect(
      classifyRunStart(START, {
        ...none,
        commands: [
          {
            requestedAtMs: START - 40 * S,
            minutes: 30,
            requestedBy: "automation:au_01k",
          },
        ],
        latch: [num(START, 1)],
      }),
    ).toEqual({ cause: "automation", requestedBy: "automation:au_01k" });
  });

  it("a person's dispatch from the UI", () => {
    expect(
      classifyRunStart(START, {
        ...none,
        commands: [
          { requestedAtMs: START - 40 * S, minutes: 10, requestedBy: "user_x" },
        ],
      }),
    ).toEqual({ cause: "user", requestedBy: "user_x" });
  });

  it("🛑 a STOP command cannot have started anything", () => {
    expect(
      classifyRunStart(START, {
        ...none,
        commands: [
          { requestedAtMs: START - 40 * S, minutes: 0, requestedBy: "user_x" },
        ],
        remoteStart: [num(START, 1)],
      }).cause,
    ).toBe("inverter");
  });

  it("a command long before the start does not claim it", () => {
    expect(
      classifyRunStart(START, {
        ...none,
        commands: [
          {
            requestedAtMs: START - 60 * MIN,
            minutes: 10,
            requestedBy: "user_x",
          },
        ],
        remoteStart: [num(START, 0)],
      }),
    ).toEqual({ cause: "other", requestedBy: null });
  });

  it("the panel: Manual mode, no demand, no latch", () => {
    expect(
      classifyRunStart(START, {
        ...none,
        remoteStart: [num(START, 0)],
        latch: [num(START, 0)],
        mode: [text(START + 5 * S, "Manual")],
      }).cause,
    ).toBe("panel");
  });

  it("the latch with no command on record is `other`, not a guess at who", () => {
    expect(
      classifyRunStart(START, { ...none, latch: [num(START, 1)] }),
    ).toEqual({ cause: "other", requestedBy: null });
  });

  it("🛑 NO evidence is unknown (null), not `other`", () => {
    expect(classifyRunStart(START, none)).toEqual({
      cause: null,
      requestedBy: null,
    });
    // Evidence from well outside the start window says nothing about this start either.
    expect(
      classifyRunStart(START, {
        ...none,
        remoteStart: [num(START - 30 * MIN, 1)],
      }).cause,
    ).toBeNull();
  });
});
