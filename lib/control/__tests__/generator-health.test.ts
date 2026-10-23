/**
 * The generator's issues list — replayed against Daylesford, 15–22 October 2026, when the tile said
 * "Auto · Ready to start" over a controller with no power, a flat starter battery, and an exercise
 * that failed 181 dispatches.
 */
import { describe, it, expect } from "@jest/globals";
import {
  assessGeneratorHealth,
  formatInstant,
  type GeneratorHealthInput,
} from "../generator-health";

const TZ = "Australia/Melbourne";
const NOW = Date.parse("2026-10-21T22:55:00.000Z"); // Thu 22 Oct, 09:55 AEDT
const DEAD_AT = Date.parse("2026-10-18T18:28:00.000Z");
const SLOT = Date.parse("2026-10-21T20:00:00.000Z"); // Thu 22 Oct, 07:00 AEDT
const MIN = 60_000;

const kv = (value: unknown, ms: number) => ({ value, measurementTimeMs: ms });

function input(over: Partial<GeneratorHealthInput> = {}): GeneratorHealthInput {
  return {
    nowMs: NOW,
    timezone: TZ,
    latest: {
      "source.generator.control.status/state": kv("idle", NOW - 10_000),
      "source.generator.control.error/state": kv(
        "stop write failed: TCP connect to 10.0.1.244:502 timed out after 5000ms",
        Date.parse("2026-09-18T02:09:25.000Z"),
      ),
      "source.generator.mode/state": kv("Auto", DEAD_AT),
      "generator.engine/speed": kv(0, DEAD_AT),
      "generator.battery/voltage": kv(3.5, DEAD_AT),
    },
    exercises: [
      {
        name: "Generator exercise",
        enabled: true,
        context: {
          kind: "exercise",
          slotAt: SLOT,
          outcome: "waiting",
          at: NOW - MIN,
          reason:
            "dispatch unavailable: The generator hub returned a non-JSON 530 response",
          ticks: 175,
          firstSeenAt: SLOT + 2_000,
        },
      },
    ],
    lastCommand: {
      status: "failed",
      error: "The generator hub returned a non-JSON 530 response",
      requestedAtMs: NOW - MIN,
      byAutomation: true,
    },
    ...over,
  };
}

describe("assessGeneratorHealth — the October 2026 outage", () => {
  const issues = assessGeneratorHealth(input());
  const codes = issues.map((i) => i.code);

  it("names every fact that was on record, critical first", () => {
    expect(codes).toEqual([
      "controller_offline",
      "battery_flat",
      "exercise_failing",
    ]);
    expect(issues.every((i) => i.severity === "critical")).toBe(true);
  });

  it("says how long the controller has been silent, and since when", () => {
    const offline = issues.find((i) => i.code === "controller_offline")!;
    expect(offline.detail).toContain("3\u00A0d");
    expect(offline.detail).toContain("Mon 19 Oct, 05:28");
    expect(offline.sinceMs).toBe(DEAD_AT);
  });

  it("reports the battery from its LAST reading, saying that it is the last", () => {
    const battery = issues.find((i) => i.code === "battery_flat")!;
    expect(battery.title).toBe("Starter battery flat · 3.5 V");
    expect(battery.detail).toContain("at the last reading");
  });

  it("explains the exercise: how many tries, since when, and the hub's own words", () => {
    const ex = issues.find((i) => i.code === "exercise_failing")!;
    expect(ex.detail).toContain("175 times");
    expect(ex.detail).toContain("Thu 22 Oct, 07:00");
    expect(ex.detail).toContain("530");
  });

  it("🛑 drops the month-old control error that the old '!' was showing", () => {
    expect(codes).not.toContain("control_error");
  });

  it("does not report an automation's failed command twice", () => {
    expect(codes).not.toContain("command_failed");
  });
});

describe("assessGeneratorHealth — after the grace window", () => {
  it("reports the missed slot for a week, with its reason", () => {
    const issues = assessGeneratorHealth(
      input({
        exercises: [
          {
            name: "Generator exercise",
            enabled: true,
            context: {
              kind: "exercise",
              slotAt: SLOT,
              outcome: "missed",
              at: SLOT + 180 * MIN,
              reason:
                "grace of 180 min expired; 180 min past the slot; last attempt: dispatch unavailable",
              ticks: 181,
            },
          },
        ],
      }),
    );
    const missed = issues.find((i) => i.code === "exercise_missed")!;
    expect(missed.title).toBe("Exercise missed · Thu 22 Oct");
    expect(missed.detail).toContain("181 attempts");
    expect(missed.sinceMs).toBe(SLOT);

    const weekLater = assessGeneratorHealth(
      input({
        nowMs: SLOT + 8 * 86_400_000,
        exercises: [
          {
            name: "x",
            enabled: true,
            context: {
              kind: "exercise",
              slotAt: SLOT,
              outcome: "missed",
              at: SLOT,
            },
          },
        ],
      }),
    );
    expect(weekLater.map((i) => i.code)).not.toContain("exercise_missed");
  });
});

describe("assessGeneratorHealth — a healthy generator", () => {
  const fresh = NOW - 2 * MIN;
  const healthy = input({
    latest: {
      "source.generator.control.status/state": kv("idle", NOW),
      "source.generator.mode/state": kv("Auto", fresh),
      "generator.engine/speed": kv(0, fresh),
      "generator.battery/voltage": kv(13.3, fresh),
    },
    exercises: [
      {
        name: "x",
        enabled: true,
        context: {
          kind: "exercise",
          slotAt: SLOT,
          outcome: "fired",
          at: SLOT,
        },
      },
    ],
    lastCommand: null,
  });

  it("has nothing to say", () => {
    expect(assessGeneratorHealth(healthy)).toEqual([]);
  });

  it("warns on a battery off its charger before it is flat", () => {
    const low = assessGeneratorHealth({
      ...healthy,
      latest: {
        ...healthy.latest,
        "generator.battery/voltage": kv(12.1, fresh),
      },
    });
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ code: "battery_low", severity: "warning" });
  });

  it("ignores a short retry loop — one declined tick is the evaluator working", () => {
    const issues = assessGeneratorHealth({
      ...healthy,
      exercises: [
        {
          name: "x",
          enabled: true,
          context: {
            kind: "exercise",
            slotAt: SLOT,
            outcome: "waiting",
            at: NOW - MIN,
            reason: "a run is already in progress",
            ticks: 2,
          },
        },
      ],
    });
    expect(issues).toEqual([]);
  });

  it("flags a failed manual command, but only for a day", () => {
    const cmd = {
      status: "failed",
      error: "hub timeout",
      requestedAtMs: NOW - 10 * MIN,
      byAutomation: false,
    };
    expect(
      assessGeneratorHealth({ ...healthy, lastCommand: cmd }).map(
        (i) => i.code,
      ),
    ).toEqual(["command_failed"]);
    expect(
      assessGeneratorHealth({
        ...healthy,
        lastCommand: { ...cmd, requestedAtMs: NOW - 2 * 86_400_000 },
      }),
    ).toEqual([]);
  });

  it("has no opinion on automations a viewer may not see", () => {
    expect(
      assessGeneratorHealth({ ...healthy, exercises: null, lastCommand: null }),
    ).toEqual([]);
  });
});

describe("formatInstant", () => {
  it("spells an instant in the area's zone, daylight saving included", () => {
    expect(formatInstant(SLOT, TZ)).toBe("Thu 22 Oct, 07:00");
  });
});
