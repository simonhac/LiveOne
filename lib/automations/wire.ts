/**
 * Wire shapes for `/api/v4/automations` — TypeIDs on the wire, raw uuids inside.
 *
 * Per-field explicit translation (the `lib/derivations/v4-shapes.ts` pattern), never a "encode
 * anything uuid-shaped" sweep: the trigger's source uuid is a `dx_` in one branch and a `pt_` in
 * the other, and a generic sweep would mislabel one of them with the failure surfacing a long way
 * from here as a "point not found".
 */
import { Area, Automation, Derivation, Point } from "@/lib/ids";
import type {
  AutomationAction,
  AutomationArmedContext,
  AutomationRow,
  AutomationTrigger,
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
      schedule: { weekdays: string[]; time: string; graceMinutes: number };
      unless: {
        loadPointId: string; // pt_…
        minMinutes: number;
        minLoadKw: number;
        dipToleranceSeconds: number;
        withinDays: number;
      };
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
  /** Read-only on the wire; PR-G's "12.4 kWh so far" needs `baselineKwh`. */
  armedContext: AutomationArmedContext | null;
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

  if (t.kind === "exercise")
    return {
      kind: "exercise",
      source,
      schedule: t.schedule,
      // 🛑 `loadPointId` is the second uuid in this trigger and it is easy to miss: it lives under
      // `unless`, not `source`, so a sweep that only looked at `source` would ship a raw uuid.
      unless: { ...t.unless, loadPointId: Point.encode(t.unless.loadPointId) },
    };

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

/** Stored row → wire shape. `Date`s serialize to ISO via `NextResponse.json`. */
export function automationWire(row: AutomationRow): AutomationWire {
  return {
    id: Automation.encode(row.id),
    areaId: Area.encode(row.areaId),
    name: row.name,
    enabled: row.enabled,
    mode: row.mode,
    trigger: triggerWire(row.trigger),
    action: actionWire(row.action),
    armedAt: row.armedAt,
    lastTriggeredAt: row.lastTriggeredAt,
    lastTriggeredRunStart: row.lastTriggeredRunStart,
    armedContext: parseArmedContext(row.armedContext),
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

  return parseAutomationTrigger({
    ...t,
    source: decodedSource,
    unless: decodedUnless,
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
