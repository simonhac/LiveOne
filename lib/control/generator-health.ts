/**
 * What is wrong with a generator, as a list — the tile's issues chip and the monitor's alerts read
 * the SAME list, so the dashboard and Slack cannot disagree about whether something is broken.
 *
 * Pure: the server gathers the inputs (`lib/control/generator-health-server.ts`), this decides.
 *
 * 🛑 WHY THIS EXISTS. Between 15 and 22 October 2026 the Daylesford generator's starter battery lost
 * its charger, collapsed from 12.7 V to 3.6 V, and took the controller's power with it; the hub's
 * control tunnel died too; and the Thursday exercise then failed 181 dispatches and was written off as
 * "grace expired". The tile showed "Auto · Ready to start" and a single red "!" — which was itself a
 * month-old, unrelated error. Every fact below was on record somewhere; none of it reached the screen.
 */
import {
  batteryLevel,
  controlErrorIsRecent,
  controllerIsOffline,
  entryMs,
  firstPresentPath,
  GENERATOR_BATTERY_PATHS,
  GENERATOR_ERROR_PATH,
  GENERATOR_RPM_PATHS,
  lastControllerReadingMs,
  type LatestWithTimes,
} from "./generator-ref";
import type { ExerciseArmedContext } from "@/lib/db/planetscale/schema";

export type GeneratorIssueCode =
  | "controller_offline"
  | "battery_flat"
  | "battery_low"
  | "exercise_failing"
  | "exercise_missed"
  | "command_failed"
  | "control_error";

export interface GeneratorIssue {
  code: GeneratorIssueCode;
  /** `critical` = the generator will not do what the site relies on it for; `warning` = it may not. */
  severity: "critical" | "warning";
  /** Short — it stands in for "Ready to start" under the hero when it is the worst issue. */
  title: string;
  /** The evidence, in a sentence: what, since when, and why we think so. */
  detail: string | null;
  /** When the condition began (or was last observed), epoch ms. */
  sinceMs: number | null;
}

/** The wire shape of `GET /api/v4/areas/{id}/generator-health`. */
export interface GeneratorHealth {
  /** False when the area has no generator at all — the caller shows nothing, not "healthy". */
  hasGenerator: boolean;
  issues: GeneratorIssue[];
}

/** One exercise rule, as much as the health check needs of it. */
export interface ExerciseRuleState {
  name: string;
  enabled: boolean;
  context: ExerciseArmedContext | null;
}

/** The newest command on the generator's control point. */
export interface LastCommand {
  status: string;
  error: string | null;
  requestedAtMs: number;
  /** An automation's failures are reported through its own rule (`exercise_*`), not twice. */
  byAutomation: boolean;
}

export interface GeneratorHealthInput {
  nowMs: number;
  /** The area's zone — every instant in a detail line is spelled in it. */
  timezone: string;
  latest: LatestWithTimes;
  /** Null when the caller may not see automations (a non-owner): no opinion, not "all fine". */
  exercises: ExerciseRuleState[] | null;
  lastCommand: LastCommand | null;
}

/**
 * A `waiting` decision is a slot still being worked on. Only call it failing once it has been
 * retried for a while — one declined tick is the hub saying "a run is already in progress", which is
 * the evaluator working as designed.
 */
const FAILING_AFTER_TICKS = 5;
/** A `waiting` record older than this is not a live retry loop any more (the evaluator moved on). */
const WAITING_FRESH_MS = 15 * 60_000;
/** How long a missed exercise stays on the tile. A week: until the next one has had its chance. */
const MISSED_VISIBLE_MS = 7 * 86_400_000;
const COMMAND_FAILED_VISIBLE_MS = 24 * 3_600_000;

const MISSED_OUTCOMES = new Set(["missed", "missed-running"]);

/** "Thu 22 Oct, 07:00" in the area's zone. */
export function formatInstant(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
}

/** "45 min", "6 h", "3 d" — how long something has been true. No-break space: never "3" / "d". */
function formatSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}\u00A0min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}\u00A0h`;
  return `${Math.floor(h / 24)}\u00A0d`;
}

const SEVERITY_RANK = { critical: 0, warning: 1 } as const;

/** Every issue, worst first; empty when there is nothing to say. */
export function assessGeneratorHealth(
  input: GeneratorHealthInput,
): GeneratorIssue[] {
  const { nowMs, timezone, latest } = input;
  const at = (ms: number) => formatInstant(ms, timezone);
  const issues: GeneratorIssue[] = [];

  // --- the controller ------------------------------------------------------------------------
  const lastReadMs = lastControllerReadingMs(latest);
  const offline = controllerIsOffline(lastReadMs, nowMs);
  if (offline && lastReadMs != null) {
    issues.push({
      code: "controller_offline",
      severity: "critical",
      title: "Controller offline",
      detail:
        `No reading from the generator controller for ${formatSpan(nowMs - lastReadMs)} ` +
        `(last ${at(lastReadMs)}). It cannot be started remotely, and whether it would start ` +
        `on its own is unknown.`,
      sinceMs: lastReadMs,
    });
  }

  // --- the starter battery ---------------------------------------------------------------------
  const batteryPath = firstPresentPath(latest, GENERATOR_BATTERY_PATHS);
  const rpmPath = firstPresentPath(latest, GENERATOR_RPM_PATHS);
  const volts = batteryPath ? numberOf(latest[batteryPath]?.value) : null;
  const rpm = rpmPath ? numberOf(latest[rpmPath]?.value) : null;
  const level = batteryLevel(volts, !offline && rpm != null && rpm > 0);
  if (level !== "ok" && volts != null) {
    const batteryMs = batteryPath ? entryMs(latest, batteryPath) : null;
    const when =
      batteryMs != null && offline
        ? ` at the last reading (${at(batteryMs)})`
        : "";
    issues.push({
      code: level === "flat" ? "battery_flat" : "battery_low",
      severity: level === "flat" ? "critical" : "warning",
      title: `Starter battery ${level === "flat" ? "flat" : "low"} · ${volts.toFixed(1)} V`,
      detail:
        level === "flat"
          ? `${volts.toFixed(1)} V${when} — too low to crank the engine, and the controller runs from ` +
            `the same battery. Check its charger.`
          : `${volts.toFixed(1)} V at rest${when}, below 12.2 V. A battery on its charger sits near ` +
            `13.3 V, so the charger is probably not charging it.`,
      sinceMs: batteryMs,
    });
  }

  // --- exercise rules --------------------------------------------------------------------------
  for (const rule of input.exercises ?? []) {
    const ctx = rule.context;
    if (!ctx || ctx.kind !== "exercise") continue;
    if (
      ctx.outcome === "waiting" &&
      rule.enabled &&
      (ctx.ticks ?? 1) >= FAILING_AFTER_TICKS &&
      nowMs - ctx.at <= WAITING_FRESH_MS
    ) {
      const since = ctx.firstSeenAt ?? ctx.slotAt;
      issues.push({
        code: "exercise_failing",
        severity: "critical",
        title: "Exercise not starting",
        detail:
          `"${rule.name}" has tried ${ctx.ticks ?? 1} times since ${at(since)} without starting ` +
          `the engine${ctx.reason ? `: ${ctx.reason}` : ""}.`,
        sinceMs: since,
      });
    } else if (
      MISSED_OUTCOMES.has(ctx.outcome) &&
      nowMs - ctx.slotAt <= MISSED_VISIBLE_MS
    ) {
      issues.push({
        code: "exercise_missed",
        severity: "critical",
        title: `Exercise missed · ${at(ctx.slotAt).split(",")[0]}`,
        detail:
          `"${rule.name}" did not run at ${at(ctx.slotAt)}` +
          (ctx.reason ? ` — ${ctx.reason}` : "") +
          (ctx.ticks ? ` (${ctx.ticks} attempts)` : "") +
          ".",
        sinceMs: ctx.slotAt,
      });
    }
  }

  // --- the last command --------------------------------------------------------------------------
  const cmd = input.lastCommand;
  if (
    cmd &&
    !cmd.byAutomation &&
    (cmd.status === "failed" || cmd.status === "rejected") &&
    nowMs - cmd.requestedAtMs <= COMMAND_FAILED_VISIBLE_MS
  ) {
    issues.push({
      code: "command_failed",
      severity: "warning",
      title: "Last command failed",
      detail: `${at(cmd.requestedAtMs)}${cmd.error ? `: ${cmd.error}` : ""}`,
      sinceMs: cmd.requestedAtMs,
    });
  }

  // --- the hub's own last error ------------------------------------------------------------------
  const errorText = latest[GENERATOR_ERROR_PATH]?.value;
  const errorMs = entryMs(latest, GENERATOR_ERROR_PATH);
  if (
    typeof errorText === "string" &&
    errorText.length > 0 &&
    controlErrorIsRecent(errorMs, nowMs)
  ) {
    issues.push({
      code: "control_error",
      severity: "warning",
      title: "Hub reported an error",
      detail: `${errorMs != null ? `${at(errorMs)}: ` : ""}${errorText}`,
      sinceMs: errorMs,
    });
  }

  return issues.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

function numberOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
