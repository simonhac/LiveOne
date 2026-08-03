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
      "trigger.kind must be 'charge-session'",
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
    const a = { kind: "point-action", pointId: ACTION_PT_UUID, action: "turn_off" };
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
      // The v1 action set is CLOSED — opening it is a later PR's decision, not something a body
      // may smuggle past us into a stored row the evaluator will one day dispatch.
      "turn_on",
      { kind: "point-action", pointId: ACTION_PT_UUID, action: "turn_on" },
      "action.action must be 'turn_off' (the v1 action set is closed)",
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
    expect(actionFromWire({ kind: "point-action", pointId: DX, action: "turn_off" }).ok).toBe(
      false,
    );
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
