/**
 * `automation` wire shapes, resolution and rendering — no I/O decisions, no `ctx`.
 *
 * The area and point resolvers are `../shared`'s, and the derivation resolvers are the `derivation`
 * domain's, rather than copies: an exercise rule is defined against a run detector and its area's
 * points, so it is addressing exactly the same things by exactly the same refs, and two
 * implementations of "which point is `bidi.grid/power`" would eventually disagree.
 *
 * 🛑 An automation stays AREA-SCOPED (`automations.area_id` is NOT NULL) even though a derivation no
 * longer is. That divergence is deliberate — an automation acts on a site, a derivation merely reads
 * points — which is why the area fan-out moved to `../shared` rather than being deleted with the
 * derivation domain's copy.
 */
import {
  pointInArea,
  pointOnDevice,
  resolveRef,
  usage,
  type WireArea,
} from "../shared";
import type { ApiSession } from "@/lib/cli-kit/api-session";
import { Point } from "@/lib/ids";
import {
  describe as describeSchedule,
  parseRRuleSubset,
} from "@/lib/automations/recurrence";
import type { ExerciseSchedule } from "@/lib/db/planetscale/schema";

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
  schedule?: ExerciseSchedule;
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
  final?: boolean;
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
  /** Next scheduled occurrence, epoch ms — exercise rules only; null when nothing is left. */
  nextAt: number | null;
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

/**
 * `2026-09-17 09:00` (or with a `T`) → the API's `"YYYY-MM-DDTHH:MM"`.
 *
 * Validated HERE, before anything is resolved over the network, so a typo costs nothing. The
 * server checks the same things again — this is a better error message, not the gate.
 */
export function parseStart(raw: string): string {
  const normalised = raw.trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(normalised))
    throw usage(
      `"${raw}" is not a start time`,
      "expected a local date and 24-hour time in the AREA's timezone",
      'for example --start="2026-09-17 09:00"',
    );
  // 🛑 The server refuses this hour too; catching it here explains WHY rather than returning a 422.
  if (normalised.slice(11, 13) === "02")
    throw usage(
      `--start=${raw} is inside the daylight-saving gap hour`,
      "clocks jump from 02:00 to 03:00 on the spring-forward Sunday, so a 02:xx slot does not exist that day and the rule would silently skip it",
      "pick a time outside 02:00–02:59",
    );
  return normalised;
}

/** `YYYY-MM-DD`, for `--until` and `skip --date`. */
export function parseDate(raw: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()))
    throw usage(
      `"${raw}" is not a date`,
      `--${flag} takes a calendar date`,
      `for example --${flag}=2026-12-31`,
    );
  return raw.trim();
}

/**
 * Assemble and validate the RRULE, folding the `--until`/`--count` sugar into it.
 *
 * The sugar exists because "every Thursday until Christmas" is the common shape and
 * `--rrule="FREQ=WEEKLY;BYDAY=TH;UNTIL=20261225"` is not how anyone says it. They are mutually
 * exclusive for the RFC's reason: a rule carrying two different endings has no sensible reading.
 * Returns undefined for a one-off — no rrule at all, which is the base case.
 */
export function buildRRule(opts: {
  rrule?: string;
  until?: string;
  count?: number;
}): string | undefined {
  if (opts.until !== undefined && opts.count !== undefined)
    throw usage(
      "--until and --count together",
      "a rule can have one ending, not two",
      "drop whichever of --until / --count you did not mean",
    );
  if (opts.rrule === undefined) {
    if (opts.until !== undefined || opts.count !== undefined)
      throw usage(
        "--until/--count without --rrule",
        "they bound a REPEAT, and with no --rrule this is a one-off that happens exactly once",
        "add --rrule, or drop --until/--count",
      );
    return undefined;
  }

  let text = opts.rrule;
  if (opts.until !== undefined)
    text += `;UNTIL=${opts.until.replace(/-/g, "")}`;
  if (opts.count !== undefined) text += `;COUNT=${opts.count}`;

  // The SAME validator the server uses, so "the CLI accepted it and the API refused it" cannot
  // happen — and the refusal arrives before the area and three points are resolved.
  const parsed = parseRRuleSubset(text);
  if (!parsed.ok)
    throw usage(
      parsed.error.replace("trigger.schedule.rrule", "--rrule"),
      "the recurrence grammar is an RFC 5545 subset",
      'for example --rrule="FREQ=WEEKLY;BYDAY=TH" or --rrule="FREQ=MONTHLY;BYDAY=1SA"',
    );
  return parsed.value;
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

/**
 * A one-line summary of what a trigger does — the thing `list` is actually for.
 *
 * Deliberately the RAW rule rather than `describe()`'s prose: a `list` column has ~34 characters,
 * and "every week on Thursday at 9 AM GMT+10" does not fit while `FREQ=WEEKLY;BYDAY=TH` does. The
 * prose belongs on `show`, which has a whole line for it.
 */
export function triggerWords(t: WireTrigger | null): string {
  if (!t) return "UNREADABLE";
  if (t.kind === "exercise") {
    const s = t.schedule;
    if (!s) return "exercise";
    return `exercise ${s.start} ${s.rrule ?? "(once)"}`;
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

/** The schedule in words, plus what it excludes — the `show` rendering. */
export function scheduleLines(
  schedule: ExerciseSchedule,
  timezone: string,
  nextAt: number | null,
): string[] {
  const out = [
    `  schedule:     ${describeSchedule(schedule, timezone)}`,
    `  starting:     ${schedule.start} (${timezone})`,
    `  next:         ${nextAt === null ? "never — the schedule has no occurrences left" : new Date(nextAt).toISOString()}`,
  ];
  if (schedule.exdates?.length)
    out.push(`  skipping:     ${schedule.exdates.join(", ")}`);
  if (schedule.rdates?.length)
    out.push(`  also:         ${schedule.rdates.join(", ")}`);
  return out;
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
  if (ctx.final)
    out.push(
      "  and:          that was its LAST slot, so the rule was disabled",
    );
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
  if (colon === -1) return pointInArea(s, area, ref, flag);

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
  return pointOnDevice(s, device, path, flag);
}
