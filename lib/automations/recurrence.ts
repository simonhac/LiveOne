/**
 * The recurrence grammar: an RFC 5545 subset, and the ONLY module that knows `rrule-temporal`
 * exists.
 *
 * Everything above this file speaks `ExerciseSchedule` + epoch milliseconds, which is what made it
 * worth isolating: the previous grammar was hand-evaluated (an 8-day lookback that walked local
 * calendar days) and hand-validated in two places, with the weekday list copied four times. A
 * recurrence expander is a solved problem with a long tail of calendar cases — ordinal weekdays,
 * BYSETPOS, daylight saving, month-end — and hand-rolling it is how "one-off Sat 12 Sep" became a
 * standing weekly rule.
 *
 * `nowMs` is INJECTED and `Date.now()` is banned, for `decide.ts`'s reason: every interesting case
 * here is a clock case and none of them are testable against a real clock.
 */
import { RRuleTemporal } from "rrule-temporal";
import { toText } from "rrule-temporal/totext";
import type { ExerciseSchedule } from "@/lib/db/planetscale/schema";
// Type-only, so this stays a one-way dependency at runtime: `types.ts` imports the parser BELOW as
// a value, and a value cycle between the two would be a real one.
import type { ParseOutcome } from "./types";

/** A scheduled occurrence, as an absolute instant. */
export interface Slot {
  atMs: number;
}

/** "YYYY-MM-DDTHH:MM" — local wall clock, the stored form of every instant in a schedule. */
export const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The subset, as a whitelist.
 *
 * 🛑 This is deliberately narrower than RFC 5545, and the omissions are decisions, not gaps:
 *  - sub-daily `FREQ` (SECONDLY/MINUTELY/HOURLY) — an exercise rule that fires hourly is a fault,
 *    not a schedule, and nothing downstream is built to survive one.
 *  - `BYHOUR`/`BYMINUTE`/`BYSECOND` — time of day comes from DTSTART and one place only, so there
 *    is exactly one answer to "what time does this run".
 *  - `BYWEEKNO`/`BYYEARDAY` — expressible, unreadable, and nobody has ever wanted them here.
 *  - `RSCALE`/`SKIP` (RFC 7529) — non-Gregorian calendars, which the area timezone model has no
 *    notion of.
 * Anything outside the whitelist is REFUSED rather than ignored: silently dropping a part the
 * owner wrote would produce a schedule they did not ask for.
 */
const ALLOWED_KEYS = [
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
] as const;
const ALLOWED_FREQ = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** `[+-]?[1-5]?DAY` — the ordinal form ("1SA" = first Saturday, "-1FR" = last Friday). */
const BYDAY_TERM = /^([+-]?[1-9]\d?)?(SU|MO|TU|WE|TH|FR|SA)$/;
/** UNTIL is either a bare local date, or a UTC instant. A FLOATING date-time is not legal here. */
const UNTIL_DATE = /^\d{8}$/;
const UNTIL_INSTANT = /^\d{8}T\d{6}Z$/;

function fail<T>(error: string): ParseOutcome<T> {
  return { ok: false, error };
}

/**
 * Validate an RRULE VALUE (no "RRULE:" prefix, no DTSTART) against the subset, and return it
 * canonicalised — upper-cased, with the parts in whitelist order so two spellings of the same rule
 * store identically (the job `parseWeekdays` used to do for the weekday list).
 *
 * The whitelist runs BEFORE the library, because the library is lenient about parts it does not
 * know: an unrecognised `NONSENSE=1` parses cleanly and is simply ignored, which is exactly the
 * silent-wrong-schedule outcome this refuses. The library then runs as the second gate, so a rule
 * that passes here is also one it can actually expand.
 */
export function parseRRuleSubset(raw: unknown): ParseOutcome<string> {
  if (typeof raw !== "string" || raw.trim() === "")
    return fail("trigger.schedule.rrule must be a non-empty RRULE string");

  const text = raw
    .trim()
    .toUpperCase()
    .replace(/^RRULE:/, "");
  const parts = new Map<string, string>();

  for (const chunk of text.split(";")) {
    if (chunk === "") continue;
    const eq = chunk.indexOf("=");
    if (eq <= 0)
      return fail(`trigger.schedule.rrule: '${chunk}' is not KEY=VALUE`);
    const key = chunk.slice(0, eq);
    const value = chunk.slice(eq + 1);
    if (!(ALLOWED_KEYS as readonly string[]).includes(key))
      return fail(
        `trigger.schedule.rrule: ${key} is not supported (allowed: ${ALLOWED_KEYS.join(", ")})`,
      );
    // A duplicate key is ambiguous, not additive — RFC 5545 says each part appears at most once.
    if (parts.has(key))
      return fail(`trigger.schedule.rrule: ${key} appears more than once`);
    if (value === "")
      return fail(`trigger.schedule.rrule: ${key} has no value`);
    parts.set(key, value);
  }

  const freq = parts.get("FREQ");
  if (freq === undefined)
    return fail("trigger.schedule.rrule must include FREQ");
  if (!(ALLOWED_FREQ as readonly string[]).includes(freq))
    return fail(
      `trigger.schedule.rrule: FREQ=${freq} is not supported (allowed: ${ALLOWED_FREQ.join(", ")})`,
    );

  // COUNT and UNTIL both bound the series, and RFC 5545 forbids both at once precisely because
  // there is no sensible reading of a rule that carries two different endings.
  if (parts.has("COUNT") && parts.has("UNTIL"))
    return fail("trigger.schedule.rrule must not set both COUNT and UNTIL");

  const interval = parts.get("INTERVAL");
  if (interval !== undefined && !/^[1-9]\d*$/.test(interval))
    return fail("trigger.schedule.rrule: INTERVAL must be a whole number >= 1");

  const count = parts.get("COUNT");
  if (count !== undefined && !/^[1-9]\d*$/.test(count))
    return fail("trigger.schedule.rrule: COUNT must be a whole number >= 1");

  const until = parts.get("UNTIL");
  if (
    until !== undefined &&
    !UNTIL_DATE.test(until) &&
    !UNTIL_INSTANT.test(until)
  )
    return fail(
      "trigger.schedule.rrule: UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ (a floating date-time is not valid against a zoned start)",
    );

  const byday = parts.get("BYDAY");
  if (byday !== undefined) {
    for (const term of byday.split(",")) {
      const match = BYDAY_TERM.exec(term);
      if (!match)
        return fail(
          `trigger.schedule.rrule: BYDAY term '${term}' is not a weekday, optionally ordinal-prefixed (e.g. TH, 1SA, -1FR)`,
        );
      // 🛑 The ordinal has to be bounded HERE, because the library will not do it for us: it
      // accepts `BYDAY=6MO`, stores fine, and then throws "Maximum iterations (10000) exceeded"
      // the first time anything expands it — after the row is already in the table. A poison rule
      // like that 500s every subsequent `GET /api/v4/automations?area=…`, because the list maps
      // every row through `automationWire` -> `nextOccurrence`.
      //
      // RFC 5545 caps the ordinal at 53 (the weeks in a year). Under FREQ=MONTHLY the real cap is
      // 5, since no month holds a sixth Monday — and a rule that can never match is a typo, not a
      // schedule.
      const ordinal =
        match[1] === undefined ? null : Math.abs(Number(match[1]));
      if (ordinal !== null) {
        const cap = freq === "MONTHLY" ? 5 : 53;
        if (ordinal > cap)
          return fail(
            `trigger.schedule.rrule: BYDAY term '${term}' is out of range (FREQ=${freq} allows an ordinal of 1..${cap})`,
          );
      }
    }
  }

  const wkst = parts.get("WKST");
  if (
    wkst !== undefined &&
    !(WEEKDAY_CODES as readonly string[]).includes(wkst)
  )
    return fail("trigger.schedule.rrule: WKST must be a weekday code");

  // `signed` is per-part, not global: counting from the end is meaningful for BYMONTHDAY (-1 = the
  // last day) and for BYSETPOS (-1 = the last match), and meaningless for BYMONTH — there is no
  // "second-to-last month" in RFC 5545. A shared `Math.abs` range check accepted `BYMONTH=-2`,
  // which the library then sanitises away, dropping the month filter the owner actually wrote.
  const numericList = (
    key: string,
    min: number,
    max: number,
    signed: boolean,
  ) => {
    const value = parts.get(key);
    if (value === undefined) return null;
    for (const term of value.split(",")) {
      const n = Number(term);
      if (
        !/^[+-]?\d+$/.test(term) ||
        n === 0 ||
        (!signed && n < 0) ||
        Math.abs(n) < min ||
        Math.abs(n) > max
      )
        return `trigger.schedule.rrule: ${key} term '${term}' is out of range`;
    }
    return null;
  };
  const ranges =
    numericList("BYMONTHDAY", 1, 31, true) ??
    numericList("BYMONTH", 1, 12, false) ??
    numericList("BYSETPOS", 1, 366, true);
  if (ranges !== null) return fail(ranges);

  const canonical = ALLOWED_KEYS.filter((k) => parts.has(k))
    .map((k) => `${k}=${parts.get(k)}`)
    .join(";");

  // Second gate: the library has to accept it too, so a rule that stores is a rule that expands.
  //
  // 🛑 It has to EXPAND, not just construct. `new RRuleTemporal(…)` is lazy — it parses the string
  // and returns, so it accepts rules it cannot iterate, and the throw then lands on whoever first
  // asks for an occurrence. That is after the row is written: POST 500s from `automationWire`
  // having already inserted, and every later read of the area's automations 500s the same way.
  // Asking for one occurrence here is the difference between a 422 and a stored poison rule.
  try {
    const probe = new RRuleTemporal({
      rruleString: `DTSTART;TZID=UTC:20260101T090000\nRRULE:${canonical}`,
    });
    probe.next(new Date(Date.UTC(2026, 0, 1)));
  } catch (err) {
    return fail(
      `trigger.schedule.rrule is not a valid recurrence rule: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { ok: true, value: canonical };
}

/** "2026-09-17T09:00" -> "20260917T090000", the iCal compact form. */
function compact(wallClock: string): string {
  return `${wallClock.replace(/[-:]/g, "")}00`;
}

/**
 * The schedule as an iCal fragment — DTSTART, the rule, and the exception/extra dates.
 *
 * A one-off becomes `FREQ=DAILY;COUNT=1` rather than a special case, so the expander, the feed and
 * the exhaustion check all have exactly ONE code path. "A one-off is just a series of length one"
 * is also how RFC 5545 has it.
 */
export function toICalFragment(
  schedule: ExerciseSchedule,
  timezone: string,
): string {
  const lines = [`DTSTART;TZID=${timezone}:${compact(schedule.start)}`];
  lines.push(`RRULE:${schedule.rrule ?? "FREQ=DAILY;COUNT=1"}`);
  const dateList = (name: string, values: string[] | undefined) => {
    if (!values || values.length === 0) return;
    lines.push(`${name};TZID=${timezone}:${values.map(compact).join(",")}`);
  };
  dateList("EXDATE", schedule.exdates);
  dateList("RDATE", schedule.rdates);
  return lines.join("\n");
}

/**
 * The recurrence lines ONLY — RRULE/EXDATE/RDATE, no DTSTART — for `ical-generator`.
 *
 * That shape is the library's supported "pass me an rrule object" path: it splits the string on
 * newlines, drops a `DTSTART:` line and emits the rest verbatim, adding an `RRULE:` prefix only
 * when it was handed a single bare rule. Our EXDATE/RDATE lines carry `;TZID=`, which is what a
 * calendar client needs to place an exception on the right instant across a DST change.
 *
 * Null for a bare one-off: an unrepeated VEVENT is what a one-off IS to a calendar client, and
 * writing `FREQ=DAILY;COUNT=1` instead would show up in Calendar.app as a repeating event.
 */
export function toRecurrenceLines(
  schedule: ExerciseSchedule,
  timezone: string,
): string | null {
  const lines = toICalFragment(schedule, timezone)
    .split("\n")
    .filter((line) => !line.startsWith("DTSTART"));
  if (schedule.rrule === undefined) {
    // The synthetic COUNT=1 exists for the EVALUATOR's single code path, not for the feed.
    const rest = lines.filter((line) => !line.startsWith("RRULE:"));
    return rest.length === 0 ? null : rest.join("\r\n");
  }
  return lines.join("\r\n");
}

function buildRule(
  schedule: ExerciseSchedule,
  timezone: string,
): RRuleTemporal {
  return new RRuleTemporal({ rruleString: toICalFragment(schedule, timezone) });
}

/**
 * The most recent occurrence at or before `nowMs`, or null if the schedule has not started yet
 * (or every instance before now was excluded).
 *
 * INCLUSIVE of `nowMs`, which `RRuleTemporal.previous` is not — hence the +1 ms. It matters: the
 * minutely pass can land exactly on a slot instant, and an exclusive reading would skip that slot
 * until the following tick and shift every downstream grace calculation by a minute.
 */
export function previousOccurrence(
  schedule: ExerciseSchedule,
  timezone: string,
  nowMs: number,
): Slot | null {
  const at = buildRule(schedule, timezone).previous(new Date(nowMs + 1));
  return at === null ? null : { atMs: at.epochMilliseconds };
}

/** The first occurrence strictly after `afterMs`, or null when the series is finished. */
export function nextOccurrence(
  schedule: ExerciseSchedule,
  timezone: string,
  afterMs: number,
): Slot | null {
  const at = buildRule(schedule, timezone).next(new Date(afterMs));
  return at === null ? null : { atMs: at.epochMilliseconds };
}

/** Every occurrence in `[fromMs, toMs]`, both ends inclusive. Bounded by construction. */
export function occurrencesBetween(
  schedule: ExerciseSchedule,
  timezone: string,
  fromMs: number,
  toMs: number,
): Slot[] {
  return buildRule(schedule, timezone)
    .between(new Date(fromMs), new Date(toMs), true)
    .map((at) => ({ atMs: at.epochMilliseconds }));
}

/**
 * Has this rule run out of future? True for a one-off that has been dealt with, and for a
 * COUNT/UNTIL series that has reached its end.
 *
 * The evaluator uses this to DISABLE such a rule, so that a spent schedule goes visibly dark
 * instead of sitting enabled forever with nothing left to fire.
 */
export function isExhausted(
  schedule: ExerciseSchedule,
  timezone: string,
  afterMs: number,
): boolean {
  return nextOccurrence(schedule, timezone, afterMs) === null;
}

/** Human wording for the CLI ("every week on Thursday"). Never throws — the schedule is valid. */
export function describe(schedule: ExerciseSchedule, timezone: string): string {
  if (schedule.rrule === undefined) return "once";
  try {
    return toText(buildRule(schedule, timezone));
  } catch {
    return schedule.rrule;
  }
}
