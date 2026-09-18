/**
 * Wire shapes for `/api/v4/automations` — TypeIDs on the wire, raw uuids inside.
 *
 * Per-field explicit translation (the `lib/derivations/v4-shapes.ts` pattern), never a "encode
 * anything uuid-shaped" sweep: the trigger's source uuid is a `dx_` in one branch and a `pt_` in
 * the other, and a generic sweep would mislabel one of them with the failure surfacing a long way
 * from here as a "point not found".
 */
import { Area, Automation, Derivation, Point } from "@/lib/ids";
import { nextOccurrence } from "./recurrence";
import type {
  AutomationAction,
  AutomationArmedContext,
  AutomationRow,
  AutomationTrigger,
  ExerciseSchedule,
} from "@/lib/db/planetscale/schema";
import {
  parseAutomationAction,
  parseAutomationTrigger,
  parseArmedContext,
  type ParseOutcome,
} from "./types";

/** Trigger source with its uuid already encoded. */
type WireSource =
  | { kind: "derivation"; derivationId: string } // dx_…
  | { kind: "point"; pointId: string }; // pt_…

type WireTrigger =
  | {
      kind: "charge-session";
      source: WireSource;
      afterMinutes?: number;
      afterKwh?: number;
    }
  | {
      kind: "exercise";
      source: WireSource;
      schedule: ExerciseSchedule;
      /** Absent = unconditional: the rule runs whenever it is due. */
      unless?: {
        loadPointId: string; // pt_…
        minMinutes: number;
        minLoadKw: number;
        dipToleranceSeconds: number;
        withinDays: number;
      };
      require?: {
        socPointId: string; // pt_…
        maxSocPercent: number;
      };
      supervise?: { settleMinutes: number; sustainMinutes: number };
    };

type WireAction = {
  kind: "point-action";
  pointId: string; // pt_…
} & ({ action: "turn_off" } | { action: "set_value"; value: number });

export interface AutomationWire {
  id: string; // au_…
  areaId: string; // ar_…
  name: string;
  enabled: boolean;
  mode: string;
  trigger: WireTrigger | null;
  action: WireAction | null;
  armedAt: Date | null;
  lastTriggeredAt: Date | null;
  lastTriggeredRunStart: Date | null;
  /**
   * When the rule was written.
   *
   * On the wire because `isDue` already reads it: a slot EARLIER than this is "predates-rule", not
   * a miss, and without the column an operator looking at a `missed` decision cannot tell whether
   * the rule was simply blamed for a week it did not exist for.
   */
  createdAt: Date;
  /** Read-only on the wire; PR-G's "12.4 kWh so far" needs `baselineKwh`. */
  armedContext: AutomationArmedContext | null;
  /**
   * The next scheduled occurrence, epoch ms — exercise rules only, and only when the caller
   * supplied the area's timezone.
   *
   * DERIVED, never stored: it is a pure function of the schedule and the zone, and a stored copy
   * would be a second answer to the same question that goes stale the moment either changes. Null
   * means "no more occurrences" (a spent one-off, a finished COUNT/UNTIL) as well as "not an
   * exercise rule" — both are "nothing further is scheduled", which is what a reader wants.
   */
  nextAt: number | null;
}

function triggerWire(raw: unknown): AutomationWire["trigger"] {
  const parsed = parseAutomationTrigger(raw);
  // A row we cannot parse is served with its trigger NULLED rather than guessed at — it stays
  // listable (so it can be seen and deleted) but nothing claims to know what it means.
  if (!parsed.ok) return null;
  const t = parsed.value;
  const source: WireSource =
    t.source.kind === "derivation"
      ? {
          kind: "derivation",
          derivationId: Derivation.encode(t.source.derivationId),
        }
      : { kind: "point", pointId: Point.encode(t.source.pointId) };

  if (t.kind === "exercise") {
    // 🛑 Up to THREE uuids live in this trigger, not one, and only the first is under `source`:
    // `unless.loadPointId` and `require.socPointId` are both easy to miss. Missing the second
    // shipped a raw uuid; missing the third made the whole `require` block un-settable through the
    // API — the decoder left `pt_…` in place and the parser, which is entitled to assume raw
    // uuids, rejected it with a 422 that named nothing. `unless` is optional, so its key is OMITTED
    // rather than serialised as `undefined` — the wire says "no skip condition", not "one I could
    // not encode".
    const out: WireTrigger = {
      kind: "exercise",
      source,
      schedule: t.schedule,
    };
    if (t.unless)
      out.unless = {
        ...t.unless,
        loadPointId: Point.encode(t.unless.loadPointId),
      };
    if (t.require)
      out.require = {
        ...t.require,
        socPointId: Point.encode(t.require.socPointId),
      };
    if (t.supervise) out.supervise = t.supervise;
    return out;
  }

  const out: WireTrigger = { kind: "charge-session", source };
  if (t.afterMinutes !== undefined) out.afterMinutes = t.afterMinutes;
  if (t.afterKwh !== undefined) out.afterKwh = t.afterKwh;
  return out;
}

function actionWire(raw: unknown): AutomationWire["action"] {
  const parsed = parseAutomationAction(raw);
  if (!parsed.ok) return null;
  const a = parsed.value;
  const pointId = Point.encode(a.pointId);
  return a.action === "set_value"
    ? { kind: "point-action", pointId, action: "set_value", value: a.value }
    : { kind: "point-action", pointId, action: "turn_off" };
}

/**
 * Stored row → wire shape. `Date`s serialize to ISO via `NextResponse.json`.
 *
 * `at` is optional because the schedule's zone lives on the AREA, not on the row, and not every
 * caller has loaded it. Without it the shape is unchanged except that `nextAt` is null — a missing
 * zone must not be reported as a missing schedule. `nowMs` is passed rather than read so this
 * stays a pure function of its arguments, the `decide.ts` discipline.
 */
export function automationWire(
  row: AutomationRow,
  at?: { timezone: string; nowMs: number },
): AutomationWire {
  const trigger = triggerWire(row.trigger);
  return {
    id: Automation.encode(row.id),
    areaId: Area.encode(row.areaId),
    name: row.name,
    enabled: row.enabled,
    mode: row.mode,
    trigger,
    action: actionWire(row.action),
    armedAt: row.armedAt,
    lastTriggeredAt: row.lastTriggeredAt,
    lastTriggeredRunStart: row.lastTriggeredRunStart,
    createdAt: row.createdAt,
    armedContext: parseArmedContext(row.armedContext),
    nextAt:
      at !== undefined && trigger?.kind === "exercise"
        ? (nextOccurrence(trigger.schedule, at.timezone, at.nowMs)?.atMs ??
          null)
        : null,
  };
}

/** Wire body → STORED form. A malformed `dx_`/`pt_` is a parse failure, never a silent null. */
export function triggerFromWire(raw: unknown): ParseOutcome<AutomationTrigger> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "trigger must be an object" };
  const t = raw as Record<string, unknown>;
  const src = t.source;
  let decodedSource: unknown = src;
  if (typeof src === "object" && src !== null && !Array.isArray(src)) {
    const s = src as Record<string, unknown>;
    if (s.kind === "derivation") {
      const uuid =
        typeof s.derivationId === "string"
          ? Derivation.toUuidOrNull(s.derivationId)
          : null;
      if (!uuid)
        return {
          ok: false,
          error: "trigger.source.derivationId must be a dx_ derivation id",
        };
      decodedSource = { kind: "derivation", derivationId: uuid };
    } else if (s.kind === "point") {
      const uuid =
        typeof s.pointId === "string" ? Point.toUuidOrNull(s.pointId) : null;
      if (!uuid)
        return {
          ok: false,
          error: "trigger.source.pointId must be a pt_ point id",
        };
      decodedSource = { kind: "point", pointId: uuid };
    }
  }
  // The exercise trigger carries a SECOND point id, under `unless`. Decoded here rather than in
  // `types.ts` for the same reason as `source`: TypeID translation is this module's job, and
  // `parseAutomationTrigger` is entitled to assume every id it sees is already a raw uuid.
  let decodedUnless: unknown = t.unless;
  if (
    typeof t.unless === "object" &&
    t.unless !== null &&
    !Array.isArray(t.unless)
  ) {
    const u = t.unless as Record<string, unknown>;
    if (u.loadPointId !== undefined) {
      const uuid =
        typeof u.loadPointId === "string"
          ? Point.toUuidOrNull(u.loadPointId)
          : null;
      if (!uuid)
        return {
          ok: false,
          error: "trigger.unless.loadPointId must be a pt_ point id",
        };
      decodedUnless = { ...u, loadPointId: uuid };
    }
  }

  let decodedRequire: unknown = t.require;
  if (
    typeof t.require === "object" &&
    t.require !== null &&
    !Array.isArray(t.require)
  ) {
    const r = t.require as Record<string, unknown>;
    if (r.socPointId !== undefined) {
      const uuid =
        typeof r.socPointId === "string"
          ? Point.toUuidOrNull(r.socPointId)
          : null;
      if (!uuid)
        return {
          ok: false,
          error: "trigger.require.socPointId must be a pt_ point id",
        };
      decodedRequire = { ...r, socPointId: uuid };
    }
  }

  return parseAutomationTrigger({
    ...t,
    source: decodedSource,
    ...(decodedUnless !== undefined ? { unless: decodedUnless } : {}),
    ...(decodedRequire !== undefined ? { require: decodedRequire } : {}),
  });
}

/** Wire body → STORED form for the action. */
export function actionFromWire(raw: unknown): ParseOutcome<AutomationAction> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "action must be an object" };
  const a = raw as Record<string, unknown>;
  let pointId: unknown = a.pointId;
  if (typeof pointId === "string") {
    const uuid = Point.toUuidOrNull(pointId);
    if (!uuid)
      return { ok: false, error: "action.pointId must be a pt_ point id" };
    pointId = uuid;
  }
  return parseAutomationAction({ ...a, pointId });
}
