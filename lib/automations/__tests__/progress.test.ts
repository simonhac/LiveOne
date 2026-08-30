/**
 * The charge-limit UI's arithmetic, pinned case by case.
 *
 * 🛑 The test this file exists for is "the trap, with the measured numbers": Tesla's
 * `charge_energy_added` is energy-above-plug-in-baseline, so a car re-entering `Charging` on an
 * overnight top-up ALREADY reads ~42.5 kWh. A progress figure taken from the raw counter would
 * render "42.5 of 20 kWh" against a limit armed seconds ago and delivering nothing. The delta
 * cases below are written so that switching `pointProgressKwh` to return the absolute counter
 * turns them red.
 *
 * The final block cross-checks the UI's arithmetic against `decideAutomation` itself, so the two
 * cannot drift: whatever the tile says is "12.4 of 20 so far" is the same comparison the evaluator
 * will fire on a minute later.
 */
import { describe, expect, it } from "@jest/globals";
import { Area, Automation, Derivation, Device, Point } from "@/lib/ids";
import {
  areaIdOfDatum,
  compareChargeLimits,
  describeChargeLimit,
  formatChargeLimitCompact,
  formatChargeLimitLine,
  selectChargeLimits,
  summaryWords,
  targetWords,
  type ChargeLimitJson,
} from "@/lib/automations/progress";
import {
  decideAutomation,
  type DecisionInputs,
  type SourceState,
} from "@/lib/automations/decide";

const AR = Area.generate();
const ACTIVE_PT = Point.generate();
const ADDED_PT = Point.generate();
const OTHER_PT = Point.generate();
const DX = Derivation.generate();

const T0 = 1_700_000_000_000; // fixed arbitrary epoch-ms
const MIN = 60_000;

function limit(over: Partial<ChargeLimitJson> = {}): ChargeLimitJson {
  return {
    id: Automation.generate(),
    name: "Charge limit",
    enabled: true,
    mode: "once",
    trigger: {
      kind: "charge-session",
      source: { kind: "point", pointId: ADDED_PT },
      afterKwh: 20,
    },
    action: { kind: "point-action", pointId: ACTIVE_PT, action: "turn_off" },
    armedAt: new Date(T0).toISOString(),
    lastTriggeredAt: null,
    armedContext: { baselineKwh: 42.5, baselineAt: T0 },
    ...over,
  };
}

describe("areaIdOfDatum", () => {
  const cases: Array<{ name: string; data: unknown; expected: string | null }> =
    [
      {
        name: "an area-shaped datum yields its ar_ id",
        data: { area: { areaId: AR } },
        expected: AR,
      },
      {
        name: "a device-shaped datum has no area leg",
        data: { device: { id: 1, deviceId: "dv_x" } },
        expected: null,
      },
      {
        name: "a TypeID of the wrong entity is rejected",
        data: { area: { areaId: Device.generate() } },
        expected: null,
      },
      {
        name: "a malformed id is rejected",
        data: { area: { areaId: "ar_!!" } },
        expected: null,
      },
      {
        name: "a non-string id is rejected",
        data: { area: { areaId: 7 } },
        expected: null,
      },
      { name: "null is null", data: null, expected: null },
      { name: "a non-object is null", data: "ar_whatever", expected: null },
      { name: "undefined is null", data: undefined, expected: null },
    ];
  it.each(cases)("$name", ({ data, expected }) => {
    expect(areaIdOfDatum(data)).toBe(expected);
  });
});

describe("selectChargeLimits", () => {
  it("keeps only rules aimed at THIS car's charge switch", () => {
    const mine = limit();
    const theirs = limit({
      action: { kind: "point-action", pointId: OTHER_PT, action: "turn_off" },
    });
    expect(selectChargeLimits([mine, theirs], ACTIVE_PT)).toEqual([mine]);
  });

  it("excludes rows whose action failed to parse server-side", () => {
    expect(selectChargeLimits([limit({ action: null })], ACTIVE_PT)).toEqual(
      [],
    );
  });

  it("returns nothing when the switch point is unknown", () => {
    expect(selectChargeLimits([limit()], null)).toEqual([]);
  });
});

describe("🛑 the kWh figure is the DELTA above the armed baseline", () => {
  it("shows 12.4 so far on an overnight top-up, not the counter's 54.9", () => {
    // The measured shape: baseline snapshotted at arm (42.5), counter now 54.9, target 20.
    const desc = describeChargeLimit(
      limit(),
      { valueKwh: 54.9 },
      ADDED_PT,
      T0 + 30 * MIN,
    );
    expect(desc.soFarKwh).toBeCloseTo(12.4, 6);
    expect(desc.soFarKwh).not.toBeCloseTo(54.9, 1);
    expect(desc.targetKwh).toBe(20);
    // And the rendered line must not claim the limit is already blown.
    expect(formatChargeLimitLine(desc)).toBe(
      "Stopping at 20.0 kWh (12.4 so far)",
    );
  });

  it("shows 0.0 so far the instant it arms — the counter still reads 42.5", () => {
    const desc = describeChargeLimit(limit(), { valueKwh: 42.5 }, ADDED_PT, T0);
    expect(desc.soFarKwh).toBe(0);
    expect(formatChargeLimitCompact(desc)).toBe("→ 0.0 / 20.0 kWh");
  });

  it("clamps vampire sag at zero rather than going negative", () => {
    const desc = describeChargeLimit(
      limit(),
      { valueKwh: 42.2 },
      ADDED_PT,
      T0 + MIN,
    );
    expect(desc.soFarKwh).toBe(0);
  });

  it("shows the target ONLY when there is no baseline", () => {
    const desc = describeChargeLimit(
      limit({ armedContext: null }),
      { valueKwh: 54.9 },
      ADDED_PT,
      T0 + MIN,
    );
    expect(desc.soFarKwh).toBeNull();
    expect(formatChargeLimitLine(desc)).toBe("Stopping at 20.0 kWh");
  });

  it("shows the target ONLY when the counter is missing from the latest map", () => {
    expect(
      describeChargeLimit(limit(), null, ADDED_PT, T0 + MIN).soFarKwh,
    ).toBeNull();
  });

  it("refuses to measure against a counter that is not the trigger's source", () => {
    expect(
      describeChargeLimit(limit(), { valueKwh: 54.9 }, OTHER_PT, T0 + MIN)
        .soFarKwh,
    ).toBeNull();
    expect(
      describeChargeLimit(limit(), { valueKwh: 54.9 }, null, T0 + MIN).soFarKwh,
    ).toBeNull();
  });

  it("gives a derivation-sourced rule targets only — its anchor is server-side", () => {
    const desc = describeChargeLimit(
      limit({
        trigger: {
          kind: "charge-session",
          source: { kind: "derivation", derivationId: DX },
          afterKwh: 20,
          afterMinutes: 60,
        },
      }),
      { valueKwh: 54.9 },
      ADDED_PT,
      T0 + 26 * MIN,
    );
    expect(desc.soFarKwh).toBeNull();
    expect(desc.remainingMinutes).toBeNull();
    expect(desc.targetKwh).toBe(20);
    expect(desc.targetMinutes).toBe(60);
  });
});

describe("remainingMinutes", () => {
  const minutesRule = limit({
    trigger: {
      kind: "charge-session",
      source: { kind: "point", pointId: ADDED_PT },
      afterMinutes: 60,
    },
  });

  it("counts down from armedAt: armed 26 min ago against a 60 min limit → 34", () => {
    expect(
      describeChargeLimit(minutesRule, null, ADDED_PT, T0 + 26 * MIN)
        .remainingMinutes,
    ).toBe(34);
  });

  it("clamps at 0 once the limit is past due", () => {
    expect(
      describeChargeLimit(minutesRule, null, ADDED_PT, T0 + 90 * MIN)
        .remainingMinutes,
    ).toBe(0);
  });

  it("is null when the rule has no minutes leg", () => {
    expect(
      describeChargeLimit(limit(), { valueKwh: 43 }, ADDED_PT, T0 + MIN)
        .remainingMinutes,
    ).toBeNull();
  });

  it("is null while the rule is still waiting to arm", () => {
    expect(
      describeChargeLimit(
        limit({ ...minutesRule, armedAt: null }),
        null,
        ADDED_PT,
        T0 + 26 * MIN,
      ).remainingMinutes,
    ).toBeNull();
  });
});

describe("state machine", () => {
  const cases: Array<{
    name: string;
    row: Partial<ChargeLimitJson>;
    expected: string;
  }> = [
    { name: "enabled and armed → armed", row: {}, expected: "armed" },
    {
      name: "enabled, not yet armed → waiting",
      row: { armedAt: null },
      expected: "waiting",
    },
    {
      name: "an unparseable armedAt is not arming",
      row: { armedAt: "not-a-date" },
      expected: "waiting",
    },
    {
      name: "disabled after firing → stopped",
      row: {
        enabled: false,
        lastTriggeredAt: new Date(T0 + 40 * MIN).toISOString(),
      },
      expected: "stopped",
    },
    {
      name: "disabled without ever firing → off",
      row: { enabled: false, mode: "standing", armedAt: null },
      expected: "off",
    },
  ];
  it.each(cases)("$name", ({ row, expected }) => {
    expect(
      describeChargeLimit(limit(row), { valueKwh: 50 }, ADDED_PT, T0 + MIN)
        .state,
    ).toBe(expected);
  });

  it("reports no live line for anything but armed", () => {
    for (const row of [
      { armedAt: null },
      { enabled: false, lastTriggeredAt: new Date(T0).toISOString() },
      { enabled: false },
    ]) {
      const desc = describeChargeLimit(
        limit(row),
        { valueKwh: 50 },
        ADDED_PT,
        T0,
      );
      expect(formatChargeLimitLine(desc)).toBeNull();
      expect(formatChargeLimitCompact(desc)).toBeNull();
    }
  });
});

describe("formatChargeLimitLine", () => {
  it("joins both legs", () => {
    const desc = describeChargeLimit(
      limit({
        trigger: {
          kind: "charge-session",
          source: { kind: "point", pointId: ADDED_PT },
          afterMinutes: 60,
          afterKwh: 20,
        },
      }),
      { valueKwh: 54.9 },
      ADDED_PT,
      T0 + 26 * MIN,
    );
    expect(formatChargeLimitLine(desc)).toBe(
      "Stopping in 34\u00A0min · at 20.0 kWh (12.4 so far)",
    );
  });

  it("renders a minutes-only rule", () => {
    const desc = describeChargeLimit(
      limit({
        trigger: {
          kind: "charge-session",
          source: { kind: "point", pointId: ADDED_PT },
          afterMinutes: 60,
        },
      }),
      null,
      ADDED_PT,
      T0 + 26 * MIN,
    );
    expect(formatChargeLimitLine(desc)).toBe("Stopping in 34\u00A0min");
    expect(formatChargeLimitCompact(desc)).toBe("→ 34\u00A0min");
  });

  it("keeps one decimal on kWh", () => {
    const desc = describeChargeLimit(
      limit(),
      { valueKwh: 42.5 + 3.456 },
      ADDED_PT,
      T0,
    );
    expect(formatChargeLimitLine(desc)).toBe(
      "Stopping at 20.0 kWh (3.5 so far)",
    );
  });
});

describe("targetWords / summaryWords", () => {
  it.each([
    [30, undefined, "30\u00A0min"],
    [undefined, 20, "20 kWh"],
    [30, 20, "30\u00A0min or 20 kWh"],
    [undefined, undefined, ""],
  ] as const)("targetWords(%p, %p) → %p", (min, k, expected) => {
    expect(targetWords(min, k)).toBe(expected);
  });

  it("summaryWords promises this charge for a once rule", () => {
    expect(summaryWords("once", 15, 6)).toBe(
      "Will stop this charge after 15\u00A0min or 6 kWh.",
    );
  });

  it("summaryWords promises every charge for a standing rule", () => {
    expect(summaryWords("standing", 30, undefined)).toBe(
      "Will stop every charge after 30\u00A0min.",
    );
  });

  it("summaryWords is null with no target — nothing to promise", () => {
    expect(summaryWords("once", undefined, undefined)).toBeNull();
  });
});

describe("compareChargeLimits", () => {
  it("orders armed → waiting → stopped → off, then by name", () => {
    const rows = [
      { state: "off" as const, name: "b" },
      { state: "stopped" as const, name: "a" },
      { state: "waiting" as const, name: "z" },
      { state: "armed" as const, name: "q" },
      { state: "waiting" as const, name: "a" },
    ];
    expect(
      [...rows].sort(compareChargeLimits).map((r) => `${r.state}/${r.name}`),
    ).toEqual(["armed/q", "waiting/a", "waiting/z", "stopped/a", "off/b"]);
  });
});

/**
 * 🛑 Anti-drift tripwire. The UI number and the evaluator's firing comparison must be the SAME
 * arithmetic, so a rule the tile shows as "19.9 of 20" has not already fired, and one it shows at
 * "20.0 of 20" has. Built on real `DecisionInputs`/`SourceState` values so a future divergence
 * reddens here rather than in production, silently.
 */
describe("cross-check against decideAutomation", () => {
  function decisionFor(
    row: ChargeLimitJson,
    counterKwh: number | null,
    nowMs: number,
  ) {
    const trigger = row.trigger!;
    const inputs: DecisionInputs = {
      mode: row.mode as "once" | "standing",
      sourceKind: "point",
      afterMinutes: trigger.afterMinutes ?? null,
      afterKwh: trigger.afterKwh ?? null,
      armedAtMs: row.armedAt ? Date.parse(row.armedAt) : null,
      armedContext: row.armedContext ?? null,
      lastTriggeredRunStartMs: null,
    };
    const src: SourceState = {
      status: "active",
      runStartMs: null,
      runKwh: null,
      counter:
        counterKwh == null ? null : { valueKwh: counterKwh, atMs: nowMs },
      anchorToleranceMs: 0,
    };
    return decideAutomation(inputs, src, nowMs);
  }

  // baseline 42.5, target 20 ⇒ the evaluator fires at a counter of 62.5.
  const kwhCases = [42.5, 50, 62.4, 62.5, 70];
  it.each(kwhCases)(
    "kWh leg: 'so far >= target' agrees with fire (counter %p)",
    (counter) => {
      const row = limit();
      const nowMs = T0 + 10 * MIN;
      const desc = describeChargeLimit(
        row,
        { valueKwh: counter },
        ADDED_PT,
        nowMs,
      );
      const fired = decisionFor(row, counter, nowMs).kind === "fire";
      expect(desc.soFarKwh != null && desc.soFarKwh >= desc.targetKwh!).toBe(
        fired,
      );
    },
  );

  const minutesCases = [0, 26, 59, 60, 75];
  it.each(minutesCases)(
    "minutes leg: 'remaining === 0' agrees with fire (armed %p min ago)",
    (elapsed) => {
      const row = limit({
        trigger: {
          kind: "charge-session",
          source: { kind: "point", pointId: ADDED_PT },
          afterMinutes: 60,
        },
      });
      const nowMs = T0 + elapsed * MIN;
      const desc = describeChargeLimit(row, null, ADDED_PT, nowMs);
      const fired = decisionFor(row, null, nowMs).kind === "fire";
      expect(desc.remainingMinutes === 0).toBe(fired);
    },
  );
});
