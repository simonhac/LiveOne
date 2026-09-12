/**
 * The DB shell around the (separately table-tested) decision core: `lib/automations/evaluate.ts`.
 *
 * `decide.ts` is pure and pinned row-by-row elsewhere. What is NOT pinned anywhere else is the
 * WIRING — the seams between that table and the real world, where a subtly wrong resolver means a
 * charge limit silently never fires, or fires on the wrong signal:
 *
 *  1. 🛑 **The `fire()` outcome switch.** `completed{ok:false}` is Tesla's benign `not_charging`
 *     decline on an idle car: the goal state ALREADY holds, so it is success-and-disarm — it must
 *     record the fire (which is what suppresses the next tick) and must NOT pay for a confirmation
 *     re-poll. `rejected` is a PERMANENT protocol refusal for this vehicle and must DISABLE the
 *     rule; every other failure kind is transient and must leave it armed. Get any of those three
 *     backwards and you get either a per-minute command flood or a limit that quietly stops
 *     existing.
 *  2. 🛑 **`unknown` is not `inactive`.** A deleted detector, a missing point, a missing `active`
 *     sibling or a stale reading must all classify as `unknown` — because `inactive` DISABLES a
 *     `once`, so mistaking "we can't see it" for "it stopped" silently deletes a user's rule.
 *  3. **One bad row cannot take out the pass.** This is a best-effort cron step; a throwing
 *     automation is counted and stepped over.
 *
 * Every private function here (`resolveDerivationSource`, `resolvePointSource`, `fire`) is reached
 * through the single export, with the collaborators mocked — so these assertions are on the real
 * wiring and on OBSERVABLE effects (what was written, what was called), never on internals.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Area, Automation, Derivation, Point } from "@/lib/ids";
import type { PointActionOutcome } from "@/lib/control/point-actions";

const AU_UUID = Automation.toUuid(Automation.generate());
const AREA_UUID = Area.toUuid(Area.generate());
const DX_UUID = Derivation.toUuid(Derivation.generate());
const OTHER_DX_UUID = Derivation.toUuid(Derivation.generate());
const SRC_PT = Point.generate();
const SRC_PT_UUID = Point.toUuid(SRC_PT);
const ACTIVE_PT = Point.generate();
const ACTIVE_PT_UUID = Point.toUuid(ACTIVE_PT);
const ACT_PT_UUID = Point.toUuid(Point.generate());

// 🛑 Mocking the store wholesale is right for testing the EVALUATOR, and it is also why the
// microsecond-precision CAS bug shipped: with `claimExerciseDispatch` stubbed, no test anywhere ran
// that module's SQL, and a predicate matching nothing looked exactly like one that worked. The SQL
// itself is pinned in `store-claim.test.ts` (codec + generated SQL) and `store.integration.test.ts`
// (executed against a real Postgres). Do not try to cover it from here — it structurally cannot be.
jest.mock("@/lib/automations/store", () => ({
  listEnabled: jest.fn(),
  armAutomation: jest.fn(),
  disarmAutomation: jest.fn(),
  recordFired: jest.fn(),
  disableAutomation: jest.fn(),
  intervalsOverlapping: jest.fn(),
  recordExerciseOutcome: jest.fn(),
  claimExerciseDispatch: jest.fn(),
}));
jest.mock("@/lib/run-tracking/live", () => ({ getOpenRun: jest.fn() }));
jest.mock("@/lib/derivations/resolve", () => ({
  listEnabledRunDetectors: jest.fn(),
}));
jest.mock("@/lib/control/point-actions", () => ({
  loadPointByUuid: jest.fn(),
  loadPointByStemMetric: jest.fn(),
  dispatchPointAction: jest.fn(),
}));
jest.mock("@/lib/control/repoll", () => ({ scheduleRepoll: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle: jest.fn() },
}));
jest.mock("@/lib/readings/dao", () => ({
  ReadingsDao: { readRaw: jest.fn() },
}));

import * as store from "@/lib/automations/store";
import { getOpenRun } from "@/lib/run-tracking/live";
import { listEnabledRunDetectors } from "@/lib/derivations/resolve";
import {
  dispatchPointAction,
  loadPointByStemMetric,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import { scheduleRepoll } from "@/lib/control/repoll";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { ReadingsDao } from "@/lib/readings/dao";
import type {
  AutomationRow,
  ExerciseTrigger,
} from "@/lib/db/planetscale/schema";
import { evaluateAutomations } from "@/lib/automations/evaluate";

const mockStore = jest.mocked(store);
const mockOpenRun = jest.mocked(getOpenRun);
const mockDetectors = jest.mocked(listEnabledRunDetectors);
const mockLoadPoint = jest.mocked(loadPointByUuid);
const mockSibling = jest.mocked(loadPointByStemMetric);
const mockDispatch = jest.mocked(dispatchPointAction);
const mockRepoll = jest.mocked(scheduleRepoll);
const mockDevice = jest.mocked(DeviceConfigRegistry.deviceByHandle);
const mockReadRaw = jest.mocked(ReadingsDao.readRaw);

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const DEVICE_RID = 10;

function row(over: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: AU_UUID,
    areaId: AREA_UUID,
    name: "Charge limit",
    enabled: true,
    mode: "standing",
    trigger: {
      kind: "charge-session",
      source: { kind: "derivation", derivationId: DX_UUID },
      afterMinutes: 60,
    },
    action: { kind: "point-action", pointId: ACT_PT_UUID, action: "turn_off" },
    armedAt: null,
    armedContext: null,
    lastTriggeredAt: null,
    lastTriggeredRunStart: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    revision: 3, // not 1: the claim must pass the ROW's version, not a constant
    ...over,
  } as AutomationRow;
}

/** An armed, derivation-sourced, past-threshold row — the shortest path to `fire()`. */
function firingRow(over: Partial<AutomationRow> = {}): AutomationRow {
  return row({ armedAt: new Date(T0 - 90 * MIN), ...over });
}

function pointTriggerRow(over: Partial<AutomationRow> = {}): AutomationRow {
  return row({
    trigger: {
      kind: "charge-session",
      source: { kind: "point", pointId: SRC_PT_UUID },
      afterKwh: 20,
    },
    ...over,
  });
}

function detector(over: Record<string, unknown> = {}) {
  return {
    id: DX_UUID,
    detect: { delayOffMs: 300_000 },
    ...over,
  } as unknown as Awaited<ReturnType<typeof listEnabledRunDetectors>>[number];
}

function openRun(startMs: number, energyKwh: number | null = 5) {
  return { startTime: new Date(startMs), energyKwh } as never;
}

/** `readRaw` returns an ASCENDING series per point id. */
function series(
  counter: { v: number | null; at: number }[],
  active: { v: number | null; at: number }[],
) {
  return new Map([
    [
      Point.encode(SRC_PT_UUID),
      counter.map((s) => ({ measurementTimeMs: s.at, value: s.v })),
    ],
    [
      Point.encode(ACTIVE_PT_UUID),
      active.map((s) => ({ measurementTimeMs: s.at, value: s.v })),
    ],
  ]) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});

  mockStore.listEnabled.mockResolvedValue([]);
  mockStore.armAutomation.mockResolvedValue(undefined);
  mockStore.disarmAutomation.mockResolvedValue(undefined);
  mockStore.recordFired.mockResolvedValue(undefined);
  mockStore.disableAutomation.mockResolvedValue(undefined);
  mockStore.intervalsOverlapping.mockResolvedValue([]);
  mockStore.recordExerciseOutcome.mockResolvedValue(undefined);
  mockStore.claimExerciseDispatch.mockResolvedValue(true);

  mockDetectors.mockResolvedValue([detector()]);
  mockOpenRun.mockResolvedValue(openRun(T0 - 90 * MIN));

  mockLoadPoint.mockResolvedValue({
    point: {
      id: SRC_PT_UUID,
      logicalPath: "ev.charge",
      metricType: "energy",
    } as never,
    deviceRid: DEVICE_RID,
  });
  mockSibling.mockResolvedValue({ id: ACTIVE_PT_UUID } as never);
  mockReadRaw.mockResolvedValue(series([], []));

  mockDevice.mockResolvedValue({
    id: DEVICE_RID,
    vendorType: "tesla",
    ownerClerkUserId: "user_owner",
  } as never);
  mockDispatch.mockResolvedValue({
    kind: "completed",
    ok: true,
    reason: null,
    commandId: "cmd-1",
  });
});

// ── The fire() outcome switch ────────────────────────────────────────────────────────────────────

describe("fire() — the dispatch outcome switch", () => {
  it("completed{ok:true}: records the fire AND schedules the confirmation re-poll", async () => {
    mockStore.listEnabled.mockResolvedValue([firingRow()]);

    const summary = await evaluateAutomations(T0);

    expect(mockStore.recordFired).toHaveBeenCalledTimes(1);
    expect(mockStore.recordFired.mock.calls[0][0]).toBe(AU_UUID);
    expect(mockStore.recordFired.mock.calls[0][1]).toEqual({
      firedAt: new Date(T0),
      anchorMs: T0 - 90 * MIN,
      disable: false,
    });
    expect(mockRepoll).toHaveBeenCalledTimes(1);
    expect(mockStore.disableAutomation).not.toHaveBeenCalled();
    expect(mockStore.disarmAutomation).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ evaluated: 1, fired: 1, errors: 0 });
  });

  it("🛑 completed{ok:false} (the benign not_charging decline): records the fire and does NOT re-poll", async () => {
    mockDispatch.mockResolvedValue({
      kind: "completed",
      ok: false,
      reason: "not_charging",
      commandId: "cmd-2",
    });
    mockStore.listEnabled.mockResolvedValue([firingRow()]);

    const summary = await evaluateAutomations(T0);

    // Success-and-disarm, never a retry: `recordFired` stamps `lastTriggeredRunStart`, which is
    // exactly what suppresses the next tick. Skipping it would re-fire every minute.
    expect(mockStore.recordFired).toHaveBeenCalledTimes(1);
    expect(mockStore.recordFired.mock.calls[0][1]).toMatchObject({
      anchorMs: T0 - 90 * MIN,
      disable: false,
    });
    // A decline changed nothing, so a vendor read would be pure waste.
    expect(mockRepoll).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fired: 1, errors: 0 });
  });

  it("🛑 a benign decline leaves the automation suppressed, not armed for another attempt", async () => {
    mockDispatch.mockResolvedValue({
      kind: "completed",
      ok: false,
      reason: "not_charging",
      commandId: "cmd-2",
    });
    const anchorMs = T0 - 90 * MIN;
    mockStore.listEnabled.mockResolvedValue([firingRow()]);
    await evaluateAutomations(T0);
    expect(mockStore.recordFired).toHaveBeenCalledTimes(1);

    // Next tick, with the stamp the first tick wrote: same open run ⇒ already-fired, no re-dispatch.
    jest.clearAllMocks();
    mockDispatch.mockResolvedValue({
      kind: "completed",
      ok: false,
      reason: "not_charging",
      commandId: "cmd-3",
    });
    mockStore.listEnabled.mockResolvedValue([
      firingRow({ lastTriggeredRunStart: new Date(anchorMs) }),
    ]);

    const summary = await evaluateAutomations(T0 + MIN);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockStore.recordFired).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fired: 0, skipped: 1, errors: 0 });
  });

  it("🛑 rejected (a permanent protocol refusal): DISABLES the automation and never fires", async () => {
    mockDispatch.mockResolvedValue({
      kind: "rejected",
      error: "Vehicle requires the signed command protocol",
      code: "vehicle_command_protocol_required",
      commandId: "cmd-4",
    });
    mockStore.listEnabled.mockResolvedValue([firingRow()]);

    const summary = await evaluateAutomations(T0);

    expect(mockStore.disableAutomation).toHaveBeenCalledTimes(1);
    expect(mockStore.disableAutomation).toHaveBeenCalledWith(AU_UUID);
    expect(mockStore.recordFired).not.toHaveBeenCalled();
    expect(mockRepoll).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fired: 0, errors: 1 });
  });

  it.each<PointActionOutcome>([
    { kind: "invalid", error: "point is not controllable" },
    { kind: "unavailable", error: "vehicle asleep", httpStatus: 503 },
    { kind: "failed", error: "boom", commandId: "cmd-5" },
  ])(
    "a transient $kind failure leaves it armed (no disable, no fire stamp)",
    async (outcome) => {
      mockDispatch.mockResolvedValue(outcome);
      mockStore.listEnabled.mockResolvedValue([firingRow()]);

      const summary = await evaluateAutomations(T0);

      expect(mockStore.disableAutomation).not.toHaveBeenCalled();
      expect(mockStore.disarmAutomation).not.toHaveBeenCalled();
      expect(mockStore.recordFired).not.toHaveBeenCalled();
      expect(mockRepoll).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ fired: 0, errors: 1 });
    },
  );

  it("mode 'once' self-disarms on a successful fire", async () => {
    mockStore.listEnabled.mockResolvedValue([firingRow({ mode: "once" })]);

    await evaluateAutomations(T0);

    expect(mockStore.recordFired.mock.calls[0][1]).toMatchObject({
      disable: true,
    });
  });

  it("mode 'standing' stays enabled on a successful fire", async () => {
    mockStore.listEnabled.mockResolvedValue([firingRow()]);
    await evaluateAutomations(T0);
    expect(mockStore.recordFired.mock.calls[0][1]).toMatchObject({
      disable: false,
    });
  });

  it("🛑 dispatches with the DEVICE owner's device and an audit-only automation requestedBy — there is no session user", async () => {
    mockStore.listEnabled.mockResolvedValue([firingRow()]);

    await evaluateAutomations(T0);

    // The ACTION point is resolved, and its device is looked up by the rid that came back with it.
    expect(mockLoadPoint).toHaveBeenCalledWith(ACT_PT_UUID);
    expect(mockDevice).toHaveBeenCalledWith(DEVICE_RID);
    const req = mockDispatch.mock.calls[0][0];
    expect(req.action).toBe("turn_off");
    expect(req.device).toMatchObject({ ownerClerkUserId: "user_owner" });
    expect(req.requestedBy).toBe(`automation:${Automation.encode(AU_UUID)}`);
  });

  it("counts an unresolvable action point / device as an error and dispatches nothing", async () => {
    mockLoadPoint.mockResolvedValue(null);
    mockStore.listEnabled.mockResolvedValue([firingRow()]);
    let summary = await evaluateAutomations(T0);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fired: 0, errors: 1 });

    jest.clearAllMocks();
    mockLoadPoint.mockResolvedValue({
      point: { id: ACT_PT_UUID } as never,
      deviceRid: DEVICE_RID,
    });
    mockDevice.mockResolvedValue(null);
    mockStore.listEnabled.mockResolvedValue([firingRow()]);
    summary = await evaluateAutomations(T0);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockStore.disableAutomation).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fired: 0, errors: 1 });
  });
});

// ── resolveDerivationSource ──────────────────────────────────────────────────────────────────────

describe("resolveDerivationSource", () => {
  it("asks for the open run of the trigger's OWN derivation", async () => {
    mockStore.listEnabled.mockResolvedValue([
      row({
        trigger: {
          kind: "charge-session",
          source: { kind: "derivation", derivationId: OTHER_DX_UUID },
          afterMinutes: 60,
        },
      }),
    ]);
    // Deliberately DIFFERENT ids: the trigger names OTHER_DX_UUID, the resolved detector reports
    // DX_UUID. In production the two coincide, so only a fixture that separates them can show
    // which one each call actually uses.
    mockDetectors.mockResolvedValue([detector({ id: DX_UUID })]);

    await evaluateAutomations(T0);

    // The lookup is keyed by the TRIGGER's derivationId…
    expect(mockDetectors).toHaveBeenCalledWith({ derivationId: OTHER_DX_UUID });
    // …and the run is then fetched by the resolved DETECTOR's own id.
    expect(mockOpenRun).toHaveBeenCalledWith(DX_UUID);
    expect(mockOpenRun).not.toHaveBeenCalledWith(OTHER_DX_UUID);
  });

  it("no open run ⇒ inactive (not an error): an unarmed standing rule just waits", async () => {
    mockOpenRun.mockResolvedValue(null);
    mockStore.listEnabled.mockResolvedValue([row()]);

    const summary = await evaluateAutomations(T0);

    expect(summary).toMatchObject({ evaluated: 1, errors: 0 });
    expect(mockStore.armAutomation).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("no open run ⇒ inactive DISARMS an armed rule (a `once` self-disables)", async () => {
    mockOpenRun.mockResolvedValue(null);
    mockStore.listEnabled.mockResolvedValue([
      firingRow({ mode: "once" }),
      firingRow({ mode: "standing" }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(mockStore.disarmAutomation.mock.calls.map((c) => c[1])).toEqual([
      { disable: true },
      { disable: false },
    ]);
    expect(summary).toMatchObject({ disarmed: 2, errors: 0 });
  });

  it("🛑 an unresolvable detector is UNKNOWN, not inactive — a broken binding must not disable a `once`", async () => {
    mockDetectors.mockResolvedValue([]);
    mockStore.listEnabled.mockResolvedValue([firingRow({ mode: "once" })]);

    const summary = await evaluateAutomations(T0);

    expect(mockOpenRun).not.toHaveBeenCalled();
    expect(mockStore.disarmAutomation).not.toHaveBeenCalled();
    expect(mockStore.disableAutomation).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ evaluated: 1, disarmed: 0, fired: 0 });
  });

  it("arms on an open run and carries no baseline (a derivation measures from run start)", async () => {
    mockStore.listEnabled.mockResolvedValue([row()]);

    await evaluateAutomations(T0);

    expect(mockStore.armAutomation).toHaveBeenCalledWith(
      AU_UUID,
      new Date(T0),
      null,
    );
    // Armed mid-run and already past 60 minutes ⇒ the re-evaluation fires in the same tick.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockStore.recordFired.mock.calls[0][1]).toMatchObject({
      anchorMs: T0 - 90 * MIN,
    });
  });

  it("🛑 a kWh leg fires off the OPEN RUN's own energy (`energyKwh` ⇒ the decision's `runKwh`)", async () => {
    // The only test in either suite that drives a derivation kWh limit all the way to a dispatch.
    // Drop the run's energy on the way through (`runKwh: null`) and the whole energy-based
    // derivation limit silently stops existing — this is the assertion that notices.
    const runStart = T0 - 10 * MIN;
    mockOpenRun.mockResolvedValue(openRun(runStart, 22));
    mockStore.listEnabled.mockResolvedValue([
      firingRow({
        armedAt: new Date(runStart),
        trigger: {
          kind: "charge-session",
          source: { kind: "derivation", derivationId: DX_UUID },
          afterKwh: 20, // no minutes leg: only the energy comparison can fire this
        },
        // Nothing to short-circuit on: never fired, so no already-fired suppression.
        lastTriggeredRunStart: null,
      }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // A derivation source anchors on the RUN START, not on arm time.
    expect(mockStore.recordFired.mock.calls[0][1]).toMatchObject({
      anchorMs: runStart,
    });
    expect(summary).toMatchObject({ fired: 1, errors: 0 });
  });

  it("an unpriceable open run (null energyKwh) leaves a kWh-only limit inert", async () => {
    const runStart = T0 - 10 * MIN;
    mockOpenRun.mockResolvedValue(openRun(runStart, null));
    mockStore.listEnabled.mockResolvedValue([
      firingRow({
        armedAt: new Date(runStart),
        trigger: {
          kind: "charge-session",
          source: { kind: "derivation", derivationId: DX_UUID },
          afterKwh: 20,
        },
        lastTriggeredRunStart: null,
      }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fired: 0, errors: 0 });
  });

  it("takes the anchor tolerance from the detector's own delayOffMs", async () => {
    mockOpenRun.mockResolvedValue(openRun(T0 - 10 * MIN, 22));
    mockDetectors.mockResolvedValue([
      detector({ detect: { delayOffMs: 900_000 } }),
    ]);
    mockStore.listEnabled.mockResolvedValue([
      firingRow({
        armedAt: new Date(T0 - 10 * MIN),
        trigger: {
          kind: "charge-session",
          source: { kind: "derivation", derivationId: DX_UUID },
          afterKwh: 20,
        },
        // 14 min before the current run start — inside a 15-min tolerance ⇒ already fired.
        lastTriggeredRunStart: new Date(T0 - 24 * MIN),
      }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ skipped: 1, fired: 0 });
  });
});

// ── resolvePointSource ───────────────────────────────────────────────────────────────────────────

describe("resolvePointSource", () => {
  it("reads the counter and its `active` stem-sibling, over the point lookback window", async () => {
    mockReadRaw.mockResolvedValue(
      series([{ v: 42.5, at: T0 - MIN }], [{ v: 1, at: T0 - MIN }]),
    );
    mockStore.listEnabled.mockResolvedValue([pointTriggerRow()]);

    await evaluateAutomations(T0);

    expect(mockLoadPoint).toHaveBeenCalledWith(SRC_PT_UUID);
    expect(mockSibling).toHaveBeenCalledWith(DEVICE_RID, "ev.charge", "active");
    const [ids, window] = mockReadRaw.mock.calls[0];
    expect(ids).toEqual([
      Point.encode(SRC_PT_UUID),
      Point.encode(ACTIVE_PT_UUID),
    ]);
    expect(window.toMs).toBe(T0);
    expect(window.fromMs).toBe(T0 - 30 * 60_000);

    // Active + a counter ⇒ arm with the counter's OWN timestamp as the baseline.
    expect(mockStore.armAutomation).toHaveBeenCalledWith(
      AU_UUID,
      new Date(T0),
      {
        baselineKwh: 42.5,
        baselineAt: T0 - MIN,
      },
    );
  });

  it("takes the LATEST non-null sample of each series", async () => {
    mockReadRaw.mockResolvedValue(
      series(
        [
          { v: 10, at: T0 - 5 * MIN },
          { v: 12.25, at: T0 - 2 * MIN },
          { v: null, at: T0 - MIN },
        ],
        [
          { v: 0, at: T0 - 5 * MIN },
          { v: 1, at: T0 - 2 * MIN },
        ],
      ),
    );
    mockStore.listEnabled.mockResolvedValue([pointTriggerRow()]);

    await evaluateAutomations(T0);

    expect(mockStore.armAutomation).toHaveBeenCalledWith(
      AU_UUID,
      new Date(T0),
      {
        baselineKwh: 12.25,
        baselineAt: T0 - 2 * MIN,
      },
    );
  });

  it("🛑 a kWh limit refuses to arm without a counter — an unenforceable cap must not look armed", async () => {
    mockReadRaw.mockResolvedValue(series([], [{ v: 1, at: T0 - MIN }]));
    mockStore.listEnabled.mockResolvedValue([pointTriggerRow()]);

    const summary = await evaluateAutomations(T0);

    expect(mockStore.armAutomation).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ armed: 0, fired: 0, errors: 0 });
  });

  it("a minutes-only limit arms without a counter (nothing to baseline)", async () => {
    mockReadRaw.mockResolvedValue(series([], [{ v: 1, at: T0 - MIN }]));
    mockStore.listEnabled.mockResolvedValue([
      pointTriggerRow({
        trigger: {
          kind: "charge-session",
          source: { kind: "point", pointId: SRC_PT_UUID },
          afterMinutes: 60,
        },
      }),
    ]);

    await evaluateAutomations(T0);

    expect(mockStore.armAutomation).toHaveBeenCalledWith(
      AU_UUID,
      new Date(T0),
      null,
    );
  });

  it("🛑 a STALE `active:1` is unknown, not active: it neither fires nor disarms", async () => {
    mockReadRaw.mockResolvedValue(
      series(
        [{ v: 99, at: T0 - 40 * MIN }],
        [{ v: 1, at: T0 - 11 * MIN }], // older than ACTIVE_FRESH_MS (10 min)
      ),
    );
    mockStore.listEnabled.mockResolvedValue([
      pointTriggerRow({
        mode: "once",
        armedAt: new Date(T0 - 30 * MIN),
        armedContext: { baselineKwh: 1, baselineAt: T0 - 30 * MIN },
      }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockStore.disarmAutomation).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ evaluated: 1, errors: 0, disarmed: 0 });
  });

  it("a stale `active:0` inside the lookback still counts as inactive (fails safe)", async () => {
    mockReadRaw.mockResolvedValue(
      series([{ v: 5, at: T0 - 25 * MIN }], [{ v: 0, at: T0 - 25 * MIN }]),
    );
    mockStore.listEnabled.mockResolvedValue([
      pointTriggerRow({ armedAt: new Date(T0 - 60 * MIN) }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(mockStore.disarmAutomation).toHaveBeenCalledWith(AU_UUID, {
      disable: false,
    });
    expect(summary).toMatchObject({ disarmed: 1 });
  });

  it("🛑 measures the counter DELTA above the armed baseline, not its absolute value", async () => {
    // The measured overnight-top-up shape, end to end through the shell: baseline 42.5, counter
    // now 52.5, limit 20 kWh. Delta 10 ⇒ no fire. Absolute logic (`counter >= afterKwh`) would
    // fire here, and would fire on the very first tick of every overnight top-up.
    mockReadRaw.mockResolvedValue(
      series([{ v: 42.5 + 10, at: T0 - MIN }], [{ v: 1, at: T0 - MIN }]),
    );
    const armedAt = T0 - 30 * MIN;
    mockStore.listEnabled.mockResolvedValue([
      pointTriggerRow({
        armedAt: new Date(armedAt),
        armedContext: { baselineKwh: 42.5, baselineAt: armedAt },
      }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockStore.recordFired).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fired: 0, errors: 0 });
  });

  it("fires once the delta crosses, with the stored armed context read back and ARM time as the anchor", async () => {
    mockReadRaw.mockResolvedValue(
      series([{ v: 42.5 + 20, at: T0 - MIN }], [{ v: 1, at: T0 - MIN }]),
    );
    const armedAt = T0 - 30 * MIN;
    mockStore.listEnabled.mockResolvedValue([
      pointTriggerRow({
        armedAt: new Date(armedAt),
        armedContext: { baselineKwh: 42.5, baselineAt: armedAt },
      }),
    ]);

    await evaluateAutomations(T0);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // A point source anchors on ARM TIME, never on a run start.
    expect(mockStore.recordFired.mock.calls[0][1]).toMatchObject({
      anchorMs: armedAt,
    });
  });

  it.each([
    ["the point does not exist", () => mockLoadPoint.mockResolvedValue(null)],
    [
      "the point has no logical path",
      () =>
        mockLoadPoint.mockResolvedValue({
          point: { id: SRC_PT_UUID, logicalPath: null } as never,
          deviceRid: DEVICE_RID,
        }),
    ],
    [
      "there is no `active` stem-sibling",
      () => mockSibling.mockResolvedValue(null),
    ],
  ])(
    "🛑 %s ⇒ unknown, so a `once` is neither fired nor disabled",
    async (_label, setup) => {
      setup();
      mockStore.listEnabled.mockResolvedValue([
        pointTriggerRow({ mode: "once" }),
      ]);

      const summary = await evaluateAutomations(T0);

      expect(mockStore.armAutomation).not.toHaveBeenCalled();
      expect(mockStore.disarmAutomation).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ evaluated: 1, disarmed: 0, fired: 0 });
    },
  );

  it("does not read readings at all when the source point cannot be resolved", async () => {
    mockLoadPoint.mockResolvedValue(null);
    mockStore.listEnabled.mockResolvedValue([pointTriggerRow()]);
    await evaluateAutomations(T0);
    expect(mockReadRaw).not.toHaveBeenCalled();
  });
});

// ── evaluateAutomations: the batch ───────────────────────────────────────────────────────────────

describe("evaluateAutomations — the batch", () => {
  it("🛑 one throwing row is counted and stepped over; the rest still evaluate", async () => {
    const bad = row({ id: Automation.toUuid(Automation.generate()) });
    mockStore.listEnabled.mockResolvedValue([bad, firingRow(), firingRow()]);
    mockDetectors.mockImplementation(async () => {
      // The first row's resolution blows up; the later rows are unaffected.
      if (mockDetectors.mock.calls.length === 1)
        throw new Error("detector lookup exploded");
      return [detector()];
    });

    const summary = await evaluateAutomations(T0);

    expect(summary.evaluated).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.fired).toBe(2);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it("a throwing DISPATCH does not abort the pass either", async () => {
    mockStore.listEnabled.mockResolvedValue([firingRow(), firingRow()]);
    mockDispatch.mockRejectedValueOnce(new Error("vendor client exploded"));

    const summary = await evaluateAutomations(T0);

    expect(summary).toMatchObject({ evaluated: 2, errors: 1, fired: 1 });
  });

  it("an unreadable trigger/action is an error, not a throw, and writes nothing", async () => {
    mockStore.listEnabled.mockResolvedValue([
      row({ trigger: { kind: "nonsense" } as never }),
      row({ action: { kind: "point-action", pointId: "not-a-uuid" } as never }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(summary).toMatchObject({ evaluated: 2, errors: 2, fired: 0 });
    expect(mockStore.armAutomation).not.toHaveBeenCalled();
    expect(mockStore.disableAutomation).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("an empty enabled set is a clean zero summary", async () => {
    expect(await evaluateAutomations(T0)).toEqual({
      evaluated: 0,
      exercise: {
        due: 0,
        fired: 0,
        satisfied: 0,
        waiting: 0,
        missed: 0,
        lostClaim: 0,
        exhausted: 0,
      },
      armed: 0,
      disarmed: 0,
      fired: 0,
      skipped: 0,
      errors: 0,
    });
  });
});

// ── Scheduled exercise ───────────────────────────────────────────────────────────────────────────

/**
 * A Thursday-09:00 Melbourne exercise rule. `EX_NOW` is Thu 10 Sep 2026, 09:05 local — five
 * minutes into the slot, well inside the three-hour grace.
 */
const EX_SLOT = new Date("2026-09-10T09:00:00+10:00").getTime();
const EX_NOW = EX_SLOT + 5 * MIN;
const LOAD_PT_UUID = Point.toUuid(Point.generate());

function exerciseRow(over: Partial<AutomationRow> = {}): AutomationRow {
  return row({
    name: "Generator exercise",
    trigger: {
      kind: "exercise",
      source: { kind: "derivation", derivationId: DX_UUID },
      schedule: {
        start: "2026-09-03T09:00",
        rrule: "FREQ=WEEKLY;BYDAY=TH",
        graceMinutes: 180,
      },
      unless: {
        loadPointId: LOAD_PT_UUID,
        minMinutes: 30,
        minLoadKw: 1.5,
        dipToleranceSeconds: 180,
        withinDays: 7,
      },
    },
    action: {
      kind: "point-action",
      pointId: ACT_PT_UUID,
      action: "set_value",
      value: 30,
    },
    createdAt: new Date(EX_SLOT - 30 * 24 * 60 * MIN),
    ...over,
  });
}

/** A closed run interval, `minutes` long, ending `endedAgoMin` before EX_NOW. */
function runInterval(
  endedAgoMin: number,
  minutes: number,
): { startTime: Date; endTime: Date } {
  const endTime = new Date(EX_NOW - endedAgoMin * MIN);
  return {
    startTime: new Date(endTime.getTime() - minutes * MIN),
    endTime,
  };
}

/** Minutely load samples covering a whole interval, at a constant kW of import. */
function loadSeries(from: number, to: number, kw: number) {
  const out: { measurementTimeMs: number; value: number }[] = [];
  for (let t = from; t <= to; t += MIN)
    out.push({ measurementTimeMs: t, value: -kw * 1000 });
  return new Map([[Point.encode(LOAD_PT_UUID), out]]) as never;
}

describe("evaluateExercise", () => {
  beforeEach(() => {
    mockDetectors.mockResolvedValue([
      detector({ displayTimezone: "Australia/Melbourne" }),
    ]);
    mockOpenRun.mockResolvedValue(null);
  });

  it("retires a rule whose last slot this was, in the same write that consumes it", async () => {
    // A one-off: `start` and no `rrule`. Once this slot is dealt with there is nothing after it,
    // so the row is disabled as it fires rather than sitting enabled with nothing left to do.
    mockStore.listEnabled.mockResolvedValue([
      exerciseRow({
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-10T09:00", graceMinutes: 180 },
        },
      }),
    ]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(summary.exercise.fired).toBe(1);
    expect(summary.exercise.exhausted).toBe(1);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({
        consume: true,
        disable: true,
        context: expect.objectContaining({ outcome: "fired", final: true }),
      }),
    );
  });

  it("does NOT retire a rule that has more occurrences coming", async () => {
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(summary.exercise.exhausted).toBe(0);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({ disable: false }),
    );
  });

  it("does NOT retire a spent rule on a WAITING outcome — the slot is not consumed", async () => {
    // The slot is still this rule's to act on, so retiring now would strand it un-fired.
    mockOpenRun.mockResolvedValue({ id: "run-1" } as never);
    mockStore.listEnabled.mockResolvedValue([
      exerciseRow({
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-10T09:00", graceMinutes: 180 },
        },
      }),
    ]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(summary.exercise.waiting).toBe(1);
    expect(summary.exercise.exhausted).toBe(0);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({ consume: false, disable: false }),
    );
  });

  it("dispatches set_value with the configured minutes and consumes the slot", async () => {
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "set_value", value: 30 }),
    );
    expect(summary.exercise).toEqual({
      due: 1,
      fired: 1,
      satisfied: 0,
      waiting: 0,
      exhausted: 0,
      missed: 0,
      lostClaim: 0,
    });
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({
        consume: true,
        context: expect.objectContaining({ outcome: "fired", slotAt: EX_SLOT }),
      }),
    );
    // 🛑 The claim is a compare-and-set, so it is only a claim if it carries the version THIS row
    // was read at. Passing anything else (a constant, or the old `updatedAt`) makes it either
    // unconditional or unsatisfiable, and both look identical from here — see #468.
    expect(mockStore.claimExerciseDispatch).toHaveBeenCalledWith(AU_UUID, 3);
  });

  it("does nothing at all when the slot has already been consumed", async () => {
    mockStore.listEnabled.mockResolvedValue([
      exerciseRow({ lastTriggeredRunStart: new Date(EX_SLOT) }),
    ]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(summary.exercise.due).toBe(0);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockStore.recordExerciseOutcome).not.toHaveBeenCalled();
  });

  it("skips as satisfied when a loaded run already happened in the lookback", async () => {
    const iv = runInterval(2 * 24 * 60, 45);
    mockStore.intervalsOverlapping.mockResolvedValue([iv] as never);
    mockReadRaw.mockResolvedValue(
      loadSeries(iv.startTime.getTime(), iv.endTime.getTime(), 2.6),
    );
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary.exercise.satisfied).toBe(1);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({
        consume: true,
        context: expect.objectContaining({ outcome: "satisfied" }),
      }),
    );
  });

  it("🛑 an UNLOADED run does not satisfy the condition", async () => {
    // The measured 0.26 kW Aug-30 run: long enough, but it does nothing about wet stacking, and
    // treating it as an exercise would let the engine glaze indefinitely.
    const iv = runInterval(2 * 24 * 60, 45);
    mockStore.intervalsOverlapping.mockResolvedValue([iv] as never);
    mockReadRaw.mockResolvedValue(
      loadSeries(iv.startTime.getTime(), iv.endTime.getTime(), 0.26),
    );
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(summary.exercise.fired).toBe(1);
    expect(mockDispatch).toHaveBeenCalled();
  });

  it("🛑 waits WITHOUT consuming while a run is in progress", async () => {
    mockOpenRun.mockResolvedValue(openRun(EX_NOW - 20 * MIN));
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    // Dispatching here would recompute the hub's stop deadline from now and truncate the run.
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary.exercise.waiting).toBe(1);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({ consume: false }),
    );
  });

  it("writes the slot off as missed once grace has expired", async () => {
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_SLOT + 200 * MIN);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary.exercise.missed).toBe(1);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({
        consume: true,
        context: expect.objectContaining({ outcome: "missed" }),
      }),
    );
  });

  it("distinguishes a grace expiry spent running", async () => {
    mockOpenRun.mockResolvedValue(openRun(EX_SLOT));
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_SLOT + 200 * MIN);

    expect(summary.exercise.missed).toBe(1);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({
        context: expect.objectContaining({ outcome: "missed-running" }),
      }),
    );
  });

  it("completed{ok:false}: the hub declined — retry, do not consume", async () => {
    mockDispatch.mockResolvedValue({
      kind: "completed",
      ok: false,
      reason: "panel_not_in_auto",
      commandId: "cmd-9",
    });
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(summary.exercise.waiting).toBe(1);
    expect(summary.exercise.fired).toBe(0);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({
        consume: false,
        context: expect.objectContaining({
          outcome: "waiting",
          reason: "panel_not_in_auto",
        }),
      }),
    );
  });

  it("unavailable: transient — the slot stays due", async () => {
    // The dev shape: a DeepSea device with no passkey configured.
    mockDispatch.mockResolvedValue({
      kind: "unavailable",
      error: "no passkey configured",
      httpStatus: 503,
    });
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(summary.errors).toBe(1);
    expect(mockStore.recordExerciseOutcome).toHaveBeenCalledWith(
      AU_UUID,
      expect.objectContaining({ consume: false }),
    );
  });

  it("rejected: permanent — disable the rule", async () => {
    mockDispatch.mockResolvedValue({
      kind: "rejected",
      error: "not controllable",
      code: "unsupported",
      commandId: "cmd-2",
    });
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    await evaluateAutomations(EX_NOW);

    expect(mockStore.disableAutomation).toHaveBeenCalledWith(AU_UUID);
  });

  it("🛑 losing the claim means NOT dispatching", async () => {
    // Two overlapping cron ticks. The loser must not re-extend the engine's stop deadline.
    mockStore.claimExerciseDispatch.mockResolvedValue(false);
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockStore.recordExerciseOutcome).not.toHaveBeenCalled();
    // 🛑 And it is COUNTED. `reportUndecidedSlots` alerts when `due` exceeds the outcomes recorded,
    // so an uncounted lost claim made the one race this design expects raise the 🚨 "produced no
    // decision" alarm — training an operator to ignore the alarm built for #468's silent failure.
    expect(summary.exercise.due).toBe(1);
    expect(summary.exercise.lostClaim).toBe(1);
  });

  it("refuses to dispatch when the detector has gone away", async () => {
    // Without the detector we can read neither "running now" nor "ran recently".
    mockDetectors.mockResolvedValue([]);
    mockStore.listEnabled.mockResolvedValue([exerciseRow()]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary.errors).toBe(1);
  });

  it("🛑 refuses a turn_off action on an exercise rule", async () => {
    mockStore.listEnabled.mockResolvedValue([
      exerciseRow({
        action: {
          kind: "point-action",
          pointId: ACT_PT_UUID,
          action: "turn_off",
        },
      }),
    ]);

    const summary = await evaluateAutomations(EX_NOW);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary.errors).toBe(1);
  });

  it("🛑 refuses a set_value action on a charge-session rule", async () => {
    // `fire()` hardcodes turn_off; honouring a set_value there could START a charge.
    mockStore.listEnabled.mockResolvedValue([
      firingRow({
        action: {
          kind: "point-action",
          pointId: ACT_PT_UUID,
          action: "set_value",
          value: 30,
        },
      }),
    ]);

    const summary = await evaluateAutomations(T0);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(summary.errors).toBe(1);
  });
});
