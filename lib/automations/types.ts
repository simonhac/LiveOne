/**
 * Runtime parsing of the closed automation vocabulary (`charge-session` + `exercise` triggers,
 * `turn_off` + `set_value` actions).
 *
 * `automations.trigger`/`action` are `jsonb` with a `.$type<>` annotation on the schema — which is
 * a TypeScript convenience for WRITERS and nothing at all at runtime. Every reader (the evaluator
 * on a stored row, the routes on an untrusted body) parses through here, so a hand-edited row
 * degrades to a logged error rather than crashing the whole minutely pass.
 *
 * Pure and DB-free: types come from the schema (type-only import, the `point-control.ts`
 * precedent), nothing else does.
 */
import { isCanonicalUuid } from "@/lib/ids";
import { parseRRuleSubset, WALL_CLOCK } from "./recurrence";
import type {
  AutomationAction,
  AutomationArmedContext,
  AutomationTrigger,
  AutomationTriggerSource,
  ChargeArmedContext,
  ChargeSessionTrigger,
  ExerciseArmedContext,
  ExerciseOutcome,
  ExerciseSchedule,
  ExerciseTrigger,
  ExerciseUnless,
} from "@/lib/db/planetscale/schema";

/**
 * Runtime mirror of the closed outcome vocabulary whose home is `schema.ts`.
 *
 * Re-declared rather than imported because the schema import above is deliberately TYPE-ONLY (the
 * `point-control.ts` precedent) — importing the const array would make this module pull drizzle in
 * at runtime, and this file is the one every untrusted body is parsed through. `satisfies` catches
 * a value that is not in the schema's union.
 */
const OUTCOMES = [
  "fired",
  "satisfied",
  "waiting",
  "missed",
  "missed-running",
] as const satisfies readonly ExerciseOutcome[];

type _OutcomesAreComplete =
  Exclude<ExerciseOutcome, (typeof OUTCOMES)[number]> extends never
    ? true
    : never;
/**
 * 🛑 THIS ASSERTS NOTHING. It was meant to fail the build when an outcome is missing from the
 * array above, but a missing member only makes the branch `never`, and `[never]` is a perfectly
 * legal tuple type — nothing errors. The `satisfies` clause on OUTCOMES checks that every listed
 * value is valid, NOT that every valid value is listed, so the completeness check this was
 * standing in for does not currently exist.
 *
 * @knipignore Kept only so the inert check stays visible until it is either made real (an
 * assignment that fails on `never`) or removed along with the conditional type.
 */
export type AutomationVocabularyIsInStep = [_OutcomesAreComplete];

export type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail<T>(error: string): ParseOutcome<T> {
  return { ok: false, error };
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** A threshold is optional, but when present must be a finite number strictly greater than zero. */
function parseThreshold(
  raw: unknown,
  field: string,
): ParseOutcome<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isFinite(raw))
    return fail(`${field} must be a finite number`);
  if (raw <= 0) return fail(`${field} must be greater than 0`);
  return { ok: true, value: raw };
}

function parseSource(raw: unknown): ParseOutcome<AutomationTriggerSource> {
  if (!isObject(raw)) return fail("trigger.source must be an object");
  if (raw.kind === "derivation") {
    if (
      typeof raw.derivationId !== "string" ||
      !isCanonicalUuid(raw.derivationId)
    )
      return fail("trigger.source.derivationId must be a derivation id");
    return {
      ok: true,
      value: { kind: "derivation", derivationId: raw.derivationId },
    };
  }
  if (raw.kind === "point") {
    if (typeof raw.pointId !== "string" || !isCanonicalUuid(raw.pointId))
      return fail("trigger.source.pointId must be a point id");
    return { ok: true, value: { kind: "point", pointId: raw.pointId } };
  }
  return fail("trigger.source.kind must be one of: derivation, point");
}

/**
 * Validate an already-uuid-decoded trigger. This checks SHAPE + numbers, not TypeIDs —
 * `lib/automations/wire.ts` owns the TypeID→uuid translation and runs before this.
 */
export function parseAutomationTrigger(
  raw: unknown,
): ParseOutcome<AutomationTrigger> {
  if (!isObject(raw)) return fail("trigger must be an object");
  if (raw.kind === "charge-session") return parseChargeSessionTrigger(raw);
  if (raw.kind === "exercise") return parseExerciseTrigger(raw);
  return fail("trigger.kind must be one of: charge-session, exercise");
}

function parseChargeSessionTrigger(
  raw: Record<string, unknown>,
): ParseOutcome<ChargeSessionTrigger> {
  const source = parseSource(raw.source);
  if (!source.ok) return fail(source.error);

  const minutes = parseThreshold(raw.afterMinutes, "trigger.afterMinutes");
  if (!minutes.ok) return fail(minutes.error);
  const kwh = parseThreshold(raw.afterKwh, "trigger.afterKwh");
  if (!kwh.ok) return fail(kwh.error);
  if (minutes.value === undefined && kwh.value === undefined)
    return fail("trigger must set at least one of afterMinutes, afterKwh");

  const value: ChargeSessionTrigger = {
    kind: "charge-session",
    source: source.value,
  };
  if (minutes.value !== undefined) value.afterMinutes = minutes.value;
  if (kwh.value !== undefined) value.afterKwh = kwh.value;
  return { ok: true, value };
}

/** Defaults for every optional exercise knob — "30 min weekly, 3 h grace, 1.5 kW". */
const EXERCISE_DEFAULTS = {
  graceMinutes: 180,
  minMinutes: 30,
  minLoadKw: 1.5,
  dipToleranceSeconds: 180,
  withinDays: 7,
} as const;

/** A required positive number that falls back to a default when absent. */
function parseKnob(
  raw: unknown,
  field: string,
  fallback: number,
): ParseOutcome<number> {
  if (raw === undefined || raw === null) return { ok: true, value: fallback };
  const parsed = parseThreshold(raw, field);
  if (!parsed.ok) return fail(parsed.error);
  return { ok: true, value: parsed.value as number };
}

/**
 * A local wall-clock instant, "YYYY-MM-DDTHH:MM".
 *
 * The regex alone would accept 2026-02-31, so the date is round-tripped through `Date.UTC` as
 * well. It is checked in UTC deliberately: this is a CALENDAR validity check ("is there such a
 * day"), not an instant, and the area's zone has no bearing on whether February has a 31st.
 */
function parseWallClock(raw: unknown, field: string): ParseOutcome<string> {
  if (typeof raw !== "string")
    return fail(`${field} must be a "YYYY-MM-DDTHH:MM" local wall clock time`);
  const m = WALL_CLOCK.exec(raw);
  if (!m)
    return fail(`${field} must be a "YYYY-MM-DDTHH:MM" local wall clock time`);

  const [, year, month, day] = m;
  const probe = new Date(Date.UTC(+year, +month - 1, +day));
  if (
    probe.getUTCFullYear() !== +year ||
    probe.getUTCMonth() !== +month - 1 ||
    probe.getUTCDate() !== +day
  )
    return fail(`${field} is not a real calendar date`);

  // 🛑 A daylight-saving spring-forward skips a local hour outright, so a slot inside it never
  // occurs and the rule would silently never fire. Australian transitions are at 02:00 local; the
  // whole hour is refused rather than silently shifted, because shifting it would be us inventing a
  // time the owner did not ask for.
  if (m[4] === "02")
    return fail(
      `${field} must not be in the 02:00–02:59 hour (a daylight-saving change can skip it entirely)`,
    );

  return { ok: true, value: raw };
}

/**
 * An EXDATE/RDATE list. Sorted and deduped so that two spellings of the same set store identically
 * — the job `parseWeekdays` used to do for the weekday list.
 */
function parseDateList(
  raw: unknown,
  field: string,
): ParseOutcome<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return fail(`${field} must be an array`);
  if (raw.length === 0) return { ok: true, value: undefined };

  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = parseWallClock(entry, `${field} entries`);
    if (!parsed.ok) return fail(parsed.error);
    seen.add(parsed.value);
  }
  // Lexicographic sort IS chronological for this fixed-width format.
  return { ok: true, value: [...seen].sort() };
}

function parseSchedule(raw: unknown): ParseOutcome<ExerciseSchedule> {
  if (!isObject(raw)) return fail("trigger.schedule must be an object");

  const start = parseWallClock(raw.start, "trigger.schedule.start");
  if (!start.ok) return fail(start.error);

  let rrule: string | undefined;
  if (raw.rrule !== undefined && raw.rrule !== null) {
    const parsed = parseRRuleSubset(raw.rrule);
    if (!parsed.ok) return fail(parsed.error);
    rrule = parsed.value;
  }

  const exdates = parseDateList(raw.exdates, "trigger.schedule.exdates");
  if (!exdates.ok) return fail(exdates.error);
  const rdates = parseDateList(raw.rdates, "trigger.schedule.rdates");
  if (!rdates.ok) return fail(rdates.error);

  const graceMinutes = parseKnob(
    raw.graceMinutes,
    "trigger.schedule.graceMinutes",
    EXERCISE_DEFAULTS.graceMinutes,
  );
  if (!graceMinutes.ok) return fail(graceMinutes.error);

  const value: ExerciseSchedule = {
    start: start.value,
    graceMinutes: graceMinutes.value,
  };
  // Optional fields are OMITTED rather than stored as undefined/[], so the stored jsonb of a
  // one-off with no exceptions is the smallest thing that says what it means.
  if (rrule !== undefined) value.rrule = rrule;
  if (exdates.value !== undefined) value.exdates = exdates.value;
  if (rdates.value !== undefined) value.rdates = rdates.value;
  return { ok: true, value };
}

function parseUnless(raw: unknown): ParseOutcome<ExerciseUnless> {
  if (!isObject(raw)) return fail("trigger.unless must be an object");

  if (typeof raw.loadPointId !== "string" || !isCanonicalUuid(raw.loadPointId))
    return fail("trigger.unless.loadPointId must be a point id");

  const minMinutes = parseKnob(
    raw.minMinutes,
    "trigger.unless.minMinutes",
    EXERCISE_DEFAULTS.minMinutes,
  );
  if (!minMinutes.ok) return fail(minMinutes.error);
  const minLoadKw = parseKnob(
    raw.minLoadKw,
    "trigger.unless.minLoadKw",
    EXERCISE_DEFAULTS.minLoadKw,
  );
  if (!minLoadKw.ok) return fail(minLoadKw.error);
  const dipToleranceSeconds = parseKnob(
    raw.dipToleranceSeconds,
    "trigger.unless.dipToleranceSeconds",
    EXERCISE_DEFAULTS.dipToleranceSeconds,
  );
  if (!dipToleranceSeconds.ok) return fail(dipToleranceSeconds.error);
  const withinDays = parseKnob(
    raw.withinDays,
    "trigger.unless.withinDays",
    EXERCISE_DEFAULTS.withinDays,
  );
  if (!withinDays.ok) return fail(withinDays.error);

  return {
    ok: true,
    value: {
      loadPointId: raw.loadPointId,
      minMinutes: minMinutes.value,
      minLoadKw: minLoadKw.value,
      dipToleranceSeconds: dipToleranceSeconds.value,
      withinDays: withinDays.value,
    },
  };
}

function parseExerciseTrigger(
  raw: Record<string, unknown>,
): ParseOutcome<ExerciseTrigger> {
  const source = parseSource(raw.source);
  if (!source.ok) return fail(source.error);
  // The skip condition is "has the ENGINE run recently", which is a question only the run detector
  // can answer. A point source has no run history, so it is refused here rather than failing
  // mysteriously at evaluation time.
  if (source.value.kind !== "derivation")
    return fail("trigger.source must be a derivation for an exercise trigger");

  const schedule = parseSchedule(raw.schedule);
  if (!schedule.ok) return fail(schedule.error);
  const unless = parseUnless(raw.unless);
  if (!unless.ok) return fail(unless.error);

  return {
    ok: true,
    value: {
      kind: "exercise",
      source: source.value,
      schedule: schedule.value,
      unless: unless.value,
    },
  };
}

/**
 * Validate an already-uuid-decoded action. The action set is CLOSED — `turn_on`/`press` are a
 * later PR's decision, not something a body may smuggle in.
 */
export function parseAutomationAction(
  raw: unknown,
): ParseOutcome<AutomationAction> {
  if (!isObject(raw)) return fail("action must be an object");
  if (raw.kind !== "point-action")
    return fail("action.kind must be 'point-action'");
  if (typeof raw.pointId !== "string" || !isCanonicalUuid(raw.pointId))
    return fail("action.pointId must be a point id");

  if (raw.action === "turn_off") {
    if (raw.value !== undefined && raw.value !== null)
      return fail("action.value is not valid for 'turn_off'");
    return {
      ok: true,
      value: { kind: "point-action", pointId: raw.pointId, action: "turn_off" },
    };
  }

  if (raw.action === "set_value") {
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value))
      return fail("action.value must be a finite number for 'set_value'");
    // 🛑 Not merely a sanity bound. On the generator's run-request point 0 releases the latch —
    // it is a STOP — so a scheduled "set_value 0" would be a scheduled shutdown wearing the
    // costume of a scheduled run. The real min/max is checked later against points.control.
    if (raw.value <= 0)
      return fail(
        "action.value must be greater than 0 (0 is a stop, not a run)",
      );
    return {
      ok: true,
      value: {
        kind: "point-action",
        pointId: raw.pointId,
        action: "set_value",
        value: raw.value,
      },
    };
  }

  return fail("action.action must be one of: turn_off, set_value");
}

/**
 * Tolerant reader for `armed_context` — state WE wrote, so a malformed value is a bug on our side
 * and the right response is "no baseline" (which makes the kWh leg inert), never a throw.
 */
export function parseArmedContext(raw: unknown): AutomationArmedContext | null {
  if (!isObject(raw)) return null;
  if (raw.kind === "exercise") return parseExerciseArmedContext(raw);

  const out: ChargeArmedContext = {};
  if (typeof raw.baselineKwh === "number" && Number.isFinite(raw.baselineKwh))
    out.baselineKwh = raw.baselineKwh;
  if (typeof raw.baselineAt === "number" && Number.isFinite(raw.baselineAt))
    out.baselineAt = raw.baselineAt;
  return out.baselineKwh === undefined && out.baselineAt === undefined
    ? null
    : out;
}

function finite(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function parseExerciseArmedContext(
  raw: Record<string, unknown>,
): ExerciseArmedContext | null {
  const slotAt = finite(raw.slotAt);
  const at = finite(raw.at);
  // slotAt is the only load-bearing field — `isDue` compares against it. Without it the log entry
  // means nothing, so it degrades to "no decision on record" rather than a half-populated one.
  if (slotAt === null || at === null) return null;
  if (
    typeof raw.outcome !== "string" ||
    !(OUTCOMES as readonly string[]).includes(raw.outcome)
  )
    return null;

  const out: ExerciseArmedContext = {
    kind: "exercise",
    slotAt,
    at,
    outcome: raw.outcome as ExerciseOutcome,
  };
  if (typeof raw.reason === "string" && raw.reason !== "")
    out.reason = raw.reason;
  if (raw.final === true) out.final = true;

  if (isObject(raw.evidence)) {
    const minutes = finite(raw.evidence.minutes);
    const peakKw = finite(raw.evidence.peakKw);
    const endedAt = finite(raw.evidence.endedAt);
    if (minutes !== null && peakKw !== null && endedAt !== null)
      out.evidence = { minutes, peakKw, endedAt };
  }
  return out;
}

/**
 * Narrow a parsed armed context to the charge-session shape.
 *
 * The evaluator's charge path reads `baselineKwh`, which an exercise log entry does not have. This
 * is the one place that conversion happens, so the charge decision logic keeps a non-union input.
 */
export function chargeArmedContext(
  ctx: AutomationArmedContext | null,
): ChargeArmedContext | null {
  if (ctx === null) return null;
  return "kind" in ctx ? null : ctx;
}

/**
 * `mode: "once"` and an exercise trigger are two answers to the same question, so the pair is
 * refused rather than one of them silently winning.
 *
 * `mode` is a CHARGE-path concept — it decides whether a rule disarms for good after it fires
 * (`decide.ts`), and the exercise path never arms, so nothing has ever read it there. Under the
 * old weekday grammar that was merely inert. Under this one a one-off is expressible in the
 * schedule itself (a `start` with no `rrule`), and a rule saying "once" in one field and "every
 * Thursday" in another is exactly the confusion that made a rule NAMED "one-off Sat 12 Sep" fire
 * every week.
 */
export function refuseOnceExercise(
  mode: string,
  trigger: AutomationTrigger,
): string | null {
  if (mode !== "once" || trigger.kind !== "exercise") return null;
  return "mode must be 'standing' for an exercise trigger — a one-off exercise is a schedule with no rrule";
}
