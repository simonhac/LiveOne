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
 * looking fresh to `claimExerciseDispatch`, which is the whole thing the token exists to prevent.
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
 * `consume` is the whole point: it writes the slot instant into `lastTriggeredRunStart`, which is
 * what stops the slot being considered again. A `waiting` decision deliberately does NOT consume —
 * the slot must stay due so the next tick can retry inside the grace window.
 *
 * `lastTriggeredAt` means "we actually dispatched something", so it is stamped ONLY on `fired`.
 * Stamping it for a satisfied or missed slot would make "when did this rule last run the engine"
 * unanswerable.
 */
export async function recordExerciseOutcome(
  uuid: string,
  opts: {
    context: ExerciseArmedContext;
    consume: boolean;
    nowMs: number;
    /**
     * The schedule has no occurrences left, so retire the rule in the SAME write that consumes its
     * last slot. One statement rather than a consume followed by a disable, because the two must
     * not be separable: a crash between them would leave a spent rule enabled and no longer able
     * to say why it never fires again.
     */
    disable?: boolean;
  },
): Promise<void> {
  const now = new Date(opts.nowMs);
  await requirePlanetscaleDb()
    .update(automations)
    .set({
      armedContext: opts.context,
      ...(opts.consume
        ? { lastTriggeredRunStart: new Date(opts.context.slotAt) }
        : {}),
      ...(opts.disable ? { enabled: false } : {}),
      ...(opts.context.outcome === "fired" ? { lastTriggeredAt: now } : {}),
      ...stamped(),
    })
    .where(eq(automations.id, uuid));
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
 * Compare-and-set on `revision`, taken immediately before dispatching a start.
 *
 * `/api/cron/derivations` holds no cron lease, so two invocations really can overlap. For a charge
 * limit a duplicate `turn_off` is harmless; here a duplicate dispatch re-extends a running engine's
 * stop deadline, so the race is worth one extra round trip. Returns false if another tick got
 * there first.
 *
 * Correct under READ COMMITTED: the losing tick blocks on the row lock, then re-evaluates its
 * `WHERE` against the winner's committed row, whose `revision` has moved on past the value it read.
 *
 * 🛑 What this does NOT do, and never did as an `updated_at` CAS either: it protects ticks that read
 * the SAME revision, not ticks that read in sequence. A tick that lists the rule AFTER a previous
 * tick's claim commits but BEFORE that tick reaches `recordExerciseOutcome` (the slot is consumed
 * only once the dispatch returns) reads the bumped revision and claims it legitimately, and both
 * dispatch. The window is the length of one dispatch — an HTTP round trip to the hub — against a
 * minutely cron, so it needs a dispatch to outlive its own tick. Closing it properly means consuming
 * the slot before dispatching, or a durable per-slot lease; both change what a crash mid-dispatch
 * costs, so neither is a drive-by.
 *
 * The bump goes through `stamped()` like every other write, so it is `revision + 1` computed IN SQL
 * rather than from the caller's arithmetic — the counter follows what the row actually holds.
 *
 * See `exerciseClaimWhere` for why the key is an integer and not `updated_at`.
 */
export async function claimExerciseDispatch(
  uuid: string,
  revision: number,
): Promise<boolean> {
  const rows = await requirePlanetscaleDb()
    .update(automations)
    .set(stamped())
    .where(exerciseClaimWhere(uuid, revision))
    .returning({ id: automations.id });
  return rows.length > 0;
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
