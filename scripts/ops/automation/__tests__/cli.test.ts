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
  sourceWords,
  evaluationHasFindings,
  evaluatorState,
  renderEvaluation,
  renderHealth,
  buildRRule,
  parseStart,
  resolveAutomation,
  scheduleLines,
  triggerWords,
  type WireAutomation,
} from "../model";
import type { WireArea } from "../../shared";

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
  "--start=2026-09-17 09:00",
  "--rrule=FREQ=WEEKLY;BYDAY=TH",
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
    "--start",
    "--minutes",
  ])("requires %s", (flag) => {
    const argv = CREATE.filter((a) => !a.startsWith(`${flag}=`));
    expect(failure(argv)).toContain(flag.replace(/^--/, ""));
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(failure([...CREATE, "--min-load=1.5"])).toContain("min-load");
  });

  // A one-off is the BASE case of the grammar, not a special mode — so --rrule is the optional
  // part, and dropping it must still parse.
  it("accepts a one-off: a start and no rrule", () => {
    const argv = CREATE.filter((a) => !a.startsWith("--rrule="));
    expect(success(argv).flags.rrule).toBeUndefined();
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

  it("skip takes the area, the automation AND a date", () => {
    expect(failure(["skip", "daylesford", "x"])).toContain("date");
    expect(failure(["skip", "daylesford", "--date=2026-09-24"])).toContain(
      "automation",
    );
  });

  it("upcoming takes exactly the area", () =>
    expect(failure(["upcoming"])).toContain("area"));
});

describe("parseStart", () => {
  it("accepts a space or a T between the date and the time", () => {
    expect(parseStart("2026-09-17 09:00")).toBe("2026-09-17T09:00");
    expect(parseStart("2026-09-17T09:00")).toBe("2026-09-17T09:00");
  });

  it.each(["2026-09-17 9:00", "2026-09-17", "24:00", "next thursday"])(
    "refuses %s",
    (t) => expect(refusal(() => parseStart(t))).toContain("not a start time"),
  );

  // 🛑 A spring-forward Sunday skips 02:00–02:59 entirely, so a slot in it never occurs and the
  // rule silently never fires. Caught here so the message explains why, rather than as a 422.
  it.each(["2026-10-04 02:00", "2026-10-04 02:30", "2026-10-04 02:59"])(
    "refuses %s — the daylight-saving gap hour",
    (t) => expect(refusal(() => parseStart(t))).toContain("daylight-saving"),
  );
});

describe("buildRRule", () => {
  it("is undefined for a one-off — no rule at all is the base case", () =>
    expect(buildRRule({})).toBeUndefined());

  it("canonicalises what it is given", () =>
    expect(buildRRule({ rrule: "byday=th;freq=weekly" })).toBe(
      "FREQ=WEEKLY;BYDAY=TH",
    ));

  // Canonical part ORDER, not the order they were typed in — so two spellings of the same rule
  // store identically and a `show` diff is about the rule, not the typing.
  it("folds --until into the rule", () =>
    expect(
      buildRRule({ rrule: "FREQ=WEEKLY;BYDAY=TH", until: "2026-12-31" }),
    ).toBe("FREQ=WEEKLY;UNTIL=20261231;BYDAY=TH"));

  it("folds --count into the rule", () =>
    expect(buildRRule({ rrule: "FREQ=WEEKLY;BYDAY=TH", count: 6 })).toBe(
      "FREQ=WEEKLY;COUNT=6;BYDAY=TH",
    ));

  it("refuses --until and --count together — a rule has one ending", () =>
    expect(
      refusal(() =>
        buildRRule({
          rrule: "FREQ=WEEKLY;BYDAY=TH",
          until: "2026-12-31",
          count: 6,
        }),
      ),
    ).toContain("one ending"));

  it("refuses --until without --rrule — there is no repeat to bound", () =>
    expect(refusal(() => buildRRule({ until: "2026-12-31" }))).toContain(
      "one-off",
    ));

  // The same validator the server runs, so the CLI and the API cannot disagree about the subset.
  it.each(["FREQ=HOURLY", "FREQ=WEEKLY;BYHOUR=9", "BYDAY=TH"])(
    "refuses %s before anything is resolved over the network",
    (rule) =>
      expect(refusal(() => buildRRule({ rrule: rule }))).toContain("--rrule"),
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
        schedule: {
          start: "2026-09-17T09:00",
          rrule: "FREQ=WEEKLY;BYDAY=TH",
          graceMinutes: 180,
        },
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
      nextAt: null,
      ...over,
    }) as WireAutomation;

  it("summarises an exercise trigger by its schedule", () =>
    expect(triggerWords(row().trigger)).toBe(
      "exercise 2026-09-17T09:00 FREQ=WEEKLY;BYDAY=TH",
    ));

  it("marks a one-off as one, rather than showing a blank rule", () =>
    expect(
      triggerWords({
        kind: "exercise",
        source: { kind: "derivation", derivationId: "dx_1" },
        schedule: { start: "2026-09-12T09:00", graceMinutes: 180 },
      }),
    ).toBe("exercise 2026-09-12T09:00 (once)"));

  it("words the schedule, and says plainly when nothing is left", () => {
    const lines = scheduleLines(
      { start: "2026-09-17T09:00", graceMinutes: 180 },
      "Australia/Melbourne",
      null,
    ).join("\n");
    expect(lines).toContain("once");
    expect(lines).toContain("no occurrences left");
  });

  it("lists the dates a rule skips", () => {
    const lines = scheduleLines(
      {
        start: "2026-09-17T09:00",
        rrule: "FREQ=WEEKLY;BYDAY=TH",
        exdates: ["2026-09-24T09:00"],
        graceMinutes: 180,
      },
      "Australia/Melbourne",
      Date.UTC(2026, 8, 30, 23, 0),
    ).join("\n");
    expect(lines).toContain("Thursday");
    expect(lines).toContain("skipping:     2026-09-24T09:00");
  });

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

  // 🛑 INVERTED. This used to assert the charge context was dropped, which is what the renderer
  // did — it early-returned on anything that was not an exercise row, so a kWh limit's baseline (the
  // value its whole delta is measured from) was invisible on `show`. That was a gap, not a design.
  it("renders a charge row's baseline context", () => {
    const lines = decisionLines({
      baselineKwh: 42,
      baselineAt: 1_700_000_000_000,
    });
    expect(lines.join("\n")).toContain("42.00 kWh");
    expect(lines.join("\n")).toContain("snapshotted");
  });

  it("still has nothing to say about an absent context", () =>
    expect(decisionLines(null)).toEqual([]));

  it("reports the run counts and the battery reading on an exercise decision", () => {
    const lines = decisionLines({
      kind: "exercise",
      outcome: "skipped-full",
      slotAt: 1_700_000_000_000,
      at: 1_700_000_060_000,
      runsConsidered: 0,
      runsExcluded: 1,
      socPercent: 98.8,
    });
    expect(lines.join("\n")).toContain("0 (1 discounted as our own)");
    expect(lines.join("\n")).toContain("98.8%");
  });

  // The line that makes a 180-tick grace window legible instead of silent.
  it("reports how many ticks saw the slot due", () => {
    const lines = decisionLines({
      kind: "exercise",
      outcome: "missed",
      slotAt: 1,
      at: 2,
      ticks: 180,
      firstSeenAt: 1_700_000_000_000,
    });
    expect(lines.join("\n")).toContain("seen due:     180 tick(s) since");
  });

  it("sourceWords names the detector a rule is triggered by", () => {
    expect(
      sourceWords({
        kind: "exercise",
        source: { kind: "derivation", derivationId: "dx_1" },
      } as never),
    ).toBe("derivation dx_1");
    expect(
      sourceWords({
        kind: "charge-session",
        source: { kind: "point", pointId: "pt_1" },
      } as never),
    ).toBe("point pt_1");
    expect(sourceWords(null)).toBeNull();
  });
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

/**
 * `automation move` — the verb that fills the asymmetry with devices, which have had a move since
 * `PATCH /api/v4/devices/{id} { areaId }`.
 *
 * The properties worth pinning at parse level are the ones a handler cannot rescue: that the
 * destination is not optional-with-a-default (there is no sensible default area to move to), and
 * that the verb is dry by default like every other writer in the domain.
 */
describe("automation move", () => {
  it("is dry by default and offers --apply", () => {
    const args = ["move", "daylesford", "au_1", "--to=other"];
    expect(success(args).dryRun).toBe(true);
    expect(success([...args, "--apply"]).dryRun).toBe(false);
  });

  it("--apply off a terminal refuses without --yes", () => {
    const r = parse(
      automationCommand,
      ["move", "daylesford", "au_1", "--to=other", "--apply"],
      { stdoutIsTTY: false, stdinIsTTY: false },
      ["liveone"],
    );
    expect(r.ok).toBe(false);
  });

  it("takes the source area and automation positionally — there is no GET-by-id", () => {
    expect(success(["move", "daylesford", "au_1", "--to=other"]).args).toEqual([
      "daylesford",
      "au_1",
    ]);
  });

  it("carries the destination on --to", () => {
    expect(success(["move", "a", "au_1", "--to=kinkora"]).flags.to).toBe(
      "kinkora",
    );
  });

  /**
   * The handler refuses a missing `--to` rather than the parser, because a string flag with no
   * default parses fine as absent. Pinned so that giving it a default — any default — has to be a
   * deliberate, failing change: a move whose destination defaults is a move to somewhere nobody named.
   */
  it("parses without --to, leaving the refusal to the handler", () => {
    expect(success(["move", "a", "au_1"]).flags.to).toBeUndefined();
  });
});

describe("automation check", () => {
  it("takes an area and an automation", () => {
    expect(success(["check", "daylesford", "Generator exercise"]).ok).toBe(
      true,
    );
  });

  it("🛑 is a READ verb — it refuses --apply", () => {
    expect(failure(["check", "a", "b", "--apply"])).toContain("apply");
  });

  describe("renderEvaluation", () => {
    it("states the skip condition's current ANSWER, not just the rule", () => {
      const out = renderEvaluation({
        evaluatedAt: "2026-09-24T07:00:00.000Z",
        enabled: true,
        unless: {
          minMinutes: 30,
          minLoadKw: 1.5,
          withinDays: 7,
          best: { minutes: 41.2, peakKw: 3.9, endedAt: "2026-09-21T09:41:00Z" },
          satisfied: true,
          runsConsidered: 1,
          runsExcluded: 0,
        },
        decision: { kind: "consume", outcome: "satisfied" },
      });
      expect(out).toContain("answer now:   YES");
      expect(out).toContain("41.2 min");
      expect(out).toContain("would dispatch: nothing");
    });

    it("🛑 names the raw-read convention, so a sign mismatch is legible", () => {
      const out = renderEvaluation({
        unless: {
          best: null,
          runsConsidered: 4,
          runsExcluded: 0,
          loadPoint: { id: "pt_x", transformApplied: false },
        },
      });
      expect(out).toContain("answer now:   NO");
      expect(out).toContain("RAW — no transform applied");
      expect(out).toContain("4 (0 discounted as our own)");
    });

    it("reports the readiness gate as ready or too full", () => {
      expect(
        renderEvaluation({
          require: { socPercent: 98.8, maxSocPercent: 95, ready: false },
        }),
      ).toContain("TOO FULL");
      expect(
        renderEvaluation({
          require: { socPercent: 84.6, maxSocPercent: 95, ready: true },
        }),
      ).toContain("ready");
    });

    it("degrades to a sentence against an origin that predates the payload", () => {
      expect(() => renderEvaluation({})).not.toThrow();
      expect(renderEvaluation({})).toContain("evaluated:      ?");
      // 🛑 And says so. An unreadable answer must not render as "enabled: yes / would dispatch:
      // nothing", which is missing information dressed up as affirmative information.
      expect(renderEvaluation({})).toContain("UNKNOWN, not healthy");
      expect(renderEvaluation({})).toContain("enabled:        ?");
    });

    // 🛑 THE CONTRACT TEST. The renderer's fixtures were hand-written in the CLI's own declared
    // shape, so a server that sent something else was invisible to them — `unless.withinDays` was
    // nested under `window` on the wire and every real response printed "in the last ? days".
    // This fixture is copied from the route's actual response body, not from the CLI's types.
    it("🛑 renders a body shaped like the ROUTE's actual response", () => {
      const fromRoute = {
        automationId: "au_x",
        areaId: "ar_x",
        timezone: "Australia/Melbourne",
        evaluatedAt: "2026-09-24T07:00:00.000Z",
        enabled: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        kind: "exercise",
        source: { derivationId: "dx_1", resolved: true },
        next: { atMs: 1, at: "2026-10-01T07:00:00.000Z" },
        exhausted: false,
        slot: { atMs: 0, at: "2026-09-24T07:00:00.000Z" },
        due: { due: true },
        openRun: false,
        unless: {
          withinDays: 7,
          minMinutes: 30,
          minLoadKw: 1.5,
          dipToleranceSeconds: 180,
          loadPoint: { id: "pt_load", transformApplied: false },
          best: null,
          satisfied: false,
          runsConsidered: 0,
          runsExcluded: 1,
        },
        require: {
          socPointId: "pt_soc",
          socPercent: 93.2,
          maxSocPercent: 95,
          ready: true,
        },
        supervise: { settleMinutes: 10, sustainMinutes: 3 },
        decision: { kind: "dispatch", outcome: null, reason: null },
        wouldDispatch: { pointId: "pt_act", action: "set_value", value: 30 },
      };
      const out = renderEvaluation(fromRoute);
      expect(out).toContain("in the last 7 days");
      expect(out).not.toContain("? days");
      expect(out).toContain("ready");
      expect(out).toContain("set pt_act = 30");
      expect(evaluationHasFindings(fromRoute)).toBe(false);
    });

    it("🛑 an unreadable payload is a FINDING, not a pass", () => {
      expect(evaluationHasFindings({})).toBe(true);
      // A server that declined to evaluate this kind is a stated limitation, not an unknown —
      // but a DISABLED rule is still a finding whatever kind it is.
      expect(evaluationHasFindings({ supported: false, enabled: true })).toBe(
        false,
      );
      expect(evaluationHasFindings({ supported: false, enabled: false })).toBe(
        true,
      );
    });

    it("a schedule that has not started yet is healthy", () => {
      expect(
        evaluationHasFindings({
          enabled: true,
          due: { due: false, reason: "not-started" },
          blockers: [],
        }),
      ).toBe(false);
    });

    it("reports an unsupported rule kind rather than rendering an empty verdict", () => {
      expect(
        renderEvaluation({
          kind: "charge-session",
          supported: false,
          detail: "nope",
        }),
      ).toBe("charge-session rule: nope");
    });
  });

  describe("evaluationHasFindings", () => {
    it("a healthy verdict is not a finding", () => {
      expect(
        evaluationHasFindings({
          enabled: true,
          decision: { outcome: "satisfied" },
        }),
      ).toBe(false);
    });

    it.each(["missed", "missed-running"])("%s is a finding", (outcome) => {
      expect(
        evaluationHasFindings({ enabled: true, decision: { outcome } }),
      ).toBe(true);
    });

    it("a disabled rule, an unresolved detector and a blocker are findings", () => {
      expect(evaluationHasFindings({ enabled: false })).toBe(true);
      expect(evaluationHasFindings({ source: { resolved: false } })).toBe(true);
      expect(
        evaluationHasFindings({ blockers: [{ code: "no-detector" }] }),
      ).toBe(true);
    });
  });
});

describe("automation health", () => {
  it("takes no arguments — it is fleet-wide", () => {
    expect(success(["health"]).ok).toBe(true);
    expect(failure(["health", "daylesford"])).toBeTruthy();
  });

  it("is a read verb", () => {
    expect(failure(["health", "--apply"])).toContain("apply");
  });

  describe("evaluatorState — most alarming first", () => {
    const fresh = { at: "x", ageSeconds: 30, durationMs: 10, summary: {} };

    // 🛑 The ordering that matters: "switched off" must not read as "broken", because the remedies
    // are an env var and an incident respectively.
    it("🛑 DISABLED outranks SILENT", () => {
      expect(evaluatorState({ cronsEnabled: false, lastSweep: null })).toBe(
        "DISABLED",
      );
    });

    it("SILENT when no sweep, or a stale one", () => {
      expect(evaluatorState({ cronsEnabled: true, lastSweep: null })).toBe(
        "SILENT",
      );
      expect(
        evaluatorState({
          cronsEnabled: true,
          lastSweep: { ...fresh, ageSeconds: 301 },
        }),
      ).toBe("SILENT");
    });

    it("ERRORS when the last sweep counted any", () => {
      expect(
        evaluatorState({
          cronsEnabled: true,
          lastSweep: { ...fresh, summary: { errors: 2 } },
        }),
      ).toBe("ERRORS");
    });

    it("UNDECIDED when due slots outnumber the decisions", () => {
      expect(
        evaluatorState({
          cronsEnabled: true,
          lastSweep: { ...fresh, summary: { exercise: { due: 2, fired: 1 } } },
        }),
      ).toBe("UNDECIDED");
    });

    it("a skip counts as decided, not as a shortfall", () => {
      expect(
        evaluatorState({
          cronsEnabled: true,
          lastSweep: {
            ...fresh,
            summary: { exercise: { due: 1, skipped: 1 } },
          },
        }),
      ).toBe("ok");
    });

    it("🛑 UNKNOWN when a fresh sweep carries no summary — it cannot establish health", () => {
      expect(
        evaluatorState({
          cronsEnabled: true,
          lastSweep: { at: "x", ageSeconds: 10, durationMs: 1 },
        }),
      ).toBe("UNKNOWN");
    });

    it("ok when a fresh sweep decided everything", () => {
      expect(
        evaluatorState({
          cronsEnabled: true,
          lastSweep: { ...fresh, summary: { exercise: { due: 1, fired: 1 } } },
        }),
      ).toBe("ok");
    });
  });

  describe("renderHealth", () => {
    it("states both readings of an absent sweep rather than picking one", () => {
      const out = renderHealth({ cronsEnabled: true, lastSweep: null });
      expect(out).toContain("has not run since this deploy");
      expect(out).toContain("or it is not running");
    });

    it("warns that a suppressed alert is not the same as a healthy one", () => {
      expect(
        renderHealth({ undecidedAlertSuppressedUntil: "2026-09-18T00:00:00Z" }),
      ).toContain("does not mean healthy");
    });

    it("degrades against an origin that predates the payload", () => {
      expect(() => renderHealth({})).not.toThrow();
    });
  });
});
