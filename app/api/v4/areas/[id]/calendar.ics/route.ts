/**
 * GET /api/v4/areas/[id]/calendar.ics?token=… → a subscribable iCalendar feed of an area's
 * scheduled automations.
 *
 * 🛑 Authenticated by a FEED TOKEN in the query string, not by a session — because the whole point
 * is that a calendar client fetches it unattended, forever, with no way to sign in. That makes the
 * URL the entire credential, which is why `lib/areas/calendar-tokens.ts` mints ~98 bits of it and
 * why `middleware.ts` lets this route past `auth.protect()` only for GET/HEAD and only when a
 * `token` is present. It is the same shape, and the same deliberate security decision, as a
 * dashboard share link.
 *
 * What is in it: one VEVENT per EXERCISE rule — charge-session rules have no schedule and would be
 * events with no time — plus, for every past occurrence that has been decided, a `RECURRENCE-ID`
 * OVERRIDE carrying what actually happened, and one event per generator run no schedule accounts
 * for.
 *
 * 🛑 **Outcomes are in the feed; point VALUES still are not.** This reverses an earlier invariant
 * ("nothing about what the generator actually did"), deliberately. A schedule alone answers "when
 * was it meant to run" and leaves "did it" to somebody opening the app, which is the question a
 * subscriber actually has — and ✅/⏭️/⛔️ answers it without publishing a single reading.
 *
 * Why an override rather than a retitled master: a recurring rule is ONE VEVENT with an RRULE, so
 * there is no per-occurrence component to retitle. RFC 5545's answer is a second VEVENT with the
 * SAME UID and a `RECURRENCE-ID` naming the occurrence it replaces — exactly what Calendar.app
 * writes when you edit "this event only". The master keeps its RRULE and its plain title; each
 * decided past slot gets a small override beside it. A one-off has no RRULE, so its master is
 * simply retitled.
 */
import { NextRequest, NextResponse } from "next/server";
import ical, { ICalEventStatus } from "ical-generator";
import { DateTime } from "luxon";
import { getVtimezoneComponent } from "@touch4it/ical-timezones";
import { Area } from "@/lib/ids";
import { loadAreaForAuth } from "@/lib/areas/http";
import { validateCalendarToken } from "@/lib/areas/calendar-tokens";
import * as store from "@/lib/automations/store";
import {
  parseAutomationAction,
  parseAutomationTrigger,
} from "@/lib/automations/types";
import {
  occurrencesBetween,
  toRecurrenceLines,
} from "@/lib/automations/recurrence";
import {
  attributeRuns,
  attributionSlackMs,
  markForSlot,
  type MarkableSlot,
  type SlotMark,
} from "@/lib/automations/calendar-marks";
import {
  derivationNames,
  listGeneratorDetectorsForArea,
} from "@/lib/derivations/resolve";
import type {
  AutomationRow,
  ExerciseOutcome,
  ExerciseTrigger,
} from "@/lib/db/planetscale/schema";

// The feed is a live read of the automations table; a cached response would show a subscriber a
// schedule that has already been edited.
export const dynamic = "force-dynamic";

/**
 * How far back the feed reports outcomes and runs.
 *
 * A year and a day, so a subscriber scrolling back through "last winter" finds the whole season
 * rather than a feed that ends abruptly — and one bound rather than two, because a run and the slot
 * that explains it must never fall on opposite sides of the cutoff.
 */
const FEED_HISTORY_DAYS = 366;

/**
 * One run, reduced to what the feed says about it.
 *
 * `endMs` is null for an OPEN run — a generator going right now. Such a run cannot be an event (an
 * event needs a DTEND), but it is still evidence that a slot STARTED, which is a different question
 * and one the feed gets wrong if it throws the row away: a run beginning near the end of a grace
 * window and still going when the window closes would be published as "no start was detected".
 */
interface FeedRun {
  startMs: number;
  endMs: number | null;
  energyKwh: number | null;
}

/** Everything an unauthorized caller gets, whatever went wrong. */
function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return notFound();

  const areaUuid = Area.toUuidOrNull(id);
  if (!areaUuid) return notFound();

  const validated = await validateCalendarToken(token);
  // 🛑 BOTH checks. A valid token proves the holder may read SOME area's calendar; without the
  // second term, one area's token would read every area's feed by changing the path.
  if (!validated || validated.areaUuid !== areaUuid) return notFound();

  const area = await loadAreaForAuth(areaUuid);
  if (!area) return notFound();

  const timezone = area.displayTimezone;
  const rows = await store.listForArea(areaUuid);

  const nowMs = Date.now();
  const sinceMs = nowMs - FEED_HISTORY_DAYS * 86_400_000;

  // 🛑 ONE expansion floor for every rule — the WIDEST attribution window on the area, not each
  // rule's own. Attribution is a matching between all of a detector's slots and all of its runs, so
  // a floor computed per rule decides which slots get to COMPETE: a tight-grace rule's slot would
  // fall outside its own floor while a loose-grace rule's slot survived, and the loose one would
  // take the run the tight one should have had — publishing the leftover as "unscheduled".
  const slackMs = Math.max(
    0,
    ...rows.map((row) => {
      const trigger = exerciseTrigger(row);
      return trigger ? attributionSlackMs(trigger.schedule.graceMinutes) : 0;
    }),
  );

  // 🛑 PLANNED before anything is read, and before the first event is built. Attribution is a
  // per-DETECTOR matching, not a per-rule one (see `attributeRuns`), so every rule's occurrences
  // have to be in hand before any rule's glyph can be decided.
  const plans = rows.flatMap((row) =>
    planRule(row, timezone, sinceMs - slackMs, nowMs),
  );

  // 🛑 The detector set is the union of two DIFFERENT things, and the second is what makes the feed
  // show history nobody scheduled: the rules' own detectors, plus every enabled generator detector
  // at this site. An area with no automations at all therefore still has a calendar of its runs,
  // and a start from the panel or the UI appears by itself — no backfill script, ever.
  const ruleDerivationIds = [
    ...new Set(
      plans
        .map((plan) => plan.derivationId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const detectorNames = new Map(
    (await listGeneratorDetectorsForArea(areaUuid)).map((d) => [d.id, d.name]),
  );
  // A rule may name a detector that listing does not return — one whose role is not `generator`.
  // Its runs still explain that rule's slots, so it needs a name like any other.
  for (const [id, name] of await derivationNames(
    ruleDerivationIds.filter((id) => !detectorNames.has(id)),
  ))
    detectorNames.set(id, name);

  // 🛑 The reads reach back FURTHER than the feed publishes, by the widest attribution window any
  // rule here has. Slots are expanded back by the same amount (see `planRule`), and the two must
  // match: a pre-cutoff slot that could see later runs but not its OWN would claim a run it never
  // started, hiding a real unscheduled event. Nothing before `sinceMs` is ever published; the extra
  // history exists only so the matching is the same one a wider window would have produced.
  const historyFloorMs = Math.min(
    sinceMs,
    ...plans.map((plan) => plan.attributionFloorMs),
  );

  const runsByDerivation = new Map<string, FeedRun[]>();
  await Promise.all(
    [...detectorNames.keys()].map(async (derivationId) => {
      const intervals = await store.intervalsOverlapping(
        derivationId,
        historyFloorMs,
        nowMs,
      );
      // Open runs are KEPT here and excluded only where an event is built — see `FeedRun`.
      runsByDerivation.set(
        derivationId,
        intervals.map((row) => ({
          startMs: row.startTime.getTime(),
          endMs: row.endTime?.getTime() ?? null,
          energyKwh: row.energyKwh,
        })),
      );
    }),
  );

  const outcomes = await store.listSlotOutcomesForAutomations(
    rows.map((row) => row.id),
    historyFloorMs,
  );

  // ONE matching per detector, over every rule's slots at once — see `attributeRuns`.
  const attribution = new Map<
    string,
    ReturnType<typeof attributeRuns<FeedRun>>
  >();
  for (const derivationId of detectorNames.keys())
    attribution.set(
      derivationId,
      attributeRuns(
        runsByDerivation.get(derivationId) ?? [],
        plans
          .filter((plan) => plan.derivationId === derivationId)
          .flatMap((plan) => plan.slots),
      ),
    );

  const calendar = ical({
    name: `${area.displayName} automations`,
    description: `Scheduled automations for ${area.displayName}, from LiveOne.`,
    prodId: { company: "LiveOne", product: "automations", language: "EN" },
    // A real VTIMEZONE component, not just a TZID string: without it a client cannot resolve the
    // `TZID=` that every DTSTART here carries.
    //
    // 🛑 `name: null` — the generator WITHOUT a calendar-level timezone. Naming the zone here
    // instead makes ical-generator format the calendar's own properties in it, and two things go
    // wrong: `DTSTAMP` loses its `Z` (RFC 5545 requires it in UTC, so the stamp becomes invalid),
    // and `TIMEZONE-ID`/`X-WR-TIMEZONE` get emitted AFTER `END:VTIMEZONE`, i.e. calendar
    // properties trailing a component. Both are things a strict client is entitled to reject.
    // With null the VTIMEZONE is still generated from each event's own zone, which is all we
    // wanted from it.
    timezone: { name: null, generator: vtimezoneOrComplain },
    // 🛑 No `ttl`, deliberately. It is the ONLY remaining thing that emits calendar properties
    // (REFRESH-INTERVAL, X-PUBLISHED-TTL) AFTER the first component, which is not legal
    // iCalendar — `icalbody` is calprops THEN components — and iCloud fetched this feed and
    // refused to process it ("Last updated: Never") while it was malformed. `calendar.x()` places
    // custom properties in the same wrong spot, so there is no conformant way to keep the hint
    // with this library.
    //
    // Little is lost: it was only ever a hint, Apple ignores it in favour of the subscription's
    // own Auto-refresh setting, and a client that polls on its own schedule is the normal case.
    // 🛑 The URL WITHOUT the token. `request.url` carries `?token=…`, and putting it here writes
    // the credential into the VCALENDAR body — so an exported or forwarded .ics file is itself a
    // working, long-lived subscription for anyone who opens it in a text editor. Query-string auth
    // is the deliberate decision; handing the credential to every copy of the payload is not part
    // of it.
    url: feedUrlWithoutToken(request.url),
  });

  for (const plan of plans) {
    const { row, trigger, start, minutes, recurrence } = plan;
    const slotOutcomes =
      outcomes.get(row.id) ?? new Map<number, ExerciseOutcome>();
    const bySlot =
      (plan.derivationId
        ? attribution.get(plan.derivationId)?.bySlot
        : undefined) ?? new Map<string, FeedRun>();

    const marks = plan.slots
      // Slots before the cutoff were expanded ONLY so they could claim their runs — they are
      // outside the published history and are never marked.
      .filter((slot) => slot.atMs >= sinceMs)
      .map((slot) => {
        const run = bySlot.get(slot.key) ?? null;
        const outcome = slotOutcomes.get(slot.atMs) ?? null;
        return {
          atMs: slot.atMs,
          run,
          outcome,
          mark: markForSlot({
            slotAtMs: slot.atMs,
            graceMinutes: slot.graceMinutes,
            nowMs,
            run,
            outcome,
            enabled: row.enabled,
          }),
        };
      });

    const oneOffMark =
      recurrence === null && marks.length === 1 ? marks[0] : null;

    const event = calendar.createEvent({
      // Stable across every edit, so a client updates the existing entry rather than accumulating
      // duplicates. `sequence` below is what tells it an update happened.
      id: `${row.id}@liveone.energy`,
      start,
      end: start.plus({ minutes }),
      timezone,
      // 🛑 A DECIDED one-off drops the `(disabled)` suffix, and that is not an oversight. The
      // evaluator disables a one-off in the same write that consumes its last slot, so every spent
      // one-off is a disabled rule — and to a subscriber "✅ Top-up run (disabled)" reads as a
      // contradiction. Once the glyph says what happened, "disabled" has nothing left to add. A
      // STANDING rule, and an undecided one-off, keep the suffix: there, disabled still means
      // "and it will not happen again".
      summary:
        oneOffMark?.mark != null
          ? `${oneOffMark.mark} ${row.name}`
          : row.enabled
            ? row.name
            : `${row.name} (disabled)`,
      description: describeRule(row, trigger, minutes, {
        mark: oneOffMark?.mark ?? null,
        outcome: oneOffMark?.outcome ?? null,
        run: oneOffMark?.run ?? null,
      }),
      // 🛑 A disabled rule is marked in the SUMMARY and left CONFIRMED. It is NOT `CANCELLED`.
      //
      // That was the first attempt, and it did the exact thing it was written to avoid: Apple
      // Calendar (and Google) treat `STATUS:CANCELLED` as withdrawn and render nothing at all, so
      // a feed whose only event that week was a disabled rule looked empty and broken. "It is not
      // running this week" is information a subscriber wants; hiding the event is how you lose it.
      status: ICalEventStatus.CONFIRMED,
      // Monotonic per edit. Epoch SECONDS because SEQUENCE is a 32-bit integer in practice and
      // epoch-ms overflows it.
      sequence: Math.floor(row.updatedAt.getTime() / 1000),
    });

    if (recurrence !== null) event.repeating(recurrence);

    // The overrides. Only where the master is a series: a one-off has no occurrence to override and
    // was retitled in place above.
    if (recurrence === null) continue;
    for (const { atMs, mark, outcome, run } of marks) {
      if (mark === null) continue;
      // 🛑 LUXON here too. `RECURRENCE-ID` goes through the same formatter as `DTSTART`, so a plain
      // `Date` would name the occurrence at the PROCESS's wall clock wearing this area's TZID — and
      // an override whose RECURRENCE-ID matches no occurrence is silently dropped by the client,
      // leaving the feed looking exactly as if the marking had never been written.
      const at = DateTime.fromMillis(atMs, { zone: timezone });
      calendar.createEvent({
        // 🛑 The MASTER's UID. That, plus RECURRENCE-ID, is what makes this an override of one
        // occurrence rather than a second event sitting on top of it.
        id: `${row.id}@liveone.energy`,
        recurrenceId: at,
        start: at,
        end: at.plus({ minutes }),
        timezone,
        summary: `${mark} ${row.name}`,
        description: describeRule(row, trigger, minutes, {
          mark,
          outcome,
          run,
        }),
        status: ICalEventStatus.CONFIRMED,
        // The master's own sequence: an override is not independently edited, so it moves when the
        // rule does. A client comparing the two sees one consistent version of the series.
        sequence: Math.floor(row.updatedAt.getTime() / 1000),
      });
    }
  }

  // Everything the schedules do not account for: a start from the generator's own panel, from the
  // UI, or from before any rule existed. This is why the history needs no backfill script — the
  // feed reads the runs, so next month's manual start appears on its own.
  for (const [derivationId, detectorName] of detectorNames) {
    for (const run of attribution.get(derivationId)?.unattributed ?? []) {
      // 🛑 An OPEN run gets no event. It has no end, so there is no DTEND to write — and a
      // generator going right now is not yet a thing that happened. It has already done its other
      // job above: a slot it started in is ✅ on the strength of it.
      if (run.endMs === null) continue;
      // Pre-cutoff runs were fetched only so the matching could see them; they are not history the
      // feed publishes.
      if (run.startMs < sinceMs) continue;
      const start = DateTime.fromMillis(run.startMs, { zone: timezone });
      if (!start.isValid) continue; // the zone was already complained about above
      calendar.createEvent({
        // 🛑 `start_time` is the row's IMMUTABLE IDENTITY — half of `derived_intervals`' primary
        // key — so it is the only stable thing to key a UID on. Note the consequence: a detector
        // recompute that shifts a start by seconds mints a NEW UID, and a client sees a delete plus
        // an add rather than an update. Acceptable for derived, reproducible rows; it would not be
        // for an automation.
        id: `run-${derivationId}-${run.startMs}@liveone.energy`,
        start,
        end: DateTime.fromMillis(run.endMs, { zone: timezone }),
        timezone,
        summary: `✅ ${detectorName} run (unscheduled)`,
        description: [
          `${describeRun(run)}.`,
          // 🛑 A claim about the SCHEDULE, not about causation. "Nobody scheduled this" is what the
          // feed actually knows — no slot's window contains this start. It does not know that no
          // automation caused it: a dispatch made at the very end of a grace window can start a run
          // just outside the window the slot allows, and "not started by an automation" would be a
          // categorical statement about a thing the feed never looked at.
          "No scheduled slot accounts for this run.",
        ].join("\n"),
        status: ICalEventStatus.CONFIRMED,
        sequence: Math.floor(run.endMs / 1000),
      });
    }
  }

  return new NextResponse(calendar.toString(), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Private: the URL is a credential, so no shared cache should hold the response.
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": `inline; filename="${slug(area.displayName)}-automations.ics"`,
    },
  });
}

/**
 * The feed's own URL with the credential stripped, for the VCALENDAR `URL:` property.
 *
 * 🛑 `request.url` IS the credential — the token is the whole of the authentication for this route.
 * Echoing it into the body means every exported, mailed or mirrored copy of the `.ics` file carries
 * a working subscription for whoever holds the file, which is a wider audience than whoever was
 * given the URL. Strip it and the property still does its job: it names the feed.
 */
function feedUrlWithoutToken(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.delete("token");
  return url.toString();
}

/**
 * `getVtimezoneComponent`, but it says so when it comes back empty.
 *
 * 🛑 The package resolves its zone data with `readFileSync(__dirname + "/zones/…")` inside an
 * EMPTY CATCH, so a missing file is indistinguishable from a missing zone and both are reported as
 * `null`. That silence shipped a VTIMEZONE-less feed to production TWICE — once because the `.ics`
 * data was not traced into the bundle, and again because the package was bundled and `__dirname`
 * no longer pointed at it. `next.config.js` now fixes both, and this makes a third cause
 * greppable instead of invisible.
 *
 * Deliberately NOT a throw. Most clients resolve a bare IANA `TZID=` from their own database, so a
 * feed without VTIMEZONE is degraded rather than useless — and failing the whole subscription
 * would be a worse outcome for the subscriber than a loud log is for us.
 */
function vtimezoneOrComplain(timezone: string): string | null {
  const component = getVtimezoneComponent(timezone);
  if (!component)
    console.error(
      `[calendar] no VTIMEZONE for '${timezone}' — every DTSTART in this feed carries a TZID a ` +
        `strict client now cannot resolve. Check that @touch4it/ical-timezones is in ` +
        `serverExternalPackages AND its zones/** are in outputFileTracingIncludes.`,
    );
  return component ?? null;
}

/**
 * One rule, resolved far enough to be matched against runs — everything the emit pass needs that
 * does not depend on what any OTHER rule claimed.
 */
interface RulePlan {
  row: AutomationRow;
  trigger: ExerciseTrigger;
  /** The master event's DTSTART, already proven placeable in the area's zone. */
  start: DateTime;
  minutes: number;
  derivationId: string | null;
  /** The published recurrence lines, or null when the master is a single unrepeated event. */
  recurrence: string | null;
  slots: MarkableSlot[];
  /** The earliest instant a slot of this rule was expanded from — the reads must reach it. */
  attributionFloorMs: number;
}

/**
 * Plan one row, or nothing at all: a charge-session rule (no schedule), an unparseable trigger, or
 * a schedule the area's timezone cannot place.
 *
 * Returns an ARRAY so the caller can `flatMap` — "this row contributes no events" and "this row
 * contributes one" are the same shape, and a skipped row never needed a `continue` in the middle of
 * an event-building loop.
 */
function planRule(
  row: AutomationRow,
  timezone: string,
  /** The earliest instant to expand occurrences from — already widened by the shared slack. */
  expandFromMs: number,
  nowMs: number,
): RulePlan[] {
  const trigger = exerciseTrigger(row);
  if (!trigger) return [];

  // 🛑 LUXON, not a `Date`, and this is not a style choice.
  //
  // `ical-generator` formats a plain `Date` against a TZID using `getHours()` — the NODE PROCESS's
  // local timezone — and simply assumes the process is running in the event's zone. That is true on
  // a Melbourne laptop and false on Vercel (UTC), so the first deploy of this route published every
  // event at its UTC wall clock wearing a `TZID=Australia/Melbourne` label: ten hours out, in a feed
  // whose entire job is to say when the generator runs. The unit tests passed, because they ran on
  // the laptop.
  //
  // The luxon branch of `formatDate` calls `setZone()` and does a real conversion, which is why the
  // library lists it as an optional peer. Proven identical under TZ=UTC, America/New_York,
  // Asia/Kolkata and Australia/Melbourne.
  const start = DateTime.fromISO(trigger.schedule.start, { zone: timezone });
  // An area whose `display_timezone` is not a zone luxon knows yields an INVALID DateTime, and
  // `createEvent` throws on one — which would 500 the entire subscription over a single
  // misconfigured row. Skip the event, say why, and serve the rest.
  if (!start.isValid) {
    console.error(
      `[calendar] ${row.id}: cannot place '${trigger.schedule.start}' in '${timezone}' ` +
        `(${start.invalidReason}) — omitting it from the feed`,
    );
    return [];
  }

  // The requested run LENGTH is the action's value — so the block in the calendar is how long the
  // engine is being asked to run for, not an arbitrary slot.
  //
  // Through the PARSER, like the trigger above it. Drizzle's `.$type<AutomationAction>()` is a
  // compile-time convenience for writers and nothing at all at runtime (see `types.ts`), so a legacy
  // or hand-written row with `action: null` makes `row.action.kind` throw — and one bad row would
  // take out the whole feed rather than its own event.
  const action = parseAutomationAction(row.action);
  const minutes =
    action.ok &&
    action.value.kind === "point-action" &&
    action.value.action === "set_value"
      ? action.value.value
      : 30;

  const grace = trigger.schedule.graceMinutes;
  // 🛑 From `createdAt`, never earlier. `occurrencesBetween` happily expands the rule back before
  // the automation existed, and those slots were never evaluated — marking them ⛔️ would blame the
  // rule for weeks it was not there. EXDATEs are already applied by the expander, so an excluded
  // occurrence simply never appears here.
  //
  // `expandFromMs` already reaches back past the published cutoff (see the caller). Those slots are
  // never marked; they exist only to COMPETE for their runs. Without them, a slot a minute before
  // the cutoff and its run a minute after it would be torn apart by the boundary, and the run
  // published as "unscheduled" — a false statement assembled out of an arbitrary number.
  const attributionFloorMs = Math.max(row.createdAt.getTime(), expandFromMs);

  return [
    {
      row,
      trigger,
      start,
      minutes,
      derivationId:
        trigger.source.kind === "derivation"
          ? trigger.source.derivationId
          : null,
      // 🛑 "Is this master a SERIES?" — asked of the recurrence lines the feed actually publishes,
      // not of `schedule.rrule`. They are not the same question: a schedule may carry `rdates` with
      // no rrule at all, which `toRecurrenceLines` renders as a repeating event with several
      // occurrences. Reading that as a one-off retitled the master — i.e. applied ONE occurrence's
      // outcome to every future occurrence of the same event — and, past the second occurrence,
      // silently dropped the marking altogether.
      recurrence: toRecurrenceLines(trigger.schedule, timezone),
      slots: occurrencesBetween(
        trigger.schedule,
        timezone,
        attributionFloorMs,
        nowMs,
      ).map((slot) => ({
        // Keyed by RULE and occurrence: two rules on one generator can have slots at the same
        // instant, and an instant-keyed matching silently merges them.
        key: `${row.id}:${slot.atMs}`,
        atMs: slot.atMs,
        graceMinutes: grace,
      })),
      attributionFloorMs,
    },
  ];
}

/** The exercise trigger of a row, or null — an unparseable or charge-session row is skipped. */
function exerciseTrigger(row: AutomationRow): ExerciseTrigger | null {
  const parsed = parseAutomationTrigger(row.trigger);
  if (!parsed.ok || parsed.value.kind !== "exercise") return null;
  return parsed.value;
}

/** "Ran for 28 minutes (0.5 kWh)" — the kWh only when the detector actually accumulated any. */
function describeRun(run: FeedRun): string {
  if (run.endMs === null) return "It started, and is still running";
  const ran = `Ran for ${Math.round((run.endMs - run.startMs) / 60_000)} minutes`;
  // NULL is UNKNOWN here, never zero — an unpriceable or un-metered run says nothing rather than
  // claiming it produced nothing.
  return run.energyKwh === null
    ? ran
    : `${ran} (${run.energyKwh.toFixed(1)} kWh)`;
}

/**
 * What happened to this occurrence, in one sentence — or nothing, for a slot with no verdict.
 *
 * The three glyphs are not equally self-explanatory: ⏭️ in particular is only meaningful with the
 * reason beside it, and "the engine had already run enough" and "the battery was too full to load
 * it" are different enough that a subscriber deciding whether to intervene wants to know which.
 */
function describeOutcome(args: {
  mark: SlotMark;
  outcome: ExerciseOutcome | null;
  run: FeedRun | null;
  graceMinutes: number;
}): string | null {
  switch (args.mark) {
    case "✅":
      return args.run ? `${describeRun(args.run)}.` : "It ran.";
    case "⏭️":
      return args.outcome === "skipped-full"
        ? "Skipped: the battery was too full to load the engine."
        : "Skipped: the generator had already run enough.";
    case "⛔️":
      return (
        `Did not run: no start was detected within ${args.graceMinutes} minutes ` +
        "of the scheduled time."
      );
    default:
      return null;
  }
}

/** The event body: what it does, what would stop it doing it, and — once past — what happened. */
function describeRule(
  row: AutomationRow,
  trigger: ExerciseTrigger,
  minutes: number,
  decided: {
    mark: SlotMark;
    outcome: ExerciseOutcome | null;
    run: FeedRun | null;
  },
): string {
  // 🛑 FIRST. On a past occurrence the outcome is the whole reason a subscriber opened the event,
  // and Calendar.app shows the beginning of a description in the list view.
  const outcome = describeOutcome({
    ...decided,
    graceMinutes: trigger.schedule.graceMinutes,
  });
  const lines = outcome ? [outcome, ""] : [];
  lines.push(`Run for ${minutes} minutes.`);
  // 🛑 Only stated when there IS a skip condition. A one-off used to be forced to carry an
  // unreachable threshold (`minMinutes: 600`), and this line published it verbatim — "Skipped if
  // it has already run for 600 minutes or more above 1.5 kW in the previous 7 days" went out to
  // every subscriber of the feed, describing a rule that could not be skipped by anything.
  if (trigger.unless)
    lines.push(
      `Skipped if it has already run for ${trigger.unless.minMinutes} minutes or more above ` +
        `${trigger.unless.minLoadKw} kW in the previous ${trigger.unless.withinDays} days.`,
    );
  // Not on a DECIDED occurrence. "Disabled" is a statement about the future, and on a spent one-off
  // — which the evaluator disables in the very write that closes its last slot — it reads as a
  // problem with an occurrence that went perfectly well.
  if (!row.enabled && outcome === null)
    lines.push("This rule is currently DISABLED.");
  lines.push(
    `A missed start stays due for ${trigger.schedule.graceMinutes} minutes.`,
  );
  return lines.join("\n");
}

/** A filename-safe area name, so the downloaded file says which site it is. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "area"
  );
}
