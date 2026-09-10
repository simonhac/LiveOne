/**
 * The `automation` domain's flag contract and pure helpers.
 *
 * Same approach as the `derivation` suite: the domain module has no entrypoint, so the spec can be
 * parsed without a network, a token or a server. What is worth pinning is the shape a typo lands
 * in — because the verb under test creates something that starts a diesel engine unattended, and
 * every one of these refusals is cheaper than the 422 (or the unwanted run) it replaces.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type CliFailure, type Tty } from "@/lib/cli/cli";
import { automationCommand } from "..";
import {
  automationLine,
  actionWords,
  decisionLines,
  parseTime,
  parseWeekdays,
  resolveAutomation,
  triggerWords,
  type WireAutomation,
} from "../model";
import type { WireArea } from "../../derivation/model";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(automationCommand, argv, TTY, ["liveone"]);

const failure = (argv: string[]) => {
  const r = at(argv);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return JSON.stringify(r.error);
};
const success = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};

/**
 * Run a helper that is expected to refuse, and return its whole rendered failure.
 *
 * `usage()` throws a `CliFailure` whose Error MESSAGE is only the `why`; the headline is on
 * `.detail.what` and the fix on `.detail.next`. Asserting against the message alone would silently
 * stop checking the part of the error an operator reads first.
 */
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    const d = (e as CliFailure).detail;
    return [d.what, d.why, d.next].join(" | ");
  }
  throw new Error("expected a refusal, got none");
};

const CREATE = [
  "create-exercise",
  "daylesford",
  "--derivation=generator",
  "--load-point=bidi.grid/power",
  "--action-point=source.generator.control.request/duration",
  "--weekdays=thu",
  "--time=09:00",
  "--minutes=30",
];

describe("the write gate", () => {
  it.each(["create-exercise", "enable", "disable", "delete"])(
    "%s is dry by default and offers --apply",
    (verb) => {
      const argv = verb === "create-exercise" ? CREATE : [verb, "a", "b"];
      expect(success(argv).dryRun).toBe(true);
      expect(success([...argv, "--apply"]).dryRun).toBe(false);
    },
  );

  it.each(["list", "show"])("%s is a read verb with no write flags", (verb) => {
    const argv = verb === "list" ? [verb, "a"] : [verb, "a", "b"];
    expect(failure([...argv, "--apply"])).toContain("apply");
  });
});

describe("create-exercise", () => {
  it("accepts the full happy path", () => {
    expect(success(CREATE).args[0]).toBe("daylesford");
  });

  // Each of the three points answers a DIFFERENT question and none can stand in for another, so
  // all three are required rather than defaulted.
  it.each([
    "--derivation",
    "--load-point",
    "--action-point",
    "--weekdays",
    "--time",
    "--minutes",
  ])("requires %s", (flag) => {
    const argv = CREATE.filter((a) => !a.startsWith(`${flag}=`));
    expect(failure(argv)).toContain(flag.replace(/^--/, ""));
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(failure([...CREATE, "--min-load=1.5"])).toContain("min-load");
  });

  it("takes the optional knobs", () => {
    const r = success([
      ...CREATE,
      "--grace-minutes=60",
      "--min-minutes=20",
      "--min-load-kw=2",
      "--dip-seconds=90",
      "--within-days=14",
      "--name=Weekly exercise",
    ]);
    expect(r.flags.graceMinutes).toBe(60);
    expect(r.flags.minLoadKw).toBe(2);
    expect(r.flags.withinDays).toBe(14);
  });
});

describe("arity", () => {
  it("list takes exactly the area", () => {
    expect(failure(["list"])).toContain("area");
  });

  it.each(["show", "enable", "disable", "delete"])(
    "%s takes the area AND the automation",
    (verb) => {
      expect(failure([verb, "daylesford"])).toContain("automation");
    },
  );
});

describe("parseWeekdays", () => {
  it("takes one day", () => expect(parseWeekdays("thu")).toEqual(["thu"]));

  it("takes several, trimming and lower-casing", () =>
    expect(parseWeekdays(" Mon , THU ")).toEqual(["mon", "thu"]));

  it("refuses a day that is not a day", () =>
    expect(refusal(() => parseWeekdays("thur"))).toContain("not a weekday"));

  it("refuses an empty list — a schedule with no days never fires", () =>
    expect(refusal(() => parseWeekdays(" , "))).toContain("never fires"));
});

describe("parseTime", () => {
  it.each(["00:00", "09:00", "23:59"])("accepts %s", (t) =>
    expect(parseTime(t)).toBe(t),
  );

  it.each(["9:00", "24:00", "09:60", "0900", "morning"])("refuses %s", (t) =>
    expect(refusal(() => parseTime(t))).toContain("is not a time"),
  );

  // 🛑 A spring-forward Sunday skips 02:00–02:59 entirely, so a slot in it never occurs and the
  // rule silently never fires. Caught here so the message explains why, rather than as a 422.
  it.each(["02:00", "02:30", "02:59"])(
    "refuses %s — the daylight-saving gap hour",
    (t) => expect(refusal(() => parseTime(t))).toContain("daylight-saving"),
  );
});

describe("rendering", () => {
  const area = { id: "ar_x", displayName: "Daylesford" } as WireArea;
  const row = (over: Partial<WireAutomation> = {}): WireAutomation =>
    ({
      id: "au_1",
      areaId: "ar_x",
      name: "Generator exercise",
      enabled: true,
      mode: "standing",
      trigger: {
        kind: "exercise",
        source: { kind: "derivation", derivationId: "dx_1" },
        schedule: { weekdays: ["thu"], time: "09:00", graceMinutes: 180 },
        unless: {
          loadPointId: "pt_load",
          minMinutes: 30,
          minLoadKw: 1.5,
          dipToleranceSeconds: 180,
          withinDays: 7,
        },
      },
      action: {
        kind: "point-action",
        pointId: "pt_act",
        action: "set_value",
        value: 30,
      },
      armedAt: null,
      lastTriggeredAt: null,
      lastTriggeredRunStart: null,
      armedContext: null,
      ...over,
    }) as WireAutomation;

  it("summarises an exercise trigger by its schedule", () =>
    expect(triggerWords(row().trigger)).toBe("exercise thu 09:00"));

  it("summarises a charge-session trigger by its thresholds", () =>
    expect(
      triggerWords({
        kind: "charge-session",
        source: { kind: "point", pointId: "pt_c" },
        afterMinutes: 60,
        afterKwh: 20,
      }),
    ).toBe("stop after 60 min or 20 kWh"));

  // A row whose stored trigger could not be parsed arrives with the field NULLED. It must stay
  // listable — that is how it gets seen and deleted — and must not be described as anything.
  it("says UNREADABLE rather than guessing at an unparseable row", () => {
    expect(triggerWords(null)).toBe("UNREADABLE");
    expect(actionWords(null)).toBe("UNREADABLE");
    expect(automationLine(row({ trigger: null }))).toContain("UNREADABLE");
  });

  it("names the value a set_value would write", () =>
    expect(actionWords(row().action)).toBe("set pt_act = 30"));

  it("renders the decision log an exercise rule leaves behind", () => {
    const lines = decisionLines({
      kind: "exercise",
      slotAt: Date.UTC(2026, 8, 10, 23, 0),
      outcome: "satisfied",
      at: Date.UTC(2026, 8, 10, 23, 1),
      evidence: {
        minutes: 34,
        peakKw: 3.88,
        endedAt: Date.UTC(2026, 7, 12, 5, 48),
      },
    });
    expect(lines[0]).toContain("satisfied");
    expect(lines.join("\n")).toContain("34.0 min under load, peak 3.88 kW");
  });

  it("has nothing to say about a charge row's baseline context", () =>
    expect(decisionLines({ baselineKwh: 42 })).toEqual([]));
});

describe("resolveAutomation", () => {
  const rows = [
    { id: "au_1", name: "Generator exercise" },
    { id: "au_2", name: "Charge limit" },
  ] as WireAutomation[];
  const area = { id: "ar_x", displayName: "Daylesford" } as WireArea;

  it("resolves by id", () =>
    expect(resolveAutomation(rows, "au_2", area).name).toBe("Charge limit"));

  it("resolves by name, case-insensitively", () =>
    expect(resolveAutomation(rows, "generator exercise", area).id).toBe(
      "au_1",
    ));

  it("names the list command when nothing matches", () =>
    expect(refusal(() => resolveAutomation(rows, "nope", area))).toContain(
      "automation list ar_x",
    ));
});
