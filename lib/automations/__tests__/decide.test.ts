/**
 * The decision table of `decide.ts`, pinned row by row.
 *
 * Two tests here are the ones the whole PR exists to protect:
 *
 *  1. 🛑 **"overnight top-up does not fire instantly"** — Tesla's `charge_energy_added` is
 *     energy-above-plug-in-baseline, so a car re-entering `Charging` on an overnight top-up ALREADY
 *     reads ~42.5 kWh. Under absolute-threshold logic (`counter >= afterKwh`) a "stop after 20 kWh"
 *     rule fires on the very first tick, every night. The test asserts the delta semantics such that
 *     switching the comparison to absolute turns it red.
 *  2. 🛑 **"the source point resets mid-session"** — the counter resets only per CABLE session, and
 *     a sleeping car emits no samples, so a replug can be entirely invisible to polling. The only
 *     surviving evidence is a counter arriving far BELOW the armed baseline: that must DISARM, and
 *     it must be checked BEFORE the already-fired suppression.
 *
 * Pure: `decide.ts` imports nothing impure, so there are no mocks and `nowMs` is injected.
 */
import { describe, it, expect } from "@jest/globals";
import {
  ACTIVE_FRESH_MS,
  ANCHOR_TOLERANCE_FLOOR_MS,
  RESET_EPSILON_KWH,
  decideAutomation,
  pointSourceState,
  type DecisionInputs,
  type SourceState,
} from "@/lib/automations/decide";

const T0 = 1_700_000_000_000; // fixed arbitrary epoch-ms
const MIN = 60_000;

function inputs(over: Partial<DecisionInputs> = {}): DecisionInputs {
  return {
    mode: "standing",
    sourceKind: "point",
    afterMinutes: null,
    afterKwh: null,
    armedAtMs: null,
    armedContext: null,
    lastTriggeredRunStartMs: null,
    ...over,
  };
}

/** A point source: `counter` is the kWh reading, `status` the sibling `active` classification. */
function pointSrc(
  status: SourceState["status"],
  counterKwh: number | null,
  atMs = T0,
): SourceState {
  return {
    status,
    runStartMs: null,
    runKwh: null,
    counter: counterKwh == null ? null : { valueKwh: counterKwh, atMs },
    anchorToleranceMs: 0,
  };
}

function derivSrc(
  status: SourceState["status"],
  runStartMs: number | null,
  runKwh: number | null = null,
  anchorToleranceMs = ANCHOR_TOLERANCE_FLOOR_MS,
): SourceState {
  return { status, runStartMs, runKwh, counter: null, anchorToleranceMs };
}

describe("decideAutomation — arming", () => {
  it("arms a point source with the baseline taken from the READING, not nowMs", () => {
    const d = decideAutomation(
      inputs({ afterKwh: 20 }),
      pointSrc("active", 42.5, T0 - 90_000),
      T0,
    );
    expect(d).toEqual({
      kind: "arm",
      armedContext: { baselineKwh: 42.5, baselineAt: T0 - 90_000 },
    });
  });

  it("arms a derivation source with no armed context", () => {
    const d = decideAutomation(
      inputs({ sourceKind: "derivation", afterMinutes: 60 }),
      derivSrc("active", T0 - MIN),
      T0,
    );
    expect(d).toEqual({ kind: "arm", armedContext: null });
  });

  it("refuses to arm a kWh limit whose counter is unreadable", () => {
    // Arming without a baseline would leave the cap silently unenforced for the whole session.
    expect(
      decideAutomation(inputs({ afterKwh: 20 }), pointSrc("active", null), T0),
    ).toEqual({ kind: "none" });
  });

  it("arms a minutes-only point limit even without a counter", () => {
    expect(
      decideAutomation(
        inputs({ afterMinutes: 30 }),
        pointSrc("active", null),
        T0,
      ),
    ).toEqual({ kind: "arm", armedContext: null });
  });
});

describe("🛑 the kWh limit is a DELTA against the armed baseline", () => {
  // The measured overnight-top-up shape: the car re-enters `Charging` with the counter already at
  // 42.5 kWh (the real sawtooth, ~42.5 against a ~46 ceiling), and the user asked for 20 kWh.
  const BASELINE = 42.5;
  const a = inputs({ afterKwh: 20, mode: "standing", sourceKind: "point" });

  it("tick 1: arms at 42.5 and does NOT fire, even though 42.5 > 20", () => {
    const d = decideAutomation(a, pointSrc("active", BASELINE), T0);
    // 🛑 THE TRIPWIRE. Absolute-threshold logic (`counter >= afterKwh`) would make this a `fire`
    // on the very first tick of every overnight top-up.
    expect(d.kind).toBe("arm");
    expect(d).toEqual({
      kind: "arm",
      armedContext: { baselineKwh: BASELINE, baselineAt: T0 },
    });
  });

  it("tick 1, as the SHELL runs it: arm then re-invoke — and STILL no fire", () => {
    // The evaluator applies an `arm` and immediately re-invokes with the updated inputs. That
    // second call is where absolute-threshold logic actually pulls the trigger on a fresh overnight
    // top-up, so the sequence is asserted here rather than just the single decision above.
    const src = pointSrc("active", BASELINE);
    const first = decideAutomation(a, src, T0);
    expect(first.kind).toBe("arm");
    const second = decideAutomation(
      {
        ...a,
        armedAtMs: T0,
        armedContext: first.kind === "arm" ? first.armedContext : null,
      },
      src,
      T0,
    );
    expect(second).toEqual({ kind: "none" });
  });

  const armed = inputs({
    ...a,
    armedAtMs: T0,
    armedContext: { baselineKwh: BASELINE, baselineAt: T0 },
  });

  it("tick 2: counter 43.1 → delta 0.6, no fire (absolute logic would fire: 43.1 > 20)", () => {
    expect(
      decideAutomation(armed, pointSrc("active", 43.1), T0 + 5 * MIN),
    ).toEqual({ kind: "none" });
  });

  it("tick 3: counter 62.6 → delta 20.1, FIRES with the arm time as the anchor", () => {
    expect(
      decideAutomation(armed, pointSrc("active", 62.6), T0 + 90 * MIN),
    ).toEqual({ kind: "fire", anchorMs: T0 });
  });

  it("still does not fire one tick short of the threshold (delta 19.9)", () => {
    expect(
      decideAutomation(armed, pointSrc("active", 62.4), T0 + 90 * MIN),
    ).toEqual({ kind: "none" });
  });
});

describe("🛑 the source point resets mid-session (a slept-through replug)", () => {
  const BASELINE = 42.5;
  const RESET_COUNTER = 0.4; // 42.1 below the baseline — far past RESET_EPSILON_KWH

  it("disarms a `once` rather than firing", () => {
    expect(
      decideAutomation(
        inputs({
          mode: "once",
          afterKwh: 20,
          armedAtMs: T0,
          armedContext: { baselineKwh: BASELINE, baselineAt: T0 },
        }),
        pointSrc("active", RESET_COUNTER),
        T0 + 30 * MIN,
      ),
    ).toEqual({ kind: "disarm", disable: true });
  });

  it("disarms a `standing` rule without disabling it, so it re-arms on the new session", () => {
    expect(
      decideAutomation(
        inputs({
          mode: "standing",
          afterKwh: 20,
          armedAtMs: T0,
          armedContext: { baselineKwh: BASELINE, baselineAt: T0 },
        }),
        pointSrc("active", RESET_COUNTER),
        T0 + 30 * MIN,
      ),
    ).toEqual({ kind: "disarm", disable: false });
  });

  it("🛑 the reset check precedes already-fired", () => {
    // A standing rule that FIRED in the old session holds lastTriggeredRunStart === armedAt. If
    // already-fired ran first this would return `already-fired` and stay armed-and-suppressed for
    // the whole new session: kWh leg dead against the stale baseline, minutes leg suppressed.
    expect(
      decideAutomation(
        inputs({
          mode: "standing",
          afterMinutes: 30,
          afterKwh: 20,
          armedAtMs: T0,
          armedContext: { baselineKwh: BASELINE, baselineAt: T0 },
          lastTriggeredRunStartMs: T0,
        }),
        pointSrc("active", RESET_COUNTER),
        T0 + 30 * MIN,
      ),
    ).toEqual({ kind: "disarm", disable: false });
  });

  it("a vampire-drain dip below the baseline is NOT a reset: delta clamps to 0, no disarm", () => {
    const dip = decideAutomation(
      inputs({
        afterKwh: 20,
        armedAtMs: T0,
        armedContext: { baselineKwh: BASELINE, baselineAt: T0 },
      }),
      pointSrc("active", BASELINE - 0.3),
      T0 + 30 * MIN,
    );
    expect(dip).toEqual({ kind: "none" });
  });

  it("pins both sides of the epsilon", () => {
    const armed = inputs({
      afterKwh: 20,
      armedAtMs: T0,
      armedContext: { baselineKwh: BASELINE, baselineAt: T0 },
    });
    // exactly at the epsilon → still drain (the comparison is strictly greater-than)
    expect(
      decideAutomation(
        armed,
        pointSrc("active", BASELINE - RESET_EPSILON_KWH),
        T0 + MIN,
      ).kind,
    ).toBe("none");
    expect(
      decideAutomation(
        armed,
        pointSrc("active", BASELINE - RESET_EPSILON_KWH - 0.01),
        T0 + MIN,
      ).kind,
    ).toBe("disarm");
  });
});

describe("decideAutomation — the minutes leg", () => {
  it("a derivation source measures elapsed from the RUN START", () => {
    const a = inputs({
      sourceKind: "derivation",
      afterMinutes: 60,
      armedAtMs: T0 + 30 * MIN, // armed mid-run: irrelevant to a derivation source
    });
    const runStart = T0;
    expect(
      decideAutomation(a, derivSrc("active", runStart), runStart + 59 * MIN),
    ).toEqual({ kind: "none" });
    expect(
      decideAutomation(a, derivSrc("active", runStart), runStart + 60 * MIN),
    ).toEqual({ kind: "fire", anchorMs: runStart });
  });

  it("a `once` armed mid-run past its threshold arms then fires in the same tick", () => {
    // The shell applies the `arm` and re-invokes once with the updated inputs; that two-call shape
    // is what makes an automation created during a long charge take effect immediately.
    const a = inputs({
      mode: "once",
      sourceKind: "derivation",
      afterMinutes: 60,
    });
    const runStart = T0;
    const nowMs = runStart + 90 * MIN;
    const first = decideAutomation(a, derivSrc("active", runStart), nowMs);
    expect(first).toEqual({ kind: "arm", armedContext: null });
    const second = decideAutomation(
      { ...a, armedAtMs: nowMs, armedContext: null },
      derivSrc("active", runStart),
      nowMs,
    );
    expect(second).toEqual({ kind: "fire", anchorMs: runStart });
  });

  it("a point source measures elapsed from ARM time", () => {
    const a = inputs({ afterMinutes: 45, armedAtMs: T0 });
    expect(
      decideAutomation(a, pointSrc("active", 1), T0 + 44 * MIN),
    ).toEqual({ kind: "none" });
    expect(decideAutomation(a, pointSrc("active", 1), T0 + 45 * MIN)).toEqual({
      kind: "fire",
      anchorMs: T0,
    });
  });
});

describe("decideAutomation — both thresholds set, first to cross wins", () => {
  const a = inputs({
    afterMinutes: 60,
    afterKwh: 5,
    armedAtMs: T0,
    armedContext: { baselineKwh: 10, baselineAt: T0 },
  });

  it("kWh crosses first", () => {
    expect(decideAutomation(a, pointSrc("active", 15.2), T0 + 20 * MIN)).toEqual(
      { kind: "fire", anchorMs: T0 },
    );
  });

  it("minutes crosses first", () => {
    expect(decideAutomation(a, pointSrc("active", 11), T0 + 60 * MIN)).toEqual({
      kind: "fire",
      anchorMs: T0,
    });
  });
});

describe("decideAutomation — already-fired suppression", () => {
  it("derivation: a start that drifted less than the tolerance is the SAME run", () => {
    // `recomputeIntervalsForWindow` is a bounded delete-and-reinsert and midpoint boundaries move
    // an open run's start between ticks, so exact equality would refire every minute.
    const a = inputs({
      sourceKind: "derivation",
      afterMinutes: 10,
      armedAtMs: T0,
      lastTriggeredRunStartMs: T0,
    });
    expect(
      decideAutomation(a, derivSrc("active", T0 + 200_000), T0 + 60 * MIN),
    ).toEqual({ kind: "already-fired" });
  });

  it("derivation: a start beyond the tolerance is a genuinely new run", () => {
    const a = inputs({
      sourceKind: "derivation",
      afterMinutes: 10,
      armedAtMs: T0,
      lastTriggeredRunStartMs: T0,
    });
    const newStart = T0 + ANCHOR_TOLERANCE_FLOOR_MS + 1000;
    expect(
      decideAutomation(a, derivSrc("active", newStart), newStart + 30 * MIN),
    ).toEqual({ kind: "fire", anchorMs: newStart });
  });

  it("🛑 point: the anchor comparison is EXACT, never a tolerance", () => {
    // Fired at T (anchor = armedAt = T), disarmed, the user restarted the charge, re-armed at
    // T+180 s — inside what a 300 s tolerance would suppress. It must still be eligible to fire.
    // Applying the derivation tolerance here would suppress the new arming forever, because both
    // timestamps are values WE wrote and neither ever drifts.
    const rearmedAt = T0 + 180_000;
    const a = inputs({
      afterMinutes: 10,
      armedAtMs: rearmedAt,
      armedContext: { baselineKwh: 1, baselineAt: rearmedAt },
      lastTriggeredRunStartMs: T0,
    });
    expect(
      decideAutomation(a, pointSrc("active", 3), rearmedAt + 30 * MIN),
    ).toEqual({ kind: "fire", anchorMs: rearmedAt });
  });

  it("point: the same arming does not refire", () => {
    const a = inputs({
      afterMinutes: 10,
      armedAtMs: T0,
      armedContext: { baselineKwh: 1, baselineAt: T0 },
      lastTriggeredRunStartMs: T0,
    });
    expect(decideAutomation(a, pointSrc("active", 3), T0 + 30 * MIN)).toEqual({
      kind: "already-fired",
    });
  });
});

describe("decideAutomation — lifecycle and inertness", () => {
  it("`once` + inactive disables, armed or not", () => {
    // "This session" must never latch onto a FUTURE session — a stale limit stopping a charge
    // weeks later is the worse surprise.
    expect(
      decideAutomation(
        inputs({ mode: "once", afterMinutes: 10 }),
        pointSrc("inactive", 5),
        T0,
      ),
    ).toEqual({ kind: "disarm", disable: true });
    expect(
      decideAutomation(
        inputs({ mode: "once", afterMinutes: 10, armedAtMs: T0 }),
        pointSrc("inactive", 5),
        T0 + MIN,
      ),
    ).toEqual({ kind: "disarm", disable: true });
  });

  it("`standing` + inactive: disarms when armed, does nothing when not", () => {
    expect(
      decideAutomation(
        inputs({ afterMinutes: 10, armedAtMs: T0 }),
        pointSrc("inactive", 5),
        T0 + MIN,
      ),
    ).toEqual({ kind: "disarm", disable: false });
    expect(
      decideAutomation(
        inputs({ afterMinutes: 10 }),
        pointSrc("inactive", 5),
        T0,
      ),
    ).toEqual({ kind: "none" });
  });

  it("unknown is inert in both directions — never fires, never disarms", () => {
    expect(
      decideAutomation(
        inputs({ afterMinutes: 1, armedAtMs: T0 }),
        pointSrc("unknown", 99),
        T0 + 10 * MIN,
      ),
    ).toEqual({ kind: "none" });
    expect(
      decideAutomation(
        inputs({ mode: "once", afterMinutes: 1 }),
        pointSrc("unknown", 99),
        T0,
      ),
    ).toEqual({ kind: "none" });
  });

  it("🛑 a derivation kWh leg fires off the RUN's own energy", () => {
    // The only path by which `derived_intervals.energy_kwh` reaches a decision, pinned here in the
    // pure layer; its wiring twin lives in evaluate.test.ts ("a kWh leg fires off the OPEN RUN's
    // own energy"). Before the pair existed, no test anywhere exercised a non-null `runKwh`, so a
    // resolver that dropped the run's energy (`runKwh: null`) left every energy-based derivation
    // limit silently dead with the whole suite green. Keep both halves.
    const a = inputs({
      sourceKind: "derivation",
      afterKwh: 20,
      armedAtMs: T0, // armed; no lastTriggeredRunStart, so nothing suppresses the fire
    });
    expect(
      decideAutomation(a, derivSrc("active", T0, 19.9), T0 + 30 * MIN),
    ).toEqual({ kind: "none" });
    expect(
      decideAutomation(a, derivSrc("active", T0, 20), T0 + 30 * MIN),
    ).toEqual({ kind: "fire", anchorMs: T0 });
  });

  it("an unpriceable derivation run leaves only the minutes leg live", () => {
    const a = inputs({
      sourceKind: "derivation",
      afterMinutes: 60,
      afterKwh: 5,
      armedAtMs: T0,
    });
    expect(
      decideAutomation(a, derivSrc("active", T0, null), T0 + 30 * MIN),
    ).toEqual({ kind: "none" });
    expect(
      decideAutomation(a, derivSrc("active", T0, null), T0 + 60 * MIN),
    ).toEqual({ kind: "fire", anchorMs: T0 });
  });

  it("an armed point limit with no counter this tick leaves only the minutes leg live", () => {
    const a = inputs({
      afterMinutes: 60,
      afterKwh: 5,
      armedAtMs: T0,
      armedContext: { baselineKwh: 10, baselineAt: T0 },
    });
    expect(decideAutomation(a, pointSrc("active", null), T0 + 30 * MIN)).toEqual(
      { kind: "none" },
    );
    expect(decideAutomation(a, pointSrc("active", null), T0 + 60 * MIN)).toEqual(
      { kind: "fire", anchorMs: T0 },
    );
  });
});

describe("pointSourceState", () => {
  it("a fresh 1 is active", () => {
    const s = pointSourceState(
      { valueKwh: 3, atMs: T0 - MIN },
      { value: 1, atMs: T0 - MIN },
      T0,
    );
    expect(s.status).toBe("active");
    expect(s.counter).toEqual({ valueKwh: 3, atMs: T0 - MIN });
    expect(s.anchorToleranceMs).toBe(0);
  });

  it("a 0 at any age inside the lookback is inactive", () => {
    expect(
      pointSourceState(null, { value: 0, atMs: T0 - 25 * MIN }, T0).status,
    ).toBe("inactive");
  });

  it("🛑 a STALE 1 is unknown, not active", () => {
    // A poll outage mid-charge must neither fire a limit nor kill one. (Stale-0 fails safe by
    // disarming; stale-1 is the dangerous direction and is deliberately inert.)
    expect(
      pointSourceState(
        { valueKwh: 3, atMs: T0 - 20 * MIN },
        { value: 1, atMs: T0 - ACTIVE_FRESH_MS - 1000 },
        T0,
      ).status,
    ).toBe("unknown");
    expect(
      pointSourceState(null, { value: 1, atMs: T0 - ACTIVE_FRESH_MS }, T0)
        .status,
    ).toBe("active");
  });

  it("🛑 a fresh value that is neither 0 nor 1 is unknown, not active", () => {
    // The point carries a boolean transform, so nothing else should ever arrive — but `unknown`
    // is the deliberately SAFE state ("do not act"), and a corrupt reading must fail into it
    // rather than being read as a live charge and firing a limit.
    for (const value of [2, -1, 0.5, NaN]) {
      expect(
        pointSourceState(
          { valueKwh: 3, atMs: T0 - MIN },
          { value, atMs: T0 - MIN },
          T0,
        ).status,
      ).toBe("unknown");
    }
  });

  it("no sample in the lookback is unknown", () => {
    expect(pointSourceState(null, null, T0).status).toBe("unknown");
  });
});
