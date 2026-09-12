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
  ExerciseTrigger,
} from "@/lib/db/planetscale/schema";
import * as store from "./store";
import {
  decideExercise,
  exerciseContext,
  isDue,
  longestLoadedStretch,
  type LoadedSample,
  type LoadedStretch,
} from "./exercise";
import { isExhausted, previousOccurrence, type Slot } from "./recurrence";

export interface ExerciseSummary {
  /** Slots that were this rule's to act on this tick. */
  due: number;
  fired: number;
  satisfied: number;
  waiting: number;
  missed: number;
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
  // Belt and braces: `references.ts` refuses this combination at create time. If a hand-edited row
  // gets here anyway, a `turn_off` aimed at a run-request point would be a scheduled SHUTDOWN.
  if (action.action !== "set_value") {
    summary.errors++;
    console.error(
      `[automations] ${row.id} is an exercise rule with a '${action.action}' action — refusing to dispatch`,
    );
    return;
  }

  const [det] = await listEnabledRunDetectors({
    derivationId:
      trigger.source.kind === "derivation" ? trigger.source.derivationId : "",
  });
  if (!det) {
    // Deleted or disabled. Without the detector we can read neither "is it running now" nor "has
    // it run recently", and starting an engine blind is precisely the wrong failure mode.
    summary.errors++;
    console.warn(
      `[automations] ${row.id} trigger derivation did not resolve to an enabled run detector — not dispatching`,
    );
    return;
  }

  const slot = previousOccurrence(trigger.schedule, det.displayTimezone, nowMs);
  if (!slot) return;
  if (
    !isDue({
      slot,
      lastTriggeredRunStartMs: row.lastTriggeredRunStart?.getTime() ?? null,
      createdAtMs: row.createdAt.getTime(),
    })
  )
    return;

  summary.exercise.due++;

  const evidence = await loadedStretchSince(
    det.id,
    trigger.unless.loadPointId,
    nowMs - trigger.unless.withinDays * DAY_MS,
    nowMs,
    trigger.unless,
  );
  const openRun = (await getOpenRun(det.id)) !== null;

  const decision = decideExercise(
    {
      slot,
      graceMinutes: trigger.schedule.graceMinutes,
      minMinutes: trigger.unless.minMinutes,
      evidence,
      openRun,
    },
    nowMs,
  );

  // A rule whose last slot this is gets retired as it is consumed, so a spent schedule goes
  // visibly dark instead of sitting enabled forever with nothing left to fire. Asked from the
  // SLOT instant, not from `nowMs`: "is there anything after the one we just dealt with".
  const retire = (consume: boolean): boolean =>
    consume && isExhausted(trigger.schedule, det.displayTimezone, slot.atMs);

  if (decision.kind === "dispatch") {
    await fireExercise(
      row,
      action.pointId,
      action.value,
      slot,
      evidence,
      nowMs,
      summary,
      retire,
    );
    return;
  }

  const consume = decision.kind === "consume";
  const final = retire(consume);
  await store.recordExerciseOutcome(row.id, {
    context: final ? { ...decision.context, final: true } : decision.context,
    consume,
    disable: final,
    nowMs,
  });
  countOutcome(summary, decision.context.outcome);
  if (final) summary.exercise.exhausted++;
}

function countOutcome(summary: SummarySink, outcome: string): void {
  if (outcome === "satisfied") summary.exercise.satisfied++;
  else if (outcome === "waiting") summary.exercise.waiting++;
  else if (outcome === "fired") summary.exercise.fired++;
  else summary.exercise.missed++; // missed | missed-running
}

/**
 * The best continuous loaded stretch inside the lookback window.
 *
 * Evaluated PER RUN rather than over one concatenated series. Load between runs is not just low,
 * it is meaningless (the engine is off), and concatenating would invite the gap-bridging rule to
 * join two short runs into one long fictitious stretch.
 */
async function loadedStretchSince(
  derivationId: string,
  loadPointUuid: string,
  fromMs: number,
  toMs: number,
  opts: { minLoadKw: number; dipToleranceSeconds: number },
): Promise<LoadedStretch | null> {
  const intervals = await store.intervalsOverlapping(
    derivationId,
    fromMs,
    toMs,
  );
  if (intervals.length === 0) return null;

  const pointId = Point.encode(loadPointUuid);
  let best: LoadedStretch | null = null;

  for (const interval of intervals) {
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
  return best;
}

async function fireExercise(
  row: AutomationRow,
  actionPointUuid: string,
  minutes: number,
  slot: Slot,
  evidence: LoadedStretch | null,
  nowMs: number,
  summary: SummarySink,
  retire: (consume: boolean) => boolean,
): Promise<void> {
  // 🛑 `/api/cron/derivations` holds no lease, so two ticks CAN overlap. Claim the row first —
  // a compare-and-set on the integer `revision` — because the thing being guarded is starting an
  // engine. (It was a CAS on `updated_at` until #468, where a microsecond the round trip could not
  // carry made it match nothing; `store.exerciseClaimWhere` has the whole story.)
  const claimed = await store.claimExerciseDispatch(row.id, row.revision);
  if (!claimed) {
    // Expected and rare in a genuine two-tick race — but it is ALSO what a broken CAS looked like,
    // and losing EVERY tick is indistinguishable from having nothing to do unless it says so. This
    // line is the one that would have made a silent 100% failure visible on day one.
    console.warn(
      `[automations] ${row.id} lost the exercise dispatch claim — another tick got there first`,
    );
    return;
  }

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
    await store.recordExerciseOutcome(row.id, {
      context: exerciseContext(slot, outcomeName, nowMs, {
        reason,
        evidence,
        final,
      }),
      consume,
      disable: final,
      nowMs,
    });
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
