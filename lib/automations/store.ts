/**
 * The `automations` data layer — the one place drizzle is spoken for this table.
 *
 * Routes and the evaluator go through here so their tests mock THIS module rather than stubbing
 * bare drizzle chains (a route test that asserts on a chain is asserting on drizzle, not on us).
 * Every write stamps `updatedAt` and bumps `revision` (see `stamped()` below).
 */
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaMembers,
  automations,
  derivedIntervals,
  type AutomationAction,
  type AutomationArmedContext,
  type AutomationMode,
  type AutomationRow,
  type AutomationTrigger,
  type DerivedInterval,
  type ExerciseArmedContext,
} from "@/lib/db/planetscale/schema";
import { ownerDeviceIdForDerivation } from "@/lib/derivations/resolve";

export async function listForArea(areaUuid: string): Promise<AutomationRow[]> {
  return requirePlanetscaleDb()
    .select()
    .from(automations)
    .where(eq(automations.areaId, areaUuid));
}

export async function getById(uuid: string): Promise<AutomationRow | null> {
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(automations)
    .where(eq(automations.id, uuid))
    .limit(1);
  return row ?? null;
}

/**
 * Batch lookup for the command log's `automation:au_…` requesters. Rows for deleted rules are
 * simply absent — the caller falls back to anonymous wording, so this never throws on a miss.
 */
export async function getByIds(uuids: string[]): Promise<AutomationRow[]> {
  if (uuids.length === 0) return [];
  return requirePlanetscaleDb()
    .select()
    .from(automations)
    .where(inArray(automations.id, uuids));
}

export async function create(values: {
  areaId: string;
  name: string;
  mode: AutomationMode;
  trigger: AutomationTrigger;
  action: AutomationAction;
  enabled?: boolean;
}): Promise<AutomationRow> {
  const [row] = await requirePlanetscaleDb()
    .insert(automations)
    .values({
      areaId: values.areaId,
      name: values.name,
      mode: values.mode,
      trigger: values.trigger,
      action: values.action,
      enabled: values.enabled ?? true,
    })
    .returning();
  return row;
}

/**
 * What every write stamps: `updated_at` for humans, `revision` for the CAS.
 *
 * 🛑 Bumping `revision` here — in EVERY writer, not just the claim — is what makes it a row version
 * rather than a dispatch counter. A writer that forgot to bump it would leave a stale `revision`
 * looking fresh to `claimExerciseSlot`, which is the whole thing the token exists to prevent.
 */
const stamped = () => ({
  updatedAt: new Date(),
  revision: sql`${automations.revision} + 1`,
});

export type AutomationPatch = Partial<
  Pick<
    AutomationRow,
    | "name"
    | "enabled"
    | "mode"
    | "trigger"
    | "action"
    | "armedAt"
    | "armedContext"
    | "lastTriggeredRunStart"
  >
>;

/** Whole-column patch; null when the id doesn't exist. */
export async function patch(
  uuid: string,
  fields: AutomationPatch,
): Promise<AutomationRow | null> {
  const [row] = await requirePlanetscaleDb()
    .update(automations)
    .set({ ...fields, ...stamped() })
    .where(eq(automations.id, uuid))
    .returning();
  return row ?? null;
}

export async function remove(uuid: string): Promise<boolean> {
  const rows = await requirePlanetscaleDb()
    .delete(automations)
    .where(eq(automations.id, uuid))
    .returning({ id: automations.id });
  return rows.length > 0;
}

// ── Evaluator side ───────────────────────────────────────────────────────────────────────────────

export async function listEnabled(): Promise<AutomationRow[]> {
  return requirePlanetscaleDb()
    .select()
    .from(automations)
    .where(eq(automations.enabled, true));
}

export async function armAutomation(
  uuid: string,
  armedAt: Date,
  armedContext: AutomationArmedContext | null,
): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({ armedAt, armedContext, ...stamped() })
    .where(eq(automations.id, uuid));
}

export async function disarmAutomation(
  uuid: string,
  opts: { disable: boolean },
): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({
      armedAt: null,
      armedContext: null,
      ...(opts.disable ? { enabled: false } : {}),
      ...stamped(),
    })
    .where(eq(automations.id, uuid));
}

/**
 * Stamp a fire.
 *
 * 🛑 Deliberately does NOT clear `armedAt`/`armedContext`: a STANDING rule stays armed after
 * firing, and the point-source already-fired suppression IS `lastTriggeredRunStart === armedAt`
 * (see `decide.ts`). Clearing them here would make a standing point rule re-arm and re-fire on the
 * very next tick. The enabled-transition reset lives in the PATCH route — the only seam that sees
 * the toggle.
 */
export async function recordFired(
  uuid: string,
  opts: { firedAt: Date; anchorMs: number; disable: boolean },
): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({
      lastTriggeredAt: opts.firedAt,
      lastTriggeredRunStart: new Date(opts.anchorMs),
      ...(opts.disable ? { enabled: false } : {}),
      ...stamped(),
    })
    .where(eq(automations.id, uuid));
}

/** The terminal `rejected` case: a refusal that is PERMANENT for this vehicle. */
export async function disableAutomation(uuid: string): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({ enabled: false, ...stamped() })
    .where(eq(automations.id, uuid));
}

// ── Scheduled exercise ───────────────────────────────────────────────────────────────────────────

/**
 * Every run interval of `derivationId` that OVERLAPS [fromMs, toMs].
 *
 * Same predicate as the run-periods route: a period is in range if it starts at/before the range
 * end and is either still open or ends at/after the range start. Overlap, not containment — a run
 * that began before the lookback still did real work inside it.
 */
export async function intervalsOverlapping(
  derivationId: string,
  fromMs: number,
  toMs: number,
): Promise<DerivedInterval[]> {
  return requirePlanetscaleDb()
    .select()
    .from(derivedIntervals)
    .where(
      and(
        eq(derivedIntervals.derivationId, derivationId),
        lte(derivedIntervals.startTime, new Date(toMs)),
        or(
          isNull(derivedIntervals.endTime),
          gte(derivedIntervals.endTime, new Date(fromMs)),
        ),
      ),
    )
    .orderBy(asc(derivedIntervals.startTime));
}

/**
 * Record what the evaluator decided about an exercise slot.
 *
 * `runStart` moves the WATERMARK (`lastTriggeredRunStart`), which is what stops a slot being
 * considered again — see `isDue`. Three intents, and the difference between them matters:
 *  - a `Date` — advance it to that slot, or RESTORE it to a previous value after a claimed dispatch
 *    turned out to be declinable. The restore is why this is a value rather than a boolean: a
 *    release must put back the watermark the row had BEFORE the claim, because writing `null` would
 *    wipe it and re-arm whatever earlier occurrence it was holding.
 *  - `null` — clear it, for a row that genuinely had no watermark before the claim.
 *  - omitted — leave it exactly as it is, which is what a `waiting` decision on an unclaimed slot
 *    wants: the slot stays due so the next tick can retry inside the grace window.
 *
 * `lastTriggeredAt` means "we actually dispatched something", so it is stamped ONLY on `fired`.
 * Stamping it for a satisfied or missed slot would make "when did this rule last run the engine"
 * unanswerable.
 *
 * 🛑 `expectRevision` makes this a compare-and-set, and it is not optional in spirit. This write can
 * carry `enabled: false`, and it used to key on the id alone: a tick that computed `disable` from
 * the schedule it read, then had an owner PATCH an RDATE onto that schedule mid-dispatch, would
 * retire a rule that now had an occurrence left — recording `final: true` as its reason, which was
 * no longer true. Returns false when the row has moved on, so the caller can say so.
 */
export async function recordExerciseOutcome(
  uuid: string,
  opts: {
    context: ExerciseArmedContext;
    /** The watermark after this write. Omit to leave it untouched. See above. */
    runStart?: Date | null;
    nowMs: number;
    /**
     * The schedule has no occurrences left, so retire the rule in the SAME write that consumes its
     * last slot. One statement rather than a consume followed by a disable, because the two must
     * not be separable: a crash between them would leave a spent rule enabled and no longer able
     * to say why it never fires again.
     */
    disable?: boolean;
    /** The revision this decision was computed against. Refuses the write if the row has moved on. */
    expectRevision?: number;
  },
): Promise<boolean> {
  const now = new Date(opts.nowMs);
  const rows = await requirePlanetscaleDb()
    .update(automations)
    .set({
      armedContext: opts.context,
      ...("runStart" in opts ? { lastTriggeredRunStart: opts.runStart } : {}),
      ...(opts.disable ? { enabled: false } : {}),
      ...(opts.context.outcome === "fired" ? { lastTriggeredAt: now } : {}),
      ...stamped(),
    })
    .where(
      opts.expectRevision === undefined
        ? eq(automations.id, uuid)
        : exerciseClaimWhere(uuid, opts.expectRevision),
    )
    .returning({ id: automations.id });
  return rows.length > 0;
}

/**
 * The claim predicate, extracted ONLY so `store-claim.test.ts` can pin the SQL it generates without
 * a database. Nothing else should call it.
 *
 * 🛑 The CAS key is the integer `revision`, and it is a timestamp no longer ON PURPOSE. Until #468
 * this compared `updated_at`, a `timestamp(6) DEFAULT now()` column that `create()` above does not
 * stamp — so a row that had never been written from JS carried MICROSECONDS (`…:43.616884`), which
 * drizzle parses with `new Date(…)` (TRUNCATING to milliseconds) and sends back as `…:43.616Z`.
 * `updated_at = $2` therefore matched NOTHING: every tick "lost" a claim nobody held, `fireExercise`
 * returned silently, and two live generator-exercise rules never fired once.
 *
 * Migration 0064 made every such column `timestamp(3)` so that class of mismatch cannot recur, but
 * the deeper point is that an equality on a TIME is a comparison whose correctness depends on two
 * serialisers agreeing about precision AND about the zone (a bare `${date}` parameter is encoded by
 * node-postgres in the PROCESS's local zone, and Postgres silently drops the offset coercing to
 * `timestamp without time zone`). An integer has neither failure mode, and it is the idiom this
 * codebase already uses for optimistic concurrency — `dashboards.revision`.
 *
 * The house rule, recorded in `docs/architecture/data-model.md`: **optimistic concurrency uses an
 * integer `revision`, never a timestamp.**
 */
export function exerciseClaimWhere(uuid: string, revision: number) {
  return and(eq(automations.id, uuid), eq(automations.revision, revision));
}

/**
 * Claim a slot for dispatch AND consume it, in one statement, immediately before starting an engine.
 *
 * `/api/cron/derivations` holds no cron lease, so two invocations really can overlap. For a charge
 * limit a duplicate `turn_off` is harmless; here a duplicate dispatch re-extends a running engine's
 * stop deadline, so the race is worth one extra round trip. Returns null if another tick got there
 * first, and otherwise the revision this caller now owns — which `recordExerciseOutcome` needs, so
 * that the write finishing this decision can compare-and-set against the row it was computed from.
 *
 * Correct under READ COMMITTED: the losing tick blocks on the row lock, then re-evaluates its
 * `WHERE` against the winner's committed row, whose `revision` has moved on past the value it read.
 *
 * 🛑 The consume is IN this statement, and that is the whole point of the design.
 *
 * It used to be a bare revision bump, with the slot consumed only once the dispatch returned — and a
 * CAS on `revision` protects ticks that read the SAME revision, not ticks that read in sequence. A
 * tick listing the rule after this claim committed but before the slot was consumed read the bumped
 * revision, found the slot still unconsumed, and claimed it legitimately: both dispatched. The old
 * comment argued that needed "a dispatch to outlive its own tick", which understated it — the
 * dispatch is an HTTP round trip to the Fly hub against a minutely cron, so the window opens exactly
 * when the hub is slow or unreachable, which is when a start is most likely to be retried.
 *
 * Consuming here makes the second dispatch structurally impossible: the second tick sees the slot
 * closed and never reaches `decideExercise`. What it buys with is a narrower failure — a crash
 * between this statement and the dispatch leaves a slot marked dealt-with that never ran. That is
 * one silently missed exercise rather than a generator started twice, it needs a crash inside a
 * ~1s window, and `reportUndecidedSlots` is watching. The alternative that avoids both is a durable
 * per-slot lease, which costs a column and a stale-lease timeout to earn nothing more for one
 * generator.
 *
 * A declined dispatch RELEASES the slot — see `recordExerciseOutcome`, and note that releasing means
 * restoring the previous watermark, not writing null.
 *
 * The bump goes through `stamped()` like every other write, so it is `revision + 1` computed IN SQL
 * rather than from the caller's arithmetic — the counter follows what the row actually holds.
 *
 * See `exerciseClaimWhere` for why the key is an integer and not `updated_at`.
 */
export async function claimExerciseSlot(
  uuid: string,
  revision: number,
  slotAtMs: number,
): Promise<{ revision: number } | null> {
  const rows = await requirePlanetscaleDb()
    .update(automations)
    .set({ lastTriggeredRunStart: new Date(slotAtMs), ...stamped() })
    .where(exerciseClaimWhere(uuid, revision))
    .returning({ revision: automations.revision });
  return rows[0] ?? null;
}

/**
 * Referential check for a derivation-sourced trigger: does this derivation belong to this area?
 *
 * 🛑 The question is unchanged; what answers it is not. It used to read `derivations.area_id` — the
 * column that said where a derivation was FILED — and since migration 0063 a derivation's site is
 * DERIVED from its wiring instead. So: the derivation's owner device (energy point's, else
 * signal's; `power` for an hws-model) must be a member of this area.
 *
 * That is a slightly different set, and deliberately: a detector reading points on a composite
 * area's member device now belongs to that composite, which is exactly the case `area_id` could
 * never express. It is NOT an authorization check on its own — the caller's read access to the
 * derivation's device set is checked beside it, in `checkReferences`.
 */
export async function derivationBelongsToArea(
  derivationUuid: string,
  areaUuid: string,
): Promise<boolean> {
  const ownerDeviceId = await ownerDeviceIdForDerivation(derivationUuid);
  if (!ownerDeviceId) return false;
  const [row] = await requirePlanetscaleDb()
    .select({ deviceId: areaMembers.deviceId })
    .from(areaMembers)
    .where(
      and(
        eq(areaMembers.areaId, areaUuid),
        eq(areaMembers.deviceId, ownerDeviceId),
      ),
    )
    .limit(1);
  return !!row;
}
