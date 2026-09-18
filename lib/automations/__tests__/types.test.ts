/**
 * The closed v1 vocabulary parser, plus the wire codecs either side of it.
 *
 * `automations.trigger`/`action` are jsonb with a `.$type<>` annotation — a compile-time convenience
 * and nothing at runtime. These tests are what actually stops an unparseable body (or a hand-edited
 * row) reaching the evaluator.
 */
import { describe, it, expect } from "@jest/globals";
import { Area, Automation, Derivation, Point } from "@/lib/ids";
import {
  parseArmedContext,
  parseAutomationAction,
  parseAutomationTrigger,
} from "@/lib/automations/types";
import {
  actionFromWire,
  automationWire,
  triggerFromWire,
} from "@/lib/automations/wire";
import type { AutomationRow } from "@/lib/db/planetscale/schema";

const DX = Derivation.generate();
const DX_UUID = Derivation.toUuid(DX);
const PT = Point.generate();
const PT_UUID = Point.toUuid(PT);
const ACTION_PT = Point.generate();
const ACTION_PT_UUID = Point.toUuid(ACTION_PT);
const AU = Automation.generate();
const AU_UUID = Automation.toUuid(AU);
const AR = Area.generate();
const AR_UUID = Area.toUuid(AR);

describe("parseAutomationTrigger — exercise schedule", () => {
  const exercise = (schedule: unknown) => ({
    kind: "exercise",
    source: { kind: "derivation", derivationId: DX_UUID },
    schedule,
    unless: { loadPointId: PT_UUID },
  });
  const scheduleOf = (schedule: unknown) => {
    const out = parseAutomationTrigger(exercise(schedule));
    if (!out.ok) throw new Error(out.error);
    if (out.value.kind !== "exercise") throw new Error("not an exercise");
    return out.value.schedule;
  };
  const errorFor = (schedule: unknown) => {
    const out = parseAutomationTrigger(exercise(schedule));
    return out.ok ? null : out.error;
  };

  it("a start with no rrule is a one-off, and stores nothing it does not need", () => {
    expect(scheduleOf({ start: "2026-09-12T09:00" })).toEqual({
      start: "2026-09-12T09:00",
      graceMinutes: 180,
    });
  });

  it("canonicalises the rrule and sorts + dedupes the date lists", () => {
    expect(
      scheduleOf({
        start: "2026-09-17T09:00",
        rrule: "byday=th;freq=weekly",
        exdates: ["2026-10-01T09:00", "2026-09-24T09:00", "2026-10-01T09:00"],
        rdates: ["2026-09-20T09:00"],
      }),
    ).toEqual({
      start: "2026-09-17T09:00",
      rrule: "FREQ=WEEKLY;BYDAY=TH",
      exdates: ["2026-09-24T09:00", "2026-10-01T09:00"],
      rdates: ["2026-09-20T09:00"],
      graceMinutes: 180,
    });
  });

  it("treats an empty date list as absent rather than storing []", () => {
    expect(scheduleOf({ start: "2026-09-12T09:00", exdates: [] })).toEqual({
      start: "2026-09-12T09:00",
      graceMinutes: 180,
    });
  });

  it("refuses a date the calendar does not have", () => {
    expect(errorFor({ start: "2026-02-31T09:00" })).toContain(
      "not a real calendar date",
    );
  });

  it("🛑 refuses a start inside the daylight-saving gap hour", () => {
    expect(errorFor({ start: "2026-10-04T02:30" })).toContain("02:00–02:59");
  });

  it("refuses the retired weekday grammar rather than guessing at it", () => {
    expect(errorFor({ weekdays: ["thu"], time: "09:00" })).toContain(
      "trigger.schedule.start",
    );
  });

  it("refuses a malformed exdate, naming the field", () => {
    expect(
      errorFor({ start: "2026-09-12T09:00", exdates: ["2026-09-12"] }),
    ).toContain("trigger.schedule.exdates entries");
  });
});

/**
 * 🛑 `unless` used to be REQUIRED, which meant a one-off "run it for 10 minutes on Thursday" had no
 * way to say "and skip it for nothing" — the only way through the parser was a threshold chosen to
 * be unreachable (`minMinutes: 600`). That number is not inert: `describeRule` in the area calendar
 * feed renders it verbatim, so every subscriber was told the run would be "Skipped if it has
 * already run for 600 minutes or more above 1.5 kW in the previous 7 days", which is true of
 * nothing. These pin that the absence is expressible and stays absent.
 */
describe("parseAutomationTrigger — an exercise with no skip condition", () => {
  const unconditional = {
    kind: "exercise",
    source: { kind: "derivation", derivationId: DX_UUID },
    schedule: { start: "2026-09-18T09:45" },
  };

  it("parses, and stores no `unless` key at all", () => {
    const parsed = parseAutomationTrigger(unconditional);
    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "exercise",
        source: { kind: "derivation", derivationId: DX_UUID },
        schedule: { start: "2026-09-18T09:45", graceMinutes: 180 },
      },
    });
    // Not `unless: undefined` — the stored jsonb must not carry a key that says nothing.
    expect(parsed.ok && "unless" in parsed.value).toBe(false);
  });

  it("treats an explicit null the same as absent", () => {
    const parsed = parseAutomationTrigger({ ...unconditional, unless: null });
    expect(parsed.ok && "unless" in parsed.value).toBe(false);
  });

  it("still fills the defaults when an `unless` IS given", () => {
    const parsed = parseAutomationTrigger({
      ...unconditional,
      unless: { loadPointId: PT_UUID },
    });
    expect(
      parsed.ok && parsed.value.kind === "exercise" && parsed.value.unless,
    ).toEqual({
      loadPointId: PT_UUID,
      minMinutes: 30,
      minLoadKw: 1.5,
      dipToleranceSeconds: 180,
      withinDays: 7,
    });
  });

  it("🛑 refuses `supervise` without it — there is nothing to supervise against", () => {
    // Supervision reads `unless.loadPointId` against `unless.minLoadKw`. Accepting the pair would
    // store a supervise block that silently never supervises, which is the configuration-that-
    // reads-as-working failure this trigger keeps producing.
    const parsed = parseAutomationTrigger({
      ...unconditional,
      supervise: { settleMinutes: 10, sustainMinutes: 3 },
    });
    expect(parsed).toEqual({
      ok: false,
      error:
        "trigger.supervise needs trigger.unless — it stops a run by watching unless.loadPointId against unless.minLoadKw",
    });
  });

  it("accepts a readiness gate without one — `require` reads its own point", () => {
    const parsed = parseAutomationTrigger({
      ...unconditional,
      require: { socPointId: PT_UUID },
    });
    expect(
      parsed.ok && parsed.value.kind === "exercise" && parsed.value.require,
    ).toEqual({ socPointId: PT_UUID, maxSocPercent: 95 });
  });

  it("still refuses a malformed `unless` when one is offered", () => {
    expect(parseAutomationTrigger({ ...unconditional, unless: 7 })).toEqual({
      ok: false,
      error: "trigger.unless must be an object",
    });
  });
});

describe("parseAutomationTrigger", () => {
  const good = {
    kind: "charge-session",
    source: { kind: "derivation", derivationId: DX_UUID },
    afterMinutes: 60,
  };

  it("accepts a derivation source", () => {
    expect(parseAutomationTrigger(good)).toEqual({ ok: true, value: good });
  });

  it("accepts a point source with both thresholds", () => {
    const t = {
      kind: "charge-session",
      source: { kind: "point", pointId: PT_UUID },
      afterMinutes: 30,
      afterKwh: 12.5,
    };
    expect(parseAutomationTrigger(t)).toEqual({ ok: true, value: t });
  });

  it("drops unknown keys rather than storing them", () => {
    const parsed = parseAutomationTrigger({ ...good, sneaky: "value" });
    expect(parsed.ok && parsed.value).toEqual(good);
  });

  it.each([
    ["not an object", "hello", "trigger must be an object"],
    ["an array", [], "trigger must be an object"],
    [
      "the wrong kind",
      { ...good, kind: "schedule" },
      "trigger.kind must be one of: charge-session, exercise",
    ],
    [
      "a bad source kind",
      { ...good, source: { kind: "vibes", id: DX_UUID } },
      "trigger.source.kind must be one of: derivation, point",
    ],
    [
      "a non-uuid derivation id",
      { ...good, source: { kind: "derivation", derivationId: DX } },
      "trigger.source.derivationId must be a derivation id",
    ],
    [
      "a non-uuid point id",
      { ...good, source: { kind: "point", pointId: "nope" } },
      "trigger.source.pointId must be a point id",
    ],
    [
      "neither threshold",
      { kind: "charge-session", source: good.source },
      "trigger must set at least one of afterMinutes, afterKwh",
    ],
    [
      "a zero threshold",
      { ...good, afterMinutes: 0 },
      "trigger.afterMinutes must be greater than 0",
    ],
    [
      "a negative threshold",
      { ...good, afterKwh: -1 },
      "trigger.afterKwh must be greater than 0",
    ],
    [
      "a NaN threshold",
      { ...good, afterMinutes: NaN },
      "trigger.afterMinutes must be a finite number",
    ],
    [
      "a stringly threshold",
      { ...good, afterKwh: "20" },
      "trigger.afterKwh must be a finite number",
    ],
  ])("rejects %s", (_label, raw, error) => {
    expect(parseAutomationTrigger(raw)).toEqual({ ok: false, error });
  });
});

describe("parseAutomationAction", () => {
  it("accepts the one v1 action", () => {
    const a = {
      kind: "point-action",
      pointId: ACTION_PT_UUID,
      action: "turn_off",
    };
    expect(parseAutomationAction(a)).toEqual({ ok: true, value: a });
  });

  it.each([
    ["a non-object", null, "action must be an object"],
    [
      "the wrong kind",
      { kind: "webhook", pointId: ACTION_PT_UUID, action: "turn_off" },
      "action.kind must be 'point-action'",
    ],
    [
      "a non-uuid point",
      { kind: "point-action", pointId: ACTION_PT, action: "turn_off" },
      "action.pointId must be a point id",
    ],
    [
      // The action set is CLOSED — `turn_on`/`press` are a later PR's decision, not something a
      // body may smuggle past us into a stored row the evaluator will one day dispatch.
      "turn_on",
      { kind: "point-action", pointId: ACTION_PT_UUID, action: "turn_on" },
      "action.action must be one of: turn_off, set_value",
    ],
  ])("rejects %s", (_label, raw, error) => {
    expect(parseAutomationAction(raw)).toEqual({ ok: false, error });
  });
});

describe("parseArmedContext", () => {
  it("reads a snapshotted baseline", () => {
    expect(parseArmedContext({ baselineKwh: 42.5, baselineAt: 1234 })).toEqual({
      baselineKwh: 42.5,
      baselineAt: 1234,
    });
  });

  it("🛑 carries the exercise run counts — the parser is an ALLOW-LIST", () => {
    // It rebuilds the object field by field, so a field added to `ExerciseArmedContext` and to the
    // writer is silently DROPPED on read unless it is named in the parser too. These two are what
    // separate "the engine was idle all week" from "the only run was the one we commanded".
    expect(
      parseArmedContext({
        kind: "exercise",
        slotAt: 1000,
        at: 2000,
        outcome: "fired",
        runsConsidered: 0,
        runsExcluded: 1,
      }),
    ).toEqual({
      kind: "exercise",
      slotAt: 1000,
      at: 2000,
      outcome: "fired",
      runsConsidered: 0,
      runsExcluded: 1,
    });
  });

  it("omits the run counts when an older row does not carry them", () => {
    expect(
      parseArmedContext({
        kind: "exercise",
        slotAt: 1000,
        at: 2000,
        outcome: "satisfied",
      }),
    ).toEqual({
      kind: "exercise",
      slotAt: 1000,
      at: 2000,
      outcome: "satisfied",
    });
  });

  it("degrades a malformed value to null rather than throwing", () => {
    // This is state WE wrote, so a bad value is our bug; "no baseline" (kWh leg inert) is the
    // right failure, never a crash of the whole minutely pass.
    expect(parseArmedContext(null)).toBeNull();
    expect(parseArmedContext("garbage")).toBeNull();
    expect(parseArmedContext({ baselineKwh: "42.5" })).toBeNull();
    expect(parseArmedContext({})).toBeNull();
  });
});

describe("wire codecs", () => {
  it("triggerFromWire decodes dx_ to a raw uuid", () => {
    expect(
      triggerFromWire({
        kind: "charge-session",
        source: { kind: "derivation", derivationId: DX },
        afterMinutes: 60,
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "charge-session",
        source: { kind: "derivation", derivationId: DX_UUID },
        afterMinutes: 60,
      },
    });
  });

  it("triggerFromWire decodes pt_ to a raw uuid", () => {
    const parsed = triggerFromWire({
      kind: "charge-session",
      source: { kind: "point", pointId: PT },
      afterKwh: 20,
    });
    expect(parsed.ok && parsed.value.source).toEqual({
      kind: "point",
      pointId: PT_UUID,
    });
  });

  it("a malformed TypeID is a parse failure, never a silent null", () => {
    expect(
      triggerFromWire({
        kind: "charge-session",
        source: { kind: "derivation", derivationId: "dx_nonsense" },
        afterMinutes: 1,
      }),
    ).toEqual({
      ok: false,
      error: "trigger.source.derivationId must be a dx_ derivation id",
    });
    // A point TypeID where a derivation is expected is equally a failure — a generic
    // "encode anything uuid-shaped" sweep would have accepted it and surfaced the mistake much
    // later as a mystery "point not found".
    expect(
      triggerFromWire({
        kind: "charge-session",
        source: { kind: "derivation", derivationId: PT },
        afterMinutes: 1,
      }).ok,
    ).toBe(false);
    expect(
      actionFromWire({ kind: "point-action", pointId: DX, action: "turn_off" })
        .ok,
    ).toBe(false);
  });

  it("actionFromWire decodes pt_ to a raw uuid", () => {
    expect(
      actionFromWire({
        kind: "point-action",
        pointId: ACTION_PT,
        action: "turn_off",
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "point-action",
        pointId: ACTION_PT_UUID,
        action: "turn_off",
      },
    });
  });

  const row = (over: Partial<AutomationRow> = {}): AutomationRow =>
    ({
      id: AU_UUID,
      areaId: AR_UUID,
      name: "Charge limit",
      enabled: true,
      mode: "once",
      trigger: {
        kind: "charge-session",
        source: { kind: "point", pointId: PT_UUID },
        afterKwh: 20,
      },
      action: {
        kind: "point-action",
        pointId: ACTION_PT_UUID,
        action: "turn_off",
      },
      armedAt: null,
      lastTriggeredAt: null,
      lastTriggeredRunStart: null,
      armedContext: { baselineKwh: 42.5, baselineAt: 1234 },
      createdAt: new Date(0),
      updatedAt: new Date(0),
      revision: 1,
      ...over,
    }) as AutomationRow;

  it("automationWire encodes every id back to its TypeID", () => {
    const w = automationWire(row());
    expect(w.id).toBe(AU);
    expect(w.areaId).toBe(AR);
    expect(w.trigger).toEqual({
      kind: "charge-session",
      source: { kind: "point", pointId: PT },
      afterKwh: 20,
    });
    expect(w.action).toEqual({
      kind: "point-action",
      pointId: ACTION_PT,
      action: "turn_off",
    });
    // PR-G's "12.4 kWh so far" reads the baseline off the wire.
    expect(w.armedContext).toEqual({ baselineKwh: 42.5, baselineAt: 1234 });
  });

  it("encodes a derivation-sourced trigger as dx_, not pt_", () => {
    const w = automationWire(
      row({
        trigger: {
          kind: "charge-session",
          source: { kind: "derivation", derivationId: DX_UUID },
          afterMinutes: 45,
        },
      }),
    );
    expect(w.trigger).toEqual({
      kind: "charge-session",
      source: { kind: "derivation", derivationId: DX },
      afterMinutes: 45,
    });
  });

  it("serves an unparseable stored row with the field NULLED, not guessed at", () => {
    // It stays listable — so a hand-broken row can be seen and deleted — but nothing claims to
    // know what it means.
    const w = automationWire(
      row({ trigger: { kind: "nonsense" } as never, action: null as never }),
    );
    expect(w.trigger).toBeNull();
    expect(w.action).toBeNull();
    expect(w.id).toBe(AU);
  });
});
