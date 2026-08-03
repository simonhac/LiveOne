/**
 * The DB shell around `decide.ts` — one pass over every enabled automation.
 *
 * Runs as a best-effort FOURTH step on the minutely `/api/cron/derivations` pass, after
 * `reconcileTrailingWindow`, so the open interval a derivation-sourced limit reads is as of this
 * minute.
 *
 * Every automation is evaluated inside its OWN try/catch: one broken row (a hand-edited trigger, a
 * deleted point) must not cost the rest of the pass. Failures are swallowed but COUNTED and
 * surfaced in the summary — the `trackersFailed` lesson from `lib/run-tracking/recompute.ts`.
 *
 * ## Semantics worth stating once, because the UI has to word them honestly
 *
 * A **derivation** source measures from the RUN START (the detector already knows when charging
 * began). A **point** source measures from ARM TIME, because its counter
 * (`charge_energy_added`) is energy-above-plug-in-baseline for the whole CABLE session — the
 * charge leg's own total is unknowable from it, which is exactly why we snapshot a baseline. For a
 * standing rule the two coincide; for a `once` created mid-session they deliberately do not.
 */
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
import { Automation, Point } from "@/lib/ids";
import type { AutomationRow } from "@/lib/db/planetscale/schema";
import {
  ANCHOR_TOLERANCE_FLOOR_MS,
  POINT_LOOKBACK_MS,
  decideAutomation,
  pointSourceState,
  type Decision,
  type DecisionInputs,
  type SourceState,
} from "./decide";
import * as store from "./store";
import {
  parseArmedContext,
  parseAutomationAction,
  parseAutomationTrigger,
} from "./types";

export interface AutomationsSummary {
  evaluated: number;
  armed: number;
  disarmed: number;
  fired: number;
  skipped: number;
  errors: number;
}

const UNKNOWN: SourceState = {
  status: "unknown",
  runStartMs: null,
  runKwh: null,
  counter: null,
  anchorToleranceMs: 0,
};

/** Latest sample with a non-null numeric value, or null. `readRaw` returns ascending series. */
function latestValued(
  series: { measurementTimeMs: number; value: number | null }[] | undefined,
): { value: number; atMs: number } | null {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i];
    if (s.value != null) return { value: s.value, atMs: s.measurementTimeMs };
  }
  return null;
}

async function resolveDerivationSource(
  derivationId: string,
): Promise<SourceState> {
  const [det] = await listEnabledRunDetectors({ derivationId });
  if (!det) {
    // Deleted, disabled or unresolvable. `unknown` — a broken detector must neither fire
    // anything nor disable a `once`.
    console.warn(
      `[automations] trigger derivation ${derivationId} did not resolve to an enabled run detector`,
    );
    return UNKNOWN;
  }
  const anchorToleranceMs = Math.max(
    det.detect.delayOffMs,
    ANCHOR_TOLERANCE_FLOOR_MS,
  );
  const run = await getOpenRun(det.id);
  if (!run)
    return { ...UNKNOWN, status: "inactive", anchorToleranceMs };
  return {
    status: "active",
    runStartMs: run.startTime.getTime(),
    runKwh: run.energyKwh ?? null,
    counter: null,
    anchorToleranceMs,
  };
}

async function resolvePointSource(
  pointUuid: string,
  nowMs: number,
): Promise<SourceState> {
  const loaded = await loadPointByUuid(pointUuid);
  if (!loaded) {
    console.warn(`[automations] trigger point ${pointUuid} not found`);
    return UNKNOWN;
  }
  const { point, deviceRid } = loaded;
  if (!point.logicalPath) {
    console.warn(`[automations] trigger point ${pointUuid} has no logical path`);
    return UNKNOWN;
  }
  // The counter alone cannot say whether a session is live (it is retained for hours after a
  // charge ends). Its stem-sibling boolean can.
  const activePoint = await loadPointByStemMetric(
    deviceRid,
    point.logicalPath,
    "active",
  );
  if (!activePoint) {
    console.warn(
      `[automations] trigger point ${pointUuid} has no ${point.logicalPath}/active sibling`,
    );
    return UNKNOWN;
  }
  const counterId = Point.encode(point.id);
  const activeId = Point.encode(activePoint.id);
  const series = await ReadingsDao.readRaw([counterId, activeId], {
    fromMs: nowMs - POINT_LOOKBACK_MS,
    toMs: nowMs,
  });
  const counterSample = latestValued(series.get(counterId));
  const activeSample = latestValued(series.get(activeId));
  return pointSourceState(
    counterSample
      ? { valueKwh: counterSample.value, atMs: counterSample.atMs }
      : null,
    activeSample,
    nowMs,
  );
}

export async function evaluateAutomations(
  nowMs: number,
): Promise<AutomationsSummary> {
  const summary: AutomationsSummary = {
    evaluated: 0,
    armed: 0,
    disarmed: 0,
    fired: 0,
    skipped: 0,
    errors: 0,
  };
  const rows = await store.listEnabled();
  for (const row of rows) {
    summary.evaluated++;
    try {
      await evaluateOne(row, nowMs, summary);
    } catch (err) {
      summary.errors++;
      console.error(`[automations] ${row.id} evaluation failed:`, err);
    }
  }
  return summary;
}

async function evaluateOne(
  row: AutomationRow,
  nowMs: number,
  summary: AutomationsSummary,
): Promise<void> {
  // Never trust the jsonb (`$type<>` is a compile-time annotation). A hand-edited row is LOGGED,
  // not auto-disabled — silently killing a user's rule because we could not read it is worse.
  const trigger = parseAutomationTrigger(row.trigger);
  if (!trigger.ok) {
    summary.errors++;
    console.error(`[automations] ${row.id} has an unreadable trigger: ${trigger.error}`);
    return;
  }
  const action = parseAutomationAction(row.action);
  if (!action.ok) {
    summary.errors++;
    console.error(`[automations] ${row.id} has an unreadable action: ${action.error}`);
    return;
  }

  const src =
    trigger.value.source.kind === "derivation"
      ? await resolveDerivationSource(trigger.value.source.derivationId)
      : await resolvePointSource(trigger.value.source.pointId, nowMs);

  const inputs: DecisionInputs = {
    mode: row.mode as DecisionInputs["mode"],
    sourceKind: trigger.value.source.kind,
    afterMinutes: trigger.value.afterMinutes ?? null,
    afterKwh: trigger.value.afterKwh ?? null,
    armedAtMs: row.armedAt ? row.armedAt.getTime() : null,
    armedContext: parseArmedContext(row.armedContext),
    lastTriggeredRunStartMs: row.lastTriggeredRunStart
      ? row.lastTriggeredRunStart.getTime()
      : null,
  };

  let decision: Decision = decideAutomation(inputs, src, nowMs);

  if (decision.kind === "arm") {
    await store.armAutomation(row.id, new Date(nowMs), decision.armedContext);
    summary.armed++;
    // A `once` created mid-run on a derivation source may already be past its threshold, so the
    // arm is immediately re-evaluated with the updated inputs. Bounded: an arm can only be
    // followed by fire/already-fired/none — a fresh baseline equals the current counter, so the
    // reset check cannot trip on the re-invoke.
    decision = decideAutomation(
      { ...inputs, armedAtMs: nowMs, armedContext: decision.armedContext },
      src,
      nowMs,
    );
    if (decision.kind === "arm") return;
  }

  switch (decision.kind) {
    case "none":
      return;
    case "disarm":
      await store.disarmAutomation(row.id, { disable: decision.disable });
      summary.disarmed++;
      return;
    case "already-fired":
      summary.skipped++;
      return;
    case "fire":
      await fire(row, action.value.pointId, decision.anchorMs, nowMs, summary);
      return;
  }
}

async function fire(
  row: AutomationRow,
  actionPointUuid: string,
  anchorMs: number,
  nowMs: number,
  summary: AutomationsSummary,
): Promise<void> {
  const loaded = await loadPointByUuid(actionPointUuid);
  if (!loaded) {
    summary.errors++;
    console.error(
      `[automations] ${row.id} action point ${actionPointUuid} not found — leaving armed`,
    );
    return;
  }
  const device = await DeviceConfigRegistry.deviceByHandle(loaded.deviceRid);
  if (!device) {
    summary.errors++;
    console.error(
      `[automations] ${row.id} action device ${loaded.deviceRid} not found — leaving armed`,
    );
    return;
  }

  // 🛑 IN-PROCESS through the one dispatch path. `requestedBy` is AUDIT ONLY — an automation has
  // no session user and credentials always resolve from the DEVICE OWNER.
  const outcome = await dispatchPointAction({
    point: loaded.point,
    device,
    action: "turn_off",
    requestedBy: `automation:${Automation.encode(row.id)}`,
  });

  switch (outcome.kind) {
    case "completed": {
      // 🛑 `ok:false` is Tesla's benign `not_charging` decline: the goal state ALREADY holds.
      // Success-and-disarm, never a retry.
      await store.recordFired(row.id, {
        firedAt: new Date(nowMs),
        anchorMs,
        disable: row.mode === "once",
      });
      summary.fired++;
      // Freshness only when something actually changed — a decline changed nothing, so paying
      // for a vendor read would be pure waste. `scheduleRepoll` wraps `after()`, which throws
      // outside a request scope; never call `after()` directly from here.
      if (outcome.ok) scheduleRepoll(device);
      return;
    }
    case "rejected": {
      // A protocol/config refusal (e.g. `vehicle_command_protocol_required`) is PERMANENT for
      // this vehicle. Retrying every minute would burn a vendor read + a command per tick and
      // flood `point_commands` for a car that can never accept it.
      await store.disableAutomation(row.id);
      summary.errors++;
      console.error(
        `[automations] ${row.id} disabled — vendor refused (${outcome.code}): ${outcome.error}`,
      );
      return;
    }
    default: {
      // invalid / unavailable / failed — transient. Leave it armed; the next tick retries while
      // the session lasts. (`invalid` also covers the post-deploy `points.control = NULL` heal
      // window; `unavailable 503` a car that would not wake.)
      summary.errors++;
      console.error(
        `[automations] ${row.id} dispatch ${outcome.kind}: ${outcome.error} — leaving armed`,
      );
      return;
    }
  }
}
