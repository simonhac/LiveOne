/**
 * The `automations` data layer — the one place drizzle is spoken for this table.
 *
 * Routes and the evaluator go through here so their tests mock THIS module rather than stubbing
 * bare drizzle chains (a route test that asserts on a chain is asserting on drizzle, not on us).
 * Every write stamps `updatedAt`, like the derivations PATCH does.
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
    .set({ ...fields, updatedAt: new Date() })
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
    .set({ armedAt, armedContext, updatedAt: new Date() })
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
      updatedAt: new Date(),
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
      updatedAt: new Date(),
    })
    .where(eq(automations.id, uuid));
}

/** The terminal `rejected` case: a refusal that is PERMANENT for this vehicle. */
export async function disableAutomation(uuid: string): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({ enabled: false, updatedAt: new Date() })
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
      ...(opts.context.outcome === "fired" ? { lastTriggeredAt: now } : {}),
      updatedAt: new Date(),
    })
    .where(eq(automations.id, uuid));
}

/**
 * The claim predicate, extracted ONLY so `store-claim.test.ts` can pin the SQL it generates without
 * a database. Nothing else should call it.
 *
 * 🛑 The comparison is truncated to MILLISECONDS, and that is load-bearing rather than cosmetic.
 * `updated_at` is `timestamp(6) DEFAULT now()` and `create()` above does not stamp it, so a row that
 * has never been written from JS carries MICROSECONDS (`…:43.616884`). node-postgres hands drizzle
 * the raw string, drizzle parses it with `new Date(…)` — which TRUNCATES to milliseconds — and sends
 * it back as `toISOString()` (`…:43.616Z`). A plain `updated_at = $2` therefore matched NOTHING for
 * any never-PATCHed row: every tick "lost" a claim nobody held and `fireExercise` returned silently,
 * so two live exercise rules never fired once. Compare at the precision the round trip survives.
 * Truncating (not rounding) is exactly right here because that is what V8 does on the way in.
 *
 * 🛑 `sql.param(…, automations.updatedAt)` is load-bearing too: it forces the COLUMN's own encoder,
 * which is UTC `toISOString()`. A bare `${updatedAt}` hands the `Date` straight to node-postgres,
 * which serialises it in the PROCESS's local zone (`…+10:00`); Postgres then drops the offset
 * coercing to `timestamp without time zone` and the predicate is silently wrong by the UTC offset.
 * `eq()` would not encode it either — its `bindIfParam` only does so when the left-hand side is a
 * driver-value encoder, and a `SQL` expression is not.
 *
 * The general rule this is an instance of: **never compare a `defaultNow()`-populated `timestamp`
 * for equality against a value that has round-tripped through JS.**
 */
export function exerciseClaimWhere(uuid: string, updatedAt: Date) {
  return and(
    eq(automations.id, uuid),
    sql`date_trunc('milliseconds', ${automations.updatedAt}) = ${sql.param(updatedAt, automations.updatedAt)}`,
  );
}

/**
 * Compare-and-set on `updatedAt`, taken immediately before dispatching a start.
 *
 * `/api/cron/derivations` holds no cron lease, so two invocations really can overlap. For a charge
 * limit a duplicate `turn_off` is harmless; here a duplicate dispatch re-extends a running engine's
 * stop deadline, so the race is worth one extra round trip. Returns false if another tick got
 * there first.
 *
 * Correct under READ COMMITTED: the losing tick blocks on the row lock, then re-evaluates its
 * `WHERE` against the winner's committed row, whose `updated_at` is now a fresh JS millisecond value
 * that its own stale parameter cannot match.
 *
 * See `exerciseClaimWhere` for why the comparison is not a plain `eq`.
 */
export async function claimExerciseDispatch(
  uuid: string,
  updatedAt: Date,
): Promise<boolean> {
  const rows = await requirePlanetscaleDb()
    .update(automations)
    .set({ updatedAt: new Date() })
    .where(exerciseClaimWhere(uuid, updatedAt))
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
