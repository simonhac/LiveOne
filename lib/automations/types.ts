/**
 * Runtime parsing of the closed v1 automation vocabulary.
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
import type {
  AutomationAction,
  AutomationArmedContext,
  AutomationTrigger,
  AutomationTriggerSource,
} from "@/lib/db/planetscale/schema";

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
    if (typeof raw.derivationId !== "string" || !isCanonicalUuid(raw.derivationId))
      return fail("trigger.source.derivationId must be a derivation id");
    return { ok: true, value: { kind: "derivation", derivationId: raw.derivationId } };
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
  if (raw.kind !== "charge-session")
    return fail("trigger.kind must be 'charge-session'");

  const source = parseSource(raw.source);
  if (!source.ok) return fail(source.error);

  const minutes = parseThreshold(raw.afterMinutes, "trigger.afterMinutes");
  if (!minutes.ok) return fail(minutes.error);
  const kwh = parseThreshold(raw.afterKwh, "trigger.afterKwh");
  if (!kwh.ok) return fail(kwh.error);
  if (minutes.value === undefined && kwh.value === undefined)
    return fail("trigger must set at least one of afterMinutes, afterKwh");

  const value: AutomationTrigger = {
    kind: "charge-session",
    source: source.value,
  };
  if (minutes.value !== undefined) value.afterMinutes = minutes.value;
  if (kwh.value !== undefined) value.afterKwh = kwh.value;
  return { ok: true, value };
}

/**
 * Validate an already-uuid-decoded action. The v1 action set is CLOSED — `turn_on`/`set_value`
 * are a later PR's decision, not something a body may smuggle in.
 */
export function parseAutomationAction(
  raw: unknown,
): ParseOutcome<AutomationAction> {
  if (!isObject(raw)) return fail("action must be an object");
  if (raw.kind !== "point-action")
    return fail("action.kind must be 'point-action'");
  if (typeof raw.pointId !== "string" || !isCanonicalUuid(raw.pointId))
    return fail("action.pointId must be a point id");
  if (raw.action !== "turn_off")
    return fail("action.action must be 'turn_off' (the v1 action set is closed)");
  return {
    ok: true,
    value: { kind: "point-action", pointId: raw.pointId, action: "turn_off" },
  };
}

/**
 * Tolerant reader for `armed_context` — state WE wrote, so a malformed value is a bug on our side
 * and the right response is "no baseline" (which makes the kWh leg inert), never a throw.
 */
export function parseArmedContext(raw: unknown): AutomationArmedContext | null {
  if (!isObject(raw)) return null;
  const out: AutomationArmedContext = {};
  if (typeof raw.baselineKwh === "number" && Number.isFinite(raw.baselineKwh))
    out.baselineKwh = raw.baselineKwh;
  if (typeof raw.baselineAt === "number" && Number.isFinite(raw.baselineAt))
    out.baselineAt = raw.baselineAt;
  return out.baselineKwh === undefined && out.baselineAt === undefined
    ? null
    : out;
}
