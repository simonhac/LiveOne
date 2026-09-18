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
import { kebab } from "@/lib/cli/cli";
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
  /**
   * Both optional, CHILDREN INCLUDED: an origin older than these blocks omits the block, and a
   * newer one could add a field this build does not know. Rendering falls back rather than printing
   * `undefined` into an operator's terminal.
   */
  require?: { socPointId?: string; maxSocPercent?: number };
  supervise?: { settleMinutes?: number; sustainMinutes?: number };
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
  runsConsidered?: number;
  runsExcluded?: number;
  socPercent?: number;
  abortedAt?: number;
  ticks?: number;
  firstSeenAt?: number;
  baselineKwh?: number;
  baselineAt?: number;
}

export interface WireAutomation {
  id: string;
  areaId: string;
  name: string;
  enabled: boolean;
  mode: string;
  /** Optional: an origin older than the field simply omits it. */
  createdAt?: string;
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

/**
 * The `unless` block for `create-exercise`, or undefined when the rule is unconditional.
 *
 * 🛑 `unless` used to be REQUIRED by the API, so a one-off "run it for 10 minutes on Thursday" had
 * no way to say "and skip it for nothing" — the only way through was a threshold chosen to be
 * unreachable (`--min-minutes=600`). That number is not inert: the area's calendar feed renders it
 * verbatim, so subscribers were told the run would be "Skipped if it has already run for 600
 * minutes or more above 1.5 kW in the previous 7 days", describing a condition nothing could meet.
 *
 * Omitting `--load-point` now says it properly. What that costs is a STANDING rule with no load
 * point exercising the engine on every occurrence regardless — so the caller prints the absence in
 * as many words rather than leaving it as a missing line.
 *
 * Pure, and validated before anything is resolved over the network: a stray flag costs nothing.
 */
export function buildUnless(
  loadPointRef: string | undefined,
  knobs: {
    minMinutes?: number;
    minLoadKw?: number;
    dipSeconds?: number;
    withinDays?: number;
  },
): Record<string, unknown> | undefined {
  const named = (
    ["minMinutes", "minLoadKw", "dipSeconds", "withinDays"] as const
  ).filter((k) => knobs[k] !== undefined);

  if (loadPointRef === undefined) {
    // Refused, not silently dropped. A `--min-minutes=30` that vanished would leave the operator
    // believing they had configured a bar the rule does not have — and it is the shape they would
    // most plausibly reach for while trying to write the old unreachable-threshold trick.
    if (named.length)
      throw usage(
        named.map((k) => `--${kebab(k)}`).join(", "),
        "these tune the skip condition, and without --load-point there is no skip condition",
        "pass --load-point to give the rule something to measure, or drop these flags to make it unconditional",
      );
    return undefined;
  }

  // Sparse by contract: an omitted knob inherits the server's default and keeps inheriting it as
  // those defaults evolve. Pinning a value you did not choose is worse than omitting it.
  // `loadPointId` carries the REF here — whatever the operator typed. The caller overwrites it with
  // the resolved `pt_` id once the area is known; building it now is what lets the refusal above
  // happen before any network work, the same reason `parseStart` and `buildRRule` are called early.
  const unless: Record<string, unknown> = { loadPointId: loadPointRef };
  if (knobs.minMinutes !== undefined) unless.minMinutes = knobs.minMinutes;
  if (knobs.minLoadKw !== undefined) unless.minLoadKw = knobs.minLoadKw;
  if (knobs.dipSeconds !== undefined)
    unless.dipToleranceSeconds = knobs.dipSeconds;
  if (knobs.withinDays !== undefined) unless.withinDays = knobs.withinDays;
  return unless;
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
/**
 * The rule's SOURCE in words — the detector or point it is triggered BY.
 *
 * Deliberately not folded into `triggerWords`, which is a width-constrained `list` column. `show`
 * prints it on its own line: an exercise rule names three ids (source, load point, action point)
 * and until now printed only two, so "which detector is this rule actually watching" had no answer
 * short of reading the JSON.
 */
export function sourceWords(t: WireTrigger | null): string | null {
  const src = (
    t as {
      source?: { kind?: string; derivationId?: string; pointId?: string };
    } | null
  )?.source;
  if (!src) return null;
  if (src.kind === "derivation" && src.derivationId)
    return `derivation ${src.derivationId}`;
  if (src.kind === "point" && src.pointId) return `point ${src.pointId}`;
  return null;
}

/** The charge-session arming state — the baseline a kWh limit measures its delta from. */
function chargeContextLines(ctx: WireArmedContext): string[] {
  const c = ctx as { baselineKwh?: number; baselineAt?: number };
  if (c.baselineKwh === undefined && c.baselineAt === undefined) return [];
  const out = ["armed context:"];
  if (c.baselineKwh !== undefined)
    out.push(`  baseline:     ${c.baselineKwh.toFixed(2)} kWh`);
  if (c.baselineAt !== undefined)
    out.push(`  snapshotted:  ${new Date(c.baselineAt).toISOString()}`);
  return out;
}

function exerciseDecisionLines(ctx: WireArmedContext): string[] {
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
  if (ctx.runsConsidered !== undefined || ctx.runsExcluded !== undefined)
    out.push(
      `  runs weighed: ${ctx.runsConsidered ?? "?"} (${ctx.runsExcluded ?? 0} discounted as our own)`,
    );
  if (ctx.socPercent !== undefined)
    out.push(`  battery:      ${ctx.socPercent.toFixed(1)}%`);
  // 🛑 The line that answers "was it even LOOKED at?". A slot seen due 180 times with no dispatch
  // is a very different failure from one nobody evaluated, and until these counters existed the
  // two were indistinguishable on the record — which is what made the 2026-09-12 miss opaque.
  if (ctx.ticks !== undefined)
    out.push(
      `  seen due:     ${ctx.ticks} tick(s)` +
        (ctx.firstSeenAt
          ? ` since ${new Date(ctx.firstSeenAt).toISOString()}`
          : ""),
    );
  if (ctx.abortedAt)
    out.push(
      `  stopped at:   ${new Date(ctx.abortedAt).toISOString()} (supervision)`,
    );
  return out;
}

/** Dispatches on the context kind — the two rule families keep different state. */
export function decisionLines(ctx: WireArmedContext | null): string[] {
  if (!ctx) return [];
  return ctx.kind === "exercise"
    ? exerciseDecisionLines(ctx)
    : chargeContextLines(ctx);
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

// ── `automation check` ───────────────────────────────────────────────────────────────────────────

/**
 * The dry-evaluation payload.
 *
 * EVERY field optional, per the `queue status` rule: this CLI talks to a DEPLOYED origin that may
 * predate any of them, and an operator reaching for this verb is usually mid-incident. It degrades
 * to a stated sentence, never a TypeError.
 */
export interface WireEvaluation {
  automationId?: string;
  timezone?: string;
  evaluatedAt?: string;
  enabled?: boolean;
  kind?: string;
  supported?: boolean;
  detail?: string;
  source?: { derivationId?: string | null; resolved?: boolean };
  slot?: { at?: string };
  next?: { at?: string } | null;
  due?: { due?: boolean; reason?: string };
  openRun?: boolean;
  exhausted?: boolean;
  /**
   * `null` = the rule has no skip condition and runs whenever it is due. `undefined` = the origin
   * did not say, which is a different thing and is rendered as such.
   */
  unless?: {
    minMinutes?: number;
    minLoadKw?: number;
    withinDays?: number;
    loadPoint?: { id?: string; transformApplied?: boolean };
    best?: { minutes?: number; peakKw?: number; endedAt?: string } | null;
    satisfied?: boolean;
    runsConsidered?: number;
    runsExcluded?: number;
  } | null;
  require?: {
    socPercent?: number | null;
    maxSocPercent?: number;
    ready?: boolean;
  } | null;
  supervise?: { settleMinutes?: number; sustainMinutes?: number } | null;
  decision?: { kind?: string; outcome?: string | null; reason?: string | null };
  wouldDispatch?: { pointId?: string; value?: number | null } | null;
  blockers?: { code?: string; detail?: string }[];
}

const num = (v: number | null | undefined, dp = 1) =>
  typeof v === "number" ? v.toFixed(dp) : "?";

/**
 * Is this a verdict an operator should look at? Drives the exit code, so it composes into a check.
 *
 * `satisfied`, `waiting` and a dealt-with slot are the design working; `missed` and an unresolved
 * reference are not.
 */
export function evaluationHasFindings(e: WireEvaluation): boolean {
  if (e.enabled === false) return true;
  if (e.blockers && e.blockers.length > 0) return true;
  if (e.source && e.source.resolved === false) return true;
  const outcome = e.decision?.outcome;
  if (outcome === "missed" || outcome === "missed-running") return true;
  // 🛑 An UNREADABLE answer is a finding, not a pass. `{}` — an origin that predates the route, a
  // truncated body — would otherwise render "enabled: yes / would dispatch: nothing" and exit 0,
  // turning missing information into affirmative information. A rule the server declined to
  // evaluate (`supported: false`) is the one exception: that is a known, stated limitation.
  if (e.supported === false) return false;
  return e.decision === undefined && e.due === undefined;
}

/** Pure renderer, so it is asserted against fixtures rather than against a network. */
export function renderEvaluation(e: WireEvaluation): string {
  const out: string[] = [];
  if (e.supported === false)
    return `${e.kind ?? "this"} rule: ${e.detail ?? "dry evaluation is not implemented for it"}`;

  out.push(`evaluated:      ${e.evaluatedAt ?? "?"}`);
  out.push(
    `enabled:        ${e.enabled === undefined ? "?" : e.enabled ? "yes" : "NO"}`,
  );
  if (e.decision === undefined && e.due === undefined)
    out.push(
      "🛑 this origin returned no verdict — it may predate the evaluation route; treat as UNKNOWN, not healthy",
    );
  if (e.source?.derivationId)
    out.push(
      `detector:       ${e.source.derivationId}${e.source.resolved === false ? "  🛑 does not resolve to an enabled run detector" : ""}`,
    );
  if (e.slot?.at)
    out.push(
      `this slot:      ${e.slot.at}${
        e.due?.due === false ? ` — not due (${e.due.reason ?? "?"})` : ""
      }`,
    );
  if (e.next?.at) out.push(`next slot:      ${e.next.at}`);

  const u = e.unless;
  // 🛑 Three states, not two: a block, an explicit `null` (unconditional), and absent (the origin
  // said nothing). Only the middle one is a statement about the rule, and it is the one an operator
  // most needs spelled out — a missing "unless:" line reads as an omission, not as a policy.
  if (u === null)
    out.push(
      "unless:         none — this rule runs on EVERY occurrence, whatever the engine has done",
    );
  else if (u) {
    out.push(
      `unless:         it ran ≥ ${num(u.minMinutes, 0)} min above ${num(u.minLoadKw)} kW in the last ${num(u.withinDays, 0)} days`,
    );
    out.push(
      u.best
        ? `  answer now:   ${u.satisfied ? "YES" : "NO"} — best stretch ${num(u.best.minutes)} min, peak ${num(u.best.peakKw)} kW, ended ${u.best.endedAt ?? "?"}`
        : `  answer now:   NO — no loaded stretch found`,
    );
    out.push(
      `  runs weighed: ${u.runsConsidered ?? "?"} (${u.runsExcluded ?? 0} discounted as our own)`,
    );
    if (u.loadPoint?.transformApplied === false)
      out.push(
        `  read from:    ${u.loadPoint.id ?? "?"} RAW — no transform applied on this path`,
      );
  }

  if (e.require)
    out.push(
      `readiness:      battery ${num(e.require.socPercent)}% vs gate ${num(e.require.maxSocPercent, 0)}% — ${e.require.ready ? "ready" : "TOO FULL to load the engine"}`,
    );
  if (e.supervise)
    out.push(
      `supervision:    stop if under the floor for ${num(e.supervise.sustainMinutes, 0)} min, from minute ${num(e.supervise.settleMinutes, 0)}`,
    );
  if (e.openRun) out.push(`open run:       yes — a run is in progress now`);

  const d = e.decision;
  if (d)
    out.push(
      `decision:       ${d.outcome ?? d.kind ?? "?"}${d.reason ? ` — ${d.reason}` : ""}`,
    );
  out.push(
    `would dispatch: ${
      e.wouldDispatch
        ? `set ${e.wouldDispatch.pointId ?? "?"} = ${e.wouldDispatch.value ?? "?"}`
        : "nothing"
    }`,
  );
  for (const b of e.blockers ?? [])
    out.push(`🛑 ${b.code ?? "blocked"}: ${b.detail ?? ""}`);
  return out.join("\n");
}

// ── `automation health` ──────────────────────────────────────────────────────────────────────────

/** Duplicated on purpose — this CLI judges a DEPLOYED origin and must not inherit a local constant. */
const STALE_SWEEP_SEC = 300;

export interface WireEvaluator {
  cronsEnabled?: boolean;
  schedule?: string;
  lastSweep?: {
    at?: string;
    ageSeconds?: number;
    durationMs?: number;
    summary?: {
      evaluated?: number;
      errors?: number;
      exercise?: {
        due?: number;
        fired?: number;
        satisfied?: number;
        waiting?: number;
        missed?: number;
        skipped?: number;
        aborted?: number;
        lostClaim?: number;
      };
    };
  } | null;
  undecidedAlertSuppressedUntil?: string | null;
  counts?: { enabled?: number; exercise?: number; chargeSession?: number };
}

export type EvaluatorState =
  | "DISABLED"
  | "SILENT"
  | "ERRORS"
  | "UNDECIDED"
  | "UNKNOWN"
  | "ok";

/**
 * One word, most alarming first — the `laneState` pattern from `queue status`.
 *
 * 🛑 `DISABLED` outranks `SILENT` for the same reason `error` outranks `idle` there: "the kill
 * switch is off" and "the cron is broken" send an operator to completely different places, and
 * collapsing them sends them to the wrong one.
 */
export function evaluatorState(e: WireEvaluator): EvaluatorState {
  if (e.cronsEnabled === false) return "DISABLED";
  const age = e.lastSweep?.ageSeconds;
  if (!e.lastSweep || age === undefined || age > STALE_SWEEP_SEC)
    return "SILENT";
  const s = e.lastSweep.summary;
  // A fresh sweep with no summary proves the cron RAN and nothing else. Calling that `ok` would
  // claim error-free evaluation from a payload that cannot establish it.
  if (!s) return "UNKNOWN";
  if ((s.errors ?? 0) > 0) return "ERRORS";
  const x = s.exercise;
  if (x) {
    const decided =
      (x.fired ?? 0) +
      (x.satisfied ?? 0) +
      (x.waiting ?? 0) +
      (x.missed ?? 0) +
      (x.skipped ?? 0) +
      (x.lostClaim ?? 0);
    if ((x.due ?? 0) > decided) return "UNDECIDED";
  }
  return "ok";
}

export function renderHealth(e: WireEvaluator): string {
  const state = evaluatorState(e);
  const out = [`evaluator:      ${state}`];
  out.push(
    `crons enabled:  ${e.cronsEnabled === undefined ? "?" : e.cronsEnabled ? "yes" : "NO — the kill switch is off"}`,
  );
  out.push(`schedule:       ${e.schedule ?? "?"}`);
  if (e.lastSweep)
    out.push(
      `last sweep:     ${e.lastSweep.at ?? "?"} (${e.lastSweep.ageSeconds ?? "?"}s ago, took ${e.lastSweep.durationMs ?? "?"}ms)`,
    );
  else
    // The one honest ambiguity, stated rather than guessed at.
    out.push(
      "last sweep:     none recorded — either the evaluator has not run since this deploy, or it is not running",
    );

  const x = e.lastSweep?.summary?.exercise;
  if (x)
    out.push(
      `exercise slots: due ${x.due ?? 0} · fired ${x.fired ?? 0} · satisfied ${x.satisfied ?? 0} · ` +
        `waiting ${x.waiting ?? 0} · missed ${x.missed ?? 0} · skipped ${x.skipped ?? 0} · ` +
        `aborted ${x.aborted ?? 0} · lost ${x.lostClaim ?? 0}`,
    );
  if (e.lastSweep?.summary?.errors)
    out.push(`errors:         ${e.lastSweep.summary.errors} last sweep`);
  if (e.counts)
    out.push(
      `enabled rules:  ${e.counts.enabled ?? "?"} (${e.counts.exercise ?? "?"} exercise, ${e.counts.chargeSession ?? "?"} charge-session)`,
    );
  if (e.undecidedAlertSuppressedUntil)
    out.push(
      `🔕 the undecided-slot alert is suppressed until ${e.undecidedAlertSuppressedUntil} — Slack being quiet does not mean healthy`,
    );
  return out.join("\n");
}

// ── `automation commands` ────────────────────────────────────────────────────────────────────────

/** A pending command we cannot time is treated as STALE — an unreadable age is not a young age. */
export function pendingIsStale(
  c: { status?: string; requestedAt?: string },
  nowMs: number,
): boolean {
  if (c.status !== "pending") return false;
  const at = Date.parse(c.requestedAt ?? "");
  return Number.isNaN(at) || nowMs - at > 120_000;
}

export interface WireCommand {
  action?: string;
  value?: number | null;
  status?: string;
  reason?: string | null;
  error?: string | null;
  requestedAt?: string;
  completedAt?: string | null;
  requestedBy?:
    | { kind: "user" }
    | { kind: "automation"; automationId?: string; name?: string | null };
}

/** One audit row as a line. Deliberately plain — the sentence-building lives server-side. */
export function commandLine(c: WireCommand): string {
  const who =
    c.requestedBy?.kind === "automation"
      ? (c.requestedBy.name ?? c.requestedBy.automationId ?? "an automation")
      : "a person";
  const what =
    c.action === "set_value"
      ? c.value === 0
        ? "stop (set 0)"
        : `run ${c.value ?? "?"} min`
      : (c.action ?? "?");
  const tail = c.error ? ` — ${c.error}` : c.reason ? ` — ${c.reason}` : "";
  return `${c.requestedAt ?? "?"}  ${(c.status ?? "?").padEnd(9)} ${what.padEnd(14)} by ${who}${tail}`;
}
