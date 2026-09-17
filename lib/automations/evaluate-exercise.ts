/**
 * The DB shell around `exercise.ts` — one scheduled-exercise rule, one tick.
 *
 * Split out of `evaluate.ts` rather than branching inside it because the two trigger kinds share
 * only the table: this path has no arming, no source state and no threshold, and reads a SECOND
 * point (the load meter) that the charge path knows nothing about.
 *
 * Imports nothing from `evaluate.ts` — the summary is taken structurally — so the two modules do
 * not form a cycle.
 */
import { getOpenRun } from "@/lib/run-tracking/live";
import { listEnabledRunDetectors } from "@/lib/derivations/resolve";
import {
  dispatchPointAction,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import { scheduleRepoll } from "@/lib/control/repoll";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { ReadingsDao } from "@/lib/readings/dao";
import { Automation, Point } from "@/lib/ids";
import type {
  AutomationAction,
  AutomationRow,
  ExerciseArmedContext,
  ExerciseTrigger,
} from "@/lib/db/planetscale/schema";
import * as store from "./store";
import { parseArmedContext } from "./types";
import {
  decideExercise,
  exerciseContext,
  isDue,
  isSelfCommandedRun,
  longestLoadedStretch,
  shouldAbortRun,
  type ExerciseDecision,
  type LoadedSample,
  type LoadedStretch,
  type NotDueReason,
} from "./exercise";
import { isExhausted, previousOccurrence, type Slot } from "./recurrence";

/**
 * What the lookback found, and how much of it was discounted as our own doing.
 *
 * The counts are not decoration: a `best: null` alongside "1 run considered, 1 excluded" is the
 * difference between "the engine has been idle all week" and "the only run this week was the
 * exercise we ourselves commanded", and those call for opposite reactions from an operator.
 */
interface LoadedStretchResult {
  best: LoadedStretch | null;
  runsConsidered: number;
  runsExcluded: number;
}

/** The run detector a rule is aimed at, as much of it as this module uses. */
type Detector = Awaited<ReturnType<typeof listEnabledRunDetectors>>[number];

/** The readiness reading, when a rule configures one. Reachable through `ExercisePlan`. */
interface ReadinessReading {
  socPercent: number | null;
  maxSocPercent: number;
}

/**
 * Everything a tick KNOWS before it changes anything — the read half of `evaluateExercise`.
 *
 * 🛑 Extracted so the dry-evaluation route (`GET …/{id}/evaluation`, behind `liveone automation
 * check`) answers with the SAME code the evaluator acts on, rather than a second implementation
 * that drifts. The dispatch half — `fireExercise`, `claimExerciseSlot`, `recordExerciseOutcome`,
 * `superviseOpenRun` — is deliberately NOT reachable from here, so a route calling this cannot
 * start an engine however it is wired up.
 *
 * Takes no summary: counting is the shell's job, because a route has no summary to count into.
 */
/** The cheap half: who, when, and is it ours to act on. No readings, no evidence. */
type SlotPlan =
  | { kind: "bad-action"; got: string }
  | { kind: "no-detector" }
  | { kind: "no-slot"; det: Detector }
  | {
      kind: "not-due";
      det: Detector;
      slot: Slot;
      reason: NotDueReason;
      exhausted: boolean;
    }
  | { kind: "due"; det: Detector; slot: Slot; exhausted: boolean };

/**
 * Resolve the rule's subject and its slot. Two DB reads at most, and neither depends on history.
 *
 * 🛑 SPLIT from the evidence phase on purpose, and the split is load-bearing twice over:
 *  - supervision must run after the detector resolves and BEFORE the lookback, because a lookback
 *    that throws must not leave an unloaded engine running. That was the original ordering; folding
 *    everything into one planner silently changed it.
 *  - `due` must be counted before the evidence reads, or a failing lookback yields `due: 0` and
 *    `reportUndecidedSlots` goes quiet for the whole grace window — losing exactly the alarm that
 *    exists to catch an evaluator falling out of the path.
 */
async function planSlot(
  row: AutomationRow,
  trigger: ExerciseTrigger,
  action: AutomationAction,
  nowMs: number,
): Promise<SlotPlan> {
  if (action.action !== "set_value")
    return { kind: "bad-action", got: action.action };

  const [det] = await listEnabledRunDetectors({
    derivationId:
      trigger.source.kind === "derivation" ? trigger.source.derivationId : "",
  });
  if (!det) return { kind: "no-detector" };

  const slot = previousOccurrence(trigger.schedule, det.displayTimezone, nowMs);
  if (!slot) return { kind: "no-slot", det };

  const exhausted = isExhausted(
    trigger.schedule,
    det.displayTimezone,
    slot.atMs,
  );
  const due = isDue({
    slot,
    lastTriggeredRunStartMs: row.lastTriggeredRunStart?.getTime() ?? null,
    createdAtMs: row.createdAt.getTime(),
  });
  return due.due
    ? { kind: "due", det, slot, exhausted }
    : { kind: "not-due", det, slot, reason: due.reason, exhausted };
}

interface DecidedPlan {
  kind: "decided";
  det: Detector;
  slot: Slot;
  lookback: LoadedStretchResult;
  openRun: boolean;
  readiness?: ReadinessReading;
  decision: ExerciseDecision;
  exhausted: boolean;
}

/** The expensive half: the 7-day lookback, the open run, the readiness reading, and the decision. */
async function planDecision(
  row: AutomationRow,
  trigger: ExerciseTrigger,
  action: AutomationAction & { action: "set_value" },
  nowMs: number,
  slotPlan: { det: Detector; slot: Slot; exhausted: boolean },
): Promise<DecidedPlan> {
  const { det, slot, exhausted } = slotPlan;
  const lookback = await loadedStretchSince(
    row.id,
    action.pointId,
    det.id,
    trigger.unless.loadPointId,
    nowMs - trigger.unless.withinDays * DAY_MS,
    nowMs,
    trigger.unless,
  );
  const openRun = (await getOpenRun(det.id)) !== null;
  const readiness = trigger.require
    ? {
        socPercent: await latestValue(trigger.require.socPointId, nowMs),
        maxSocPercent: trigger.require.maxSocPercent,
      }
    : undefined;

  const decision = decideExercise(
    {
      slot,
      graceMinutes: trigger.schedule.graceMinutes,
      minMinutes: trigger.unless.minMinutes,
      evidence: lookback.best,
      openRun,
      runsConsidered: lookback.runsConsidered,
      runsExcluded: lookback.runsExcluded,
      readiness,
      prior: priorContext(row),
    },
    nowMs,
  );

  return {
    kind: "decided",
    det,
    slot,
    lookback,
    openRun,
    readiness,
    decision,
    exhausted,
  };
}

/** The decision already on the row, for the per-slot tick counters. */
function priorContext(row: AutomationRow): ExerciseArmedContext | null {
  const ctx = parseArmedContext(row.armedContext);
  return ctx !== null && "kind" in ctx && ctx.kind === "exercise" ? ctx : null;
}

export type ExercisePlan = Exclude<SlotPlan, { kind: "due" }> | DecidedPlan;

/**
 * Both halves, for the dry-evaluation route — which wants the whole answer and changes nothing.
 *
 * The live evaluator deliberately calls the two halves SEPARATELY so it can supervise and count
 * between them; this composition exists so the route cannot drift from either.
 */
export async function planExercise(
  row: AutomationRow,
  trigger: ExerciseTrigger,
  action: AutomationAction,
  nowMs: number,
): Promise<ExercisePlan> {
  const sp = await planSlot(row, trigger, action, nowMs);
  if (sp.kind !== "due") return sp;
  return planDecision(
    row,
    trigger,
    action as AutomationAction & { action: "set_value" },
    nowMs,
    sp,
  );
}

export interface ExerciseSummary {
  /** Slots that were this rule's to act on this tick. */
  due: number;
  fired: number;
  satisfied: number;
  waiting: number;
  missed: number;
  /**
   * Slots not started because the readiness gate said the site could not load the engine.
   *
   * Its own bucket rather than folded into `missed`, because it must still count as DECIDED for
   * `reportUndecidedSlots` (a skip is a decision) while reading as the deliberate act it is.
   */
  skipped: number;
  /**
   * Runs supervision stopped. NOT part of the due/decided reconciliation — an abort acts on a slot
   * that was consumed when the run started, so counting it there would inflate one tick's decisions
   * against another tick's due.
   */
  aborted: number;
  /**
   * Slots this tick counted as due and then left to another tick, having lost a compare-and-set —
   * either the dispatch claim or the outcome write.
   *
   * 🛑 Counted, not ignored, because `reportUndecidedSlots` compares `due` against the outcomes and
   * alerts on the shortfall. A lost CAS IS a decision — the winning writer made it, and the slot is
   * untouched either way — so without this the races the design expects raise the 🚨 "produced no
   * decision" alarm, and an alarm that fires on correct behaviour is one nobody reads.
   */
  lostClaim: number;
  /** Rules retired this tick because the slot just consumed was their last. */
  exhausted: number;
}

/** The slice of `AutomationsSummary` this module touches. */
interface SummarySink {
  errors: number;
  exercise: ExerciseSummary;
}

const DAY_MS = 86_400_000;

export async function evaluateExercise(
  row: AutomationRow,
  trigger: ExerciseTrigger,
  action: AutomationAction,
  nowMs: number,
  summary: SummarySink,
): Promise<void> {
  const sp = await planSlot(row, trigger, action, nowMs);

  if (sp.kind === "bad-action") {
    // Belt and braces: `references.ts` refuses this combination at create time. If a hand-edited
    // row gets here anyway, a `turn_off` aimed at a run-request point would be a scheduled SHUTDOWN.
    summary.errors++;
    console.error(
      `[automations] ${row.id} is an exercise rule with a '${sp.got}' action — refusing to dispatch`,
    );
    return;
  }
  if (sp.kind === "no-detector") {
    // Deleted or disabled. Without the detector we can read neither "is it running now" nor "has
    // it run recently", and starting an engine blind is precisely the wrong failure mode.
    summary.errors++;
    console.warn(
      `[automations] ${row.id} trigger derivation did not resolve to an enabled run detector — not dispatching`,
    );
    return;
  }

  // 🛑 BEFORE any evidence read, and independent of whether a slot is outstanding.
  //
  // Two separate reasons, both learned the hard way. A run we started outlives its slot's decision,
  // so by the time supervision matters the slot says "dealt-with" — putting this after that check
  // would leave the engine running. And it must not sit behind the 7-day lookback either: a
  // transient failure reading HISTORY would then stop us acting on the PRESENT, which is the one
  // thing supervision exists to do.
  if (action.action === "set_value")
    await superviseOpenRun(row, trigger, action, sp.det, nowMs, summary);

  if (sp.kind === "no-slot") return;

  if (sp.kind === "not-due") {
    // 🛑 Exhaustion has to be asked HERE TOO, not only where a slot is consumed.
    //
    // The retirement below only runs on a tick that has a due slot, so a rule could be left enabled
    // with nothing to fire and no way to say why: consume its second-to-last slot, then `skip` the
    // last one, and `previousOccurrence` returns the already-dealt-with slot forever — this early
    // return, every minute, with the exhaustion check never reached.
    //
    // Only for `dealt-with`. A slot that PREDATES the rule means the schedule has not started yet,
    // and disabling a rule for having been written before its own first occurrence would be a new
    // bug rather than a fix.
    if (sp.reason === "dealt-with" && sp.exhausted) {
      console.warn(
        `[automations] ${row.id} has no occurrences left after ${new Date(sp.slot.atMs).toISOString()} — disabling`,
      );
      await store.disableAutomation(row.id);
      summary.exercise.exhausted++;
    }
    return;
  }

  // 🛑 Counted BEFORE the evidence reads, which is where it was before the planner was extracted.
  // `reportUndecidedSlots` alarms on `due` exceeding the decisions — so if a throwing lookback left
  // `due` at zero, a rule failing every tick of its grace window would raise nothing at all.
  summary.exercise.due++;
  if (action.action !== "set_value") return; // unreachable: `planSlot` refused it above
  const plan = await planDecision(row, trigger, action, nowMs, sp);
  const { slot, lookback, decision } = plan;

  // A rule whose last slot this is gets retired as it is consumed, so a spent schedule goes
  // visibly dark instead of sitting enabled forever with nothing left to fire.
  const retire = (consume: boolean): boolean => consume && plan.exhausted;

  if (decision.kind === "dispatch") {
    await fireExercise(
      row,
      action.pointId,
      action.value,
      slot,
      lookback,
      nowMs,
      summary,
      retire,
      priorContext(row),
    );
    return;
  }

  // No dispatch on this path, so nothing has been claimed and the watermark is this write's to move:
  // advance it for a terminal decision, and OMIT it for `waiting` so the slot stays due for the next
  // tick inside the grace window.
  const consume = decision.kind === "consume";
  const final = retire(consume);
  const applied = await store.recordExerciseOutcome(row.id, {
    context: final ? { ...decision.context, final: true } : decision.context,
    ...(consume ? { runStart: new Date(slot.atMs) } : {}),
    disable: final,
    nowMs,
    expectRevision: row.revision,
  });
  if (!applied) {
    // An owner edit landed between listing the row and deciding about it. The decision was computed
    // against inputs that may no longer hold, so it is DROPPED rather than forced.
    summary.exercise.lostClaim++;
    console.warn(
      `[automations] ${row.id} outcome '${decision.context.outcome}' not recorded — the row changed under it`,
    );
    return;
  }
  countOutcome(summary, decision.context.outcome);
  if (final) summary.exercise.exhausted++;
}

function countOutcome(summary: SummarySink, outcome: string): void {
  if (outcome === "satisfied") summary.exercise.satisfied++;
  else if (outcome === "waiting") summary.exercise.waiting++;
  else if (outcome === "fired") summary.exercise.fired++;
  else if (outcome === "skipped-full") summary.exercise.skipped++;
  else summary.exercise.missed++; // missed | missed-running
}

/** How far back to look for a current reading of a level point (state of charge). */
const LATEST_LOOKBACK_MS = 15 * 60_000;

/**
 * The most recent non-null value of a point, or null if it has gone quiet.
 *
 * Null is a real answer and callers must handle it: `decideExercise` treats an unreadable state of
 * charge as "no opinion" and starts anyway, because a dead sensor silently retiring the exercise is
 * worse than an occasional pointless run.
 */
async function latestValue(
  pointUuid: string,
  nowMs: number,
): Promise<number | null> {
  const pointId = Point.encode(pointUuid);
  const series = await ReadingsDao.readRaw([pointId], {
    fromMs: nowMs - LATEST_LOOKBACK_MS,
    toMs: nowMs,
  });
  const samples = series.get(pointId) ?? [];
  for (let i = samples.length - 1; i >= 0; i--)
    if (samples[i].value !== null) return samples[i].value;
  return null;
}

/**
 * Stop a run WE started once it is clear it is not being loaded.
 *
 * Runs on EVERY tick from `settleMinutes` to the end of the run — see `shouldAbortRun` for why a
 * one-shot check at the settle mark passes exactly the runs worth aborting.
 *
 * Three things it deliberately will not do:
 *  - stop a run it cannot prove it started (`isSelfCommandedRun`), because the owner or another
 *    rule may be running the engine for a reason this rule knows nothing about;
 *  - stop a run twice — a second `set_value = 0` while the engine spins down is a command per
 *    minute for as long as the detector's `delayOffMs` keeps the interval open;
 *  - stop a run on missing telemetry, which `shouldAbortRun` handles.
 */
async function superviseOpenRun(
  row: AutomationRow,
  trigger: ExerciseTrigger,
  action: AutomationAction & { action: "set_value" },
  det: { id: string },
  nowMs: number,
  summary: SummarySink,
): Promise<void> {
  const supervise = trigger.supervise;
  if (!supervise) return;

  const open = await getOpenRun(det.id);
  if (!open) return;
  const startMs = open.startTime.getTime();
  const runMinutes = (nowMs - startMs) / 60_000;
  if (runMinutes < supervise.settleMinutes) return;

  const commands = await store.ownCommandsInWindow(
    row.id,
    action.pointId,
    startMs,
    nowMs,
  );
  if (!isSelfCommandedRun(startMs, commands)) return;
  // Our own stop for THIS run, if we have already sent one. `ownCommandsInWindow` returns the
  // commanded value, and on the run-request point zero IS the stop — so the audit trail answers
  // "have we already aborted" without a second state field to keep in step.
  if (commands.some((c) => c.minutes === 0 && c.requestedAtMs >= startMs))
    return;

  const windowMs = supervise.sustainMinutes * 60_000;
  const pointId = Point.encode(trigger.unless.loadPointId);
  const series = await ReadingsDao.readRaw([pointId], {
    fromMs: nowMs - windowMs,
    toMs: nowMs,
  });
  const samples: LoadedSample[] = (series.get(pointId) ?? []).map((s) => ({
    tMs: s.measurementTimeMs,
    value: s.value,
  }));
  if (
    !shouldAbortRun(samples, runMinutes, {
      minLoadKw: trigger.unless.minLoadKw,
      settleMinutes: supervise.settleMinutes,
      sustainMinutes: supervise.sustainMinutes,
    })
  )
    return;

  // Did it do its job before the load fell away? The same measure the skip condition uses, over
  // this run only — so "ran 24 good minutes then the battery filled" is not recorded as a failure.
  const achieved = longestLoadedStretch(
    (
      (
        await ReadingsDao.readRaw([pointId], { fromMs: startMs, toMs: nowMs })
      ).get(pointId) ?? []
    ).map((s) => ({
      tMs: s.measurementTimeMs,
      value: s.value,
    })),
    trigger.unless,
  );
  const complete =
    achieved !== null && achieved.minutes >= trigger.unless.minMinutes;

  const loaded = await loadPointByUuid(action.pointId);
  const device = loaded
    ? await DeviceConfigRegistry.deviceByHandle(loaded.deviceRid)
    : null;
  if (!loaded || !device) {
    summary.errors++;
    console.error(
      `[automations] ${row.id} cannot resolve the action point to abort an unloaded run`,
    );
    return;
  }

  // 🛑 Zero RELEASES the hub's latch — this is the stop, through the same single dispatch funnel.
  const outcome = await dispatchPointAction({
    point: loaded.point,
    device,
    action: "set_value",
    value: 0,
    requestedBy: `automation:${Automation.encode(row.id)}`,
  });
  if (outcome.kind !== "completed" || !outcome.ok) {
    // Left un-stamped on purpose: no `point_commands` success means the next tick tries again,
    // which is what a transient hub failure needs.
    summary.errors++;
    console.warn(
      `[automations] ${row.id} abort of an unloaded run did not land (${outcome.kind}) — retrying next tick`,
    );
    return;
  }

  summary.exercise.aborted++;
  console.warn(
    `[automations] ${row.id} stopped an unloaded run after ${runMinutes.toFixed(0)} min ` +
      `(${complete ? "had already cleared minMinutes" : "never loaded"})`,
  );
  // Best-effort record against the slot this run belongs to. The slot is already consumed, so this
  // moves no watermark and takes no CAS — it is the operator's account of what happened, and a
  // lost race on it must never leave the engine running.
  await store.recordExerciseOutcome(row.id, {
    context: exerciseContext(
      { atMs: row.lastTriggeredRunStart?.getTime() ?? startMs },
      complete ? "aborted-complete" : "aborted-unloaded",
      nowMs,
      {
        evidence: achieved,
        abortedAt: nowMs,
        prior: priorContext(row),
        tickMode: "carry",
        reason: `load stayed under ${trigger.unless.minLoadKw} kW for ${supervise.sustainMinutes} min`,
      },
    ),
    nowMs,
    expectRevision: row.revision,
  });
  scheduleRepoll(device);
}

async function loadedStretchSince(
  automationUuid: string,
  actionPointUuid: string,
  derivationId: string,
  loadPointUuid: string,
  fromMs: number,
  toMs: number,
  opts: { minLoadKw: number; dipToleranceSeconds: number },
): Promise<LoadedStretchResult> {
  const intervals = await store.intervalsOverlapping(
    derivationId,
    fromMs,
    toMs,
  );
  if (intervals.length === 0)
    return { best: null, runsConsidered: 0, runsExcluded: 0 };

  // Our own exercises are not evidence that an exercise is unnecessary — see `isSelfCommandedRun`.
  const ownCommands = await store.ownCommandsInWindow(
    automationUuid,
    actionPointUuid,
    fromMs,
    toMs,
  );

  const pointId = Point.encode(loadPointUuid);
  let best: LoadedStretch | null = null;
  let runsConsidered = 0;
  let runsExcluded = 0;

  for (const interval of intervals) {
    if (isSelfCommandedRun(interval.startTime.getTime(), ownCommands)) {
      runsExcluded++;
      continue;
    }
    runsConsidered++;
    // Clamp to the window: a run that started before the lookback only counts from its start.
    const startMs = Math.max(interval.startTime.getTime(), fromMs);
    const endMs = Math.min(interval.endTime?.getTime() ?? toMs, toMs);
    if (endMs <= startMs) continue;

    const series = await ReadingsDao.readRaw([pointId], {
      fromMs: startMs,
      toMs: endMs,
    });
    const samples: LoadedSample[] = (series.get(pointId) ?? []).map((s) => ({
      tMs: s.measurementTimeMs,
      value: s.value,
    }));
    const stretch = longestLoadedStretch(samples, opts);
    if (stretch && (best === null || stretch.minutes > best.minutes))
      best = stretch;
  }
  return { best, runsConsidered, runsExcluded };
}

async function fireExercise(
  row: AutomationRow,
  actionPointUuid: string,
  minutes: number,
  slot: Slot,
  lookback: LoadedStretchResult,
  nowMs: number,
  summary: SummarySink,
  retire: (consume: boolean) => boolean,
  prior: ExerciseArmedContext | null,
): Promise<void> {
  // 🛑 EVERY read happens BEFORE the claim, so the only thing between claiming a slot and dispatching
  // it is the dispatch. These two lookups are pure reads that can fail for configuration reasons, and
  // claiming first would consume a slot for a start that never happened — so their "slot stays due"
  // below would have become a lie, and a misconfigured action point would silently cost a run.
  const loaded = await loadPointByUuid(actionPointUuid);
  if (!loaded) {
    summary.errors++;
    console.error(
      `[automations] ${row.id} action point ${actionPointUuid} not found — slot stays due`,
    );
    return;
  }
  const device = await DeviceConfigRegistry.deviceByHandle(loaded.deviceRid);
  if (!device) {
    summary.errors++;
    console.error(
      `[automations] ${row.id} action device ${loaded.deviceRid} not found — slot stays due`,
    );
    return;
  }

  // 🛑 `/api/cron/derivations` holds no lease, so two ticks CAN overlap. Claim the slot — a
  // compare-and-set on the integer `revision` that ALSO consumes it — because the thing being
  // guarded is starting an engine, and a bare revision bump left a window in which a second tick
  // read the bumped revision, found the slot still open, and dispatched too. `store.claimExerciseSlot`
  // has the full argument, including what consuming early costs instead.
  //
  // (It was a CAS on `updated_at` until #468, where a microsecond the round trip could not carry made
  // it match nothing; `store.exerciseClaimWhere` has that story.)
  const priorRunStart = row.lastTriggeredRunStart;
  const claim = await store.claimExerciseSlot(row.id, row.revision, slot.atMs);
  if (!claim) {
    // Expected and rare in a genuine two-tick race — but it is ALSO what a broken CAS looked like,
    // and losing EVERY tick is indistinguishable from having nothing to do unless it says so. This
    // line is the one that would have made a silent 100% failure visible on day one.
    console.warn(
      `[automations] ${row.id} lost the exercise dispatch claim — another tick got there first`,
    );
    summary.exercise.lostClaim++;
    return;
  }

  // 🛑 IN-PROCESS through the one dispatch path. `requestedBy` is AUDIT ONLY — an automation has
  // no session user and credentials always resolve from the DEVICE OWNER.
  const outcome = await dispatchPointAction({
    point: loaded.point,
    device,
    action: "set_value",
    value: minutes,
    requestedBy: `automation:${Automation.encode(row.id)}`,
  });

  const record = async (
    outcomeName: "fired" | "waiting",
    consume: boolean,
    reason?: string,
  ) => {
    const final = retire(consume);
    const applied = await store.recordExerciseOutcome(row.id, {
      context: exerciseContext(slot, outcomeName, nowMs, {
        reason,
        evidence: lookback.best,
        final,
        // 🛑 Carried here too. A dispatch that the hub declines writes `waiting` every minute of the
        // grace window; without the prior each of those restarted the count at 1, so the record of
        // ~180 attempts read as "2 ticks" — which is precisely the thing these counters exist to
        // make visible.
        prior,
        // Carried onto the DISPATCH path too: "0 runs weighed, 1 discounted as ours" is precisely
        // the explanation for why an exercise fired into what looks like a busy week.
        runsConsidered: lookback.runsConsidered,
        runsExcluded: lookback.runsExcluded,
      }),
      // The claim already consumed the slot. Keeping it consumed is a no-op restatement; RELEASING it
      // means restoring the watermark this row carried BEFORE the claim, never null — null would wipe
      // whatever earlier occurrence it was holding and re-arm it.
      runStart: consume ? new Date(slot.atMs) : priorRunStart,
      disable: final,
      nowMs,
      // Against the revision the claim handed us, not the one the row was listed with.
      expectRevision: claim.revision,
    });
    if (!applied) {
      // The row moved under us mid-dispatch — only an owner edit can do that, and a PATCH clears the
      // arming state anyway. Say so: on a release this leaves the slot consumed, which costs this
      // occurrence, and that is not something to discover from a silence.
      summary.errors++;
      console.error(
        `[automations] ${row.id} outcome '${outcomeName}' not recorded — the row changed during dispatch ` +
          `(expected revision ${claim.revision}). The slot stays consumed.`,
      );
      return;
    }
    countOutcome(summary, outcomeName);
    if (final) summary.exercise.exhausted++;
  };

  switch (outcome.kind) {
    case "completed": {
      if (outcome.ok) {
        await record("fired", true);
        // Freshness only when something actually changed. A no-op for a push vendor like the
        // DeepSea hub, but the dispatch path is shared and a future pull vendor would need it.
        scheduleRepoll(device);
        return;
      }
      // The hub declined — e.g. the panel is in a mode that refuses a remote start. That can clear
      // on its own, so the slot stays due and the next tick tries again inside the grace window.
      await record(
        "waiting",
        false,
        outcome.reason ?? "the device declined the request",
      );
      return;
    }
    case "rejected": {
      // A protocol/config refusal is PERMANENT for this device. Retrying every minute would flood
      // `point_commands` for a generator that can never accept the command.
      await store.disableAutomation(row.id);
      summary.errors++;
      console.error(
        `[automations] ${row.id} disabled — device refused (${outcome.code}): ${outcome.error}`,
      );
      return;
    }
    default: {
      // invalid / unavailable / failed — transient (a hub that is offline, a missing passkey).
      summary.errors++;
      console.error(
        `[automations] ${row.id} dispatch ${outcome.kind}: ${outcome.error} — slot stays due`,
      );
      await record(
        "waiting",
        false,
        `dispatch ${outcome.kind}: ${outcome.error}`,
      );
      return;
    }
  }
}
