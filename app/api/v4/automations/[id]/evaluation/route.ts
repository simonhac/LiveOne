/**
 * `GET /api/v4/automations/{au_…}/evaluation` — what this rule would decide right now, and why.
 *
 * 🛑 A GET, and a NOUN, for three reasons that are all load-bearing. It writes nothing, so it keeps
 * the read-verb posture the CLI's `--apply` gate is built around; it reads naturally as state
 * rather than as a command someone might think starts an engine; and `evaluation` matches the
 * `areas/{id}/resolution` precedent rather than inventing a verb-shaped address in the control
 * plane's neighbourhood.
 *
 * It answers from `planExercise` — the READ half of the evaluator, one implementation with two call
 * sites. The dispatch half is not reachable from here, so no wiring mistake in this file can start
 * the generator. `lib/automations/__tests__/evaluate.test.ts` pins that a plan's decision equals the
 * outcome the evaluator records for the same fixture.
 *
 * The expensive part is the `unless` lookback: a 7-day raw-reading scan plus an interval query, per
 * call. That is exactly why it is NOT folded into `GET /api/v4/automations` — the listing read is
 * shared by `list`, `skip` and `move`, and fanning it out into N scans would make every one of them
 * pay for a question they did not ask.
 */
import { NextRequest, NextResponse } from "next/server";
import { Derivation, Point } from "@/lib/ids";
import { loadOwnedAutomation, unprocessable } from "@/lib/automations/http";
import { planExercise } from "@/lib/automations/evaluate-exercise";
import {
  parseAutomationAction,
  parseAutomationTrigger,
} from "@/lib/automations/types";
import { nextOccurrence } from "@/lib/automations/recurrence";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedAutomation(request, id);
  if ("error" in loaded) return loaded.error;
  const { row, area } = loaded;

  // The stored row is `jsonb` with a `.$type<>` annotation, which is nothing at runtime — so it is
  // parsed here like any other untrusted value. A hand-edited row answers 422 rather than throwing.
  const trigger = parseAutomationTrigger(row.trigger);
  if (!trigger.ok) return unprocessable(trigger.error);
  const action = parseAutomationAction(row.action);
  if (!action.ok) return unprocessable(action.error);

  if (trigger.value.kind !== "exercise")
    return NextResponse.json({
      automationId: id,
      areaId: area.id,
      timezone: area.displayTimezone,
      evaluatedAt: new Date().toISOString(),
      // Carried even though the verdict is not: "this rule is disabled" is a finding whatever kind
      // it is, and omitting it made a disabled charge-session rule check out as healthy.
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      kind: trigger.value.kind,
      supported: false,
      detail:
        "dry evaluation is implemented for exercise rules; a charge-session rule reports its armed state on `automation show`",
    });

  const nowMs = Date.now();
  const plan = await planExercise(row, trigger.value, action.value, nowMs);
  const t = trigger.value;

  const common = {
    automationId: id,
    areaId: area.id,
    timezone: area.displayTimezone,
    evaluatedAt: new Date(nowMs).toISOString(),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    kind: "exercise" as const,
    source: {
      derivationId:
        t.source.kind === "derivation"
          ? Derivation.encode(t.source.derivationId)
          : null,
      resolved: plan.kind !== "no-detector" && plan.kind !== "bad-action",
    },
  };

  if (plan.kind === "bad-action")
    return NextResponse.json({
      ...common,
      blockers: [
        {
          code: "bad-action",
          detail: `an exercise rule must dispatch set_value, not '${plan.got}'`,
        },
      ],
    });

  if (plan.kind === "no-detector")
    return NextResponse.json({
      ...common,
      blockers: [
        {
          code: "no-detector",
          detail:
            "the trigger's derivation does not resolve to an ENABLED run detector — nothing can be read about the engine, so nothing is dispatched",
        },
      ],
    });

  const next = nextOccurrence(t.schedule, plan.det.displayTimezone, nowMs);
  const base = {
    ...common,
    next: next
      ? { atMs: next.atMs, at: new Date(next.atMs).toISOString() }
      : null,
    exhausted: plan.kind !== "no-slot" ? plan.exhausted : false,
  };

  if (plan.kind === "no-slot")
    // 🛑 NOT a blocker when there is a next occurrence. `previousOccurrence` returns null for every
    // rule whose first slot is still ahead of it, so treating that as a finding made an enabled
    // one-off scheduled for tomorrow exit 1 today — an alarm on a rule doing exactly its job.
    return NextResponse.json({
      ...base,
      due: { due: false, reason: next ? "not-started" : "no-occurrences" },
      blockers: next
        ? []
        : [
            {
              code: "no-occurrences",
              detail:
                "the schedule yields no occurrence, past or future — nothing will ever fire",
            },
          ],
    });

  const slot = {
    atMs: plan.slot.atMs,
    at: new Date(plan.slot.atMs).toISOString(),
  };

  if (plan.kind === "not-due")
    return NextResponse.json({
      ...base,
      slot,
      due: { due: false, reason: plan.reason },
      blockers: [],
    });

  const { lookback, decision, readiness } = plan;
  return NextResponse.json({
    ...base,
    slot,
    due: { due: true },
    openRun: plan.openRun,
    unless: {
      // 🛑 FLAT, matching the CLI's declared shape. This was nested under `window` and the renderer
      // read it at the top level, so every real response printed "in the last ? days" — invisible
      // to the renderer test, which had been written against the CLI's invented shape rather than
      // against what the route actually sends.
      withinDays: t.unless.withinDays,
      minMinutes: t.unless.minMinutes,
      minLoadKw: t.unless.minLoadKw,
      dipToleranceSeconds: t.unless.dipToleranceSeconds,
      loadPoint: {
        id: Point.encode(t.unless.loadPointId),
        // 🛑 Stated on the wire rather than left to be inferred. This path reads
        // `ReadingsDao.readRaw`, i.e. the stored column, so `points.transform` is NOT applied and
        // the sign convention is the store's. An operator comparing this against `/api/history`,
        // which DOES apply the transform, will otherwise see two different numbers for one point
        // and have no way to know which they are looking at.
        transformApplied: false,
      },
      best: lookback.best
        ? {
            minutes: lookback.best.minutes,
            peakKw: lookback.best.peakKw,
            endedAt: new Date(lookback.best.endMs).toISOString(),
          }
        : null,
      satisfied:
        lookback.best !== null && lookback.best.minutes >= t.unless.minMinutes,
      runsConsidered: lookback.runsConsidered,
      runsExcluded: lookback.runsExcluded,
    },
    require: readiness
      ? {
          socPointId: t.require ? Point.encode(t.require.socPointId) : null,
          socPercent: readiness.socPercent,
          maxSocPercent: readiness.maxSocPercent,
          ready:
            readiness.socPercent === null ||
            readiness.socPercent < readiness.maxSocPercent,
        }
      : null,
    supervise: t.supervise ?? null,
    decision:
      decision.kind === "dispatch"
        ? { kind: "dispatch", outcome: null, reason: null }
        : {
            kind: decision.kind,
            outcome: decision.context.outcome,
            reason: decision.context.reason ?? null,
          },
    wouldDispatch:
      decision.kind === "dispatch" && action.value.kind === "point-action"
        ? {
            pointId: Point.encode(action.value.pointId),
            action: action.value.action,
            value:
              action.value.action === "set_value" ? action.value.value : null,
          }
        : null,
  });
}
