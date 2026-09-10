/**
 * `automation` wire shapes, resolution and rendering — no I/O decisions, no `ctx`.
 *
 * The area/point/derivation resolvers are the `derivation` domain's (`../derivation/model`) rather
 * than copies: an exercise rule is defined against a run detector and its area's points, so it is
 * addressing exactly the same things by exactly the same refs, and two implementations of "which
 * point is `bidi.grid/power`" would eventually disagree.
 */
import { usage, resolveRef } from "../shared";
import type { ApiSession } from "@/lib/cli-kit/api-session";
import { Point } from "@/lib/ids";
import { resolvePoint, type WireArea } from "../derivation/model";

/** The seven weekday keys the API accepts, in week order. */
export const WEEKDAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const AREA_ARG = {
  name: "area",
  required: true,
  help: "The area: ar_… id, legacy handle, slug or name",
} as const;

export const AUTOMATION_ARG = {
  name: "automation",
  required: true,
  help: "The automation: au_… id or name",
} as const;

export interface WireSource {
  kind: "derivation" | "point";
  derivationId?: string;
  pointId?: string;
}

export interface WireTrigger {
  kind: "charge-session" | "exercise";
  source: WireSource;
  afterMinutes?: number;
  afterKwh?: number;
  schedule?: { weekdays: string[]; time: string; graceMinutes: number };
  unless?: {
    loadPointId: string;
    minMinutes: number;
    minLoadKw: number;
    dipToleranceSeconds: number;
    withinDays: number;
  };
}

export interface WireAction {
  kind: "point-action";
  pointId: string;
  action: "turn_off" | "set_value";
  value?: number;
}

export interface WireArmedContext {
  kind?: string;
  slotAt?: number;
  outcome?: string;
  at?: number;
  reason?: string;
  evidence?: { minutes: number; peakKw: number; endedAt: number };
  baselineKwh?: number;
  baselineAt?: number;
}

export interface WireAutomation {
  id: string;
  areaId: string;
  name: string;
  enabled: boolean;
  mode: string;
  /** Null when the stored row could not be parsed — it stays listable so it can be deleted. */
  trigger: WireTrigger | null;
  action: WireAction | null;
  armedAt: string | null;
  lastTriggeredAt: string | null;
  lastTriggeredRunStart: string | null;
  armedContext: WireArmedContext | null;
}

/** Resolve `<automation>` within an area: `au_` id, else name. */
export function resolveAutomation(
  rows: WireAutomation[],
  ref: string,
  area: WireArea,
): WireAutomation {
  return resolveRef(rows, ref, {
    noun: "automation",
    listCmd: `liveone automation list ${area.id}`,
  });
}

/** `thu` or `mon,thu` → the API's weekday array. Order and duplicates are the server's problem. */
export function parseWeekdays(raw: string): Weekday[] {
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== "");
  if (parts.length === 0)
    throw usage(
      "--weekdays is empty",
      "a schedule with no days never fires",
      `pass one or more of: ${WEEKDAYS.join(", ")}`,
    );
  for (const p of parts)
    if (!(WEEKDAYS as readonly string[]).includes(p))
      throw usage(
        `"${p}" is not a weekday`,
        "weekdays are the three-letter lower-case forms",
        `pass one or more of: ${WEEKDAYS.join(", ")}`,
      );
  return parts as Weekday[];
}

/** `09:00`, validated here so a typo fails before anything is resolved over the network. */
export function parseTime(raw: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw))
    throw usage(
      `"${raw}" is not a time`,
      "expected a 24-hour HH:MM wall-clock time in the AREA's timezone",
      "for example --time=09:00",
    );
  // 🛑 The server refuses this hour too; catching it here explains WHY rather than returning a 422.
  if (raw.startsWith("02:"))
    throw usage(
      `--time=${raw} is inside the daylight-saving gap hour`,
      "clocks jump from 02:00 to 03:00 on the spring-forward Sunday, so a 02:xx slot does not exist that day and the rule would silently skip it",
      "pick a time outside 02:00–02:59",
    );
  return raw;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const pad = (s: string, n: number) => s.padEnd(n);

/** One line per automation for `list`. */
export function automationLine(a: WireAutomation): string {
  return [
    pad(a.id, 30),
    pad(a.enabled ? "enabled" : "disabled", 9),
    pad(triggerWords(a.trigger), 34),
    a.name,
  ].join("  ");
}

/** A one-line summary of what a trigger does — the thing `list` is actually for. */
export function triggerWords(t: WireTrigger | null): string {
  if (!t) return "UNREADABLE";
  if (t.kind === "exercise") {
    const s = t.schedule;
    return s ? `exercise ${s.weekdays.join(",")} ${s.time}` : "exercise";
  }
  const legs = [
    t.afterMinutes !== undefined ? `${t.afterMinutes} min` : null,
    t.afterKwh !== undefined ? `${t.afterKwh} kWh` : null,
  ].filter(Boolean);
  return `stop after ${legs.join(" or ")}`;
}

/** What the action would do, in the units the operator typed. */
export function actionWords(a: WireAction | null): string {
  if (!a) return "UNREADABLE";
  return a.action === "set_value"
    ? `set ${a.pointId} = ${a.value}`
    : `turn off ${a.pointId}`;
}

/**
 * The last decision, for `show`.
 *
 * An exercise rule's `armedContext` is a decision LOG, not arming state, and it is the only place
 * the answer to "why didn't it run last Thursday" is written down — so `show` renders it in full.
 */
export function decisionLines(ctx: WireArmedContext | null): string[] {
  if (!ctx || ctx.kind !== "exercise") return [];
  const out = [
    `last decision:  ${ctx.outcome ?? "?"}` +
      (ctx.slotAt ? ` for the ${new Date(ctx.slotAt).toISOString()} slot` : ""),
  ];
  if (ctx.at) out.push(`  decided:      ${new Date(ctx.at).toISOString()}`);
  if (ctx.reason) out.push(`  because:      ${ctx.reason}`);
  if (ctx.evidence)
    out.push(
      `  evidence:     ${ctx.evidence.minutes.toFixed(1)} min under load, peak ` +
        `${ctx.evidence.peakKw.toFixed(2)} kW, ending ${new Date(ctx.evidence.endedAt).toISOString()}`,
    );
  return out;
}

// ---------------------------------------------------------------------------
// Point resolution
// ---------------------------------------------------------------------------

interface WireDevice {
  id: string | null;
  legacySystemId: number;
  name: string;
  slug: string | null;
}

interface DevicePoint {
  id: string;
  logicalPath: string | null;
  unit: string | null;
}

/**
 * Resolve a `--load-point`/`--action-point` value to a `pt_` id.
 *
 * Three accepted forms, and the third exists for a real reason rather than as a convenience:
 *   pt_…                      an id, passed through
 *   bidi.grid/power           a logical path on one of the AREA's member devices
 *   generator:load.hws/power  a logical path on a NAMED device, anywhere you can read
 *
 * 🛑 The qualified form is needed because only the DERIVATION is area-scoped by the API — the
 * action point merely has to be one you OWN. At Daylesford that is exactly the case: the run
 * detector lives on the `Daylesford Selectronic` area while the run-request point is on the
 * `Daylesford Generator` device, which is not a member of it. Without this form that rule is simply
 * not expressible except by pasting a raw id, which is the form that says nothing and is checked
 * against nothing.
 */
export async function resolvePointFlag(
  s: ApiSession,
  area: WireArea,
  ref: string,
  flag: string,
): Promise<string> {
  if (Point.is(ref)) return ref;

  const colon = ref.indexOf(":");
  if (colon === -1) return resolvePoint(s, area, ref, flag);

  const deviceRef = ref.slice(0, colon);
  const path = ref.slice(colon + 1);
  if (deviceRef === "" || path === "")
    throw usage(
      `"${ref}" for --${flag}`,
      "the device-qualified form is <device>:<logical-path>",
      "for example --" +
        flag +
        "=generator:source.generator.control.request/duration",
    );

  const { devices } = await s.get<{ devices: WireDevice[] }>("/api/v4/devices");
  const device = resolveRef(devices, deviceRef, {
    noun: "device",
    listCmd: "liveone device list",
  });
  const { points = [] } = await s.get<{ points?: DevicePoint[] }>(
    `/api/v4/devices/${encodeURIComponent(device.id!)}?include=points`,
  );
  const hits = points.filter((p) => p.logicalPath === path);

  if (hits.length === 0)
    throw usage(
      `${device.name} has no point with the logical path "${path}"`,
      `--${flag} named a device that exists, so it is the path that is wrong`,
      `run \`liveone device points ${device.id}\` for the paths it publishes`,
    );
  if (hits.length > 1)
    throw usage(
      `"${path}" is ambiguous on ${device.name}`,
      `it matches ${hits.length} points:\n${hits.map((h) => `  ${h.id}`).join("\n")}`,
      "address it by its pt_… id instead",
    );
  return hits[0].id;
}
