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
  markForOutcome,
  slotWindow,
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
 * A thing that already happened, ready to be written — a run at its real times, or a slot the
 * evaluator recorded coming to nothing.
 *
 * 🛑 Deliberately carries no recurrence and no link to a schedule. That is the model: the past is
 * assembled from records (`derived_intervals` and `automation_slot_outcomes`), each event standing
 * on its own UID at its own INSTANT, so editing a rule cannot move or delete a morning that has
 * already been and gone.
 *
 * The instant is the guarantee; the title and the length are not. A run is labelled from whichever
 * rule's slot claims it NOW, and a recorded slot's end is its instant plus the rule's CURRENT
 * `set_value` minutes — so a rename, or a change of weekday, can still retitle old events. Pinning
 * those too would mean storing the name and duration beside every outcome, which has not been worth
 * a migration. See docs/calendar.md, "What is immutable, and what is not".
 */
interface PastEvent {
  uid: string;
  start: DateTime;
  end: DateTime;
  summary: string;
  description: string;
  sequence: number;
}

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

/** A run that has finished — the only kind the feed ever writes an event or a sentence about. */
type ClosedRun = FeedRun & { endMs: number };

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

  // Every slot we know of, per rule: the occurrences today's schedule expands to, UNIONED with the
  // ones the evaluator actually recorded. They agree until somebody edits the schedule, and then
  // the recorded instants are the true ones — a recorded slot is not moved by a later PATCH.
  //
  // Both are here because each answers a different half: a recorded slot can be published (we know
  // when it really was), while an expanded one can only LABEL a run (we know which rule would have
  // asked for it). Deduped on `key`, which is `rule:instant`, so an unedited schedule contributes
  // each slot once.
  const slotRules = new Map<string, RulePlan>(); // slot key → the rule it belongs to
  const recordedAt = new Map<string, number>(); // slot key → its instant
  const slotsByDetector = new Map<string, MarkableSlot[]>();
  for (const plan of plans) {
    if (!plan.derivationId) continue;
    const grace = plan.trigger.schedule.graceMinutes;
    const merged = new Map<number, MarkableSlot>();
    for (const slot of plan.slots) merged.set(slot.atMs, slot);
    // A record at the same instant simply IS that occurrence — same key, so this overwrites.
    for (const atMs of outcomes.get(plan.row.id)?.keys() ?? [])
      merged.set(atMs, {
        key: `${plan.row.id}:${atMs}`,
        atMs,
        graceMinutes: grace,
      });
    for (const slot of merged.values()) {
      slotRules.set(slot.key, plan);
      recordedAt.set(slot.key, slot.atMs);
    }
    slotsByDetector.set(plan.derivationId, [
      ...(slotsByDetector.get(plan.derivationId) ?? []),
      ...merged.values(),
    ]);
  }

  // ONE matching per detector, over every rule's slots at once — see `attributeRuns`.
  const attribution = new Map<string, Map<string, FeedRun>>();
  for (const derivationId of detectorNames.keys()) {
    const claimed = attributeRuns(
      runsByDerivation.get(derivationId) ?? [],
      slotsByDetector.get(derivationId) ?? [],
    );

    // 🛑 REPAIR: a RECORDED slot left empty takes back a run held by an EXPANSION of its own rule.
    //
    // Edit a rule from 09:00 to 07:00 after its 09:00 run and both survive into the matching: the
    // recorded 09:00 slot, and the phantom 07:00 one today's schedule expands to. They are two
    // versions of one morning; time order hands the run to the phantom, and an unmatched RECORDED
    // slot is published as ⛔️ — a failure sitting beside the successful run it was describing.
    //
    // A transfer rather than dropping the expansion before matching, which was the first attempt:
    // an expansion's window can legitimately overlap a DIFFERENT occurrence's record (a 09:00 slot
    // and a 12:00 RDATE, three hours of grace), and dropping it there loses the only thing that
    // could put a name to a real run. Nothing is discarded here — only reassigned, and only within
    // one rule, where the two slots really are competing to describe the same morning.
    for (const slot of slotsByDetector.get(derivationId) ?? []) {
      const outcomesForRule = outcomes.get(
        slotRules.get(slot.key)?.row.id ?? "",
      );
      if (!outcomesForRule?.has(slot.atMs)) continue; // expansions never need repairing
      if (claimed.has(slot.key)) continue; // already has its run
      const window = slotWindow(slot.atMs, slot.graceMinutes);
      const donor = [...claimed].find(
        ([key, run]) =>
          slotRules.get(key) === slotRules.get(slot.key) &&
          !outcomesForRule.has(recordedAt.get(key) ?? -1) &&
          run.startMs >= window.fromMs &&
          run.startMs <= window.toMs,
      );
      if (!donor) continue;
      claimed.delete(donor[0]);
      claimed.set(slot.key, donor[1]);
    }

    attribution.set(derivationId, claimed);
  }

  // ── The past, assembled from RECORDS ───────────────────────────────────────────────────────────
  //
  // 🛑 Built before any master is written, because a rule whose only occurrence is already accounted
  // for here must not ALSO be published as a schedule.
  const past: PastEvent[] = [];
  /**
   * Occurrences that already have a past event standing for them, keyed `rule:instant`.
   *
   * 🛑 Per OCCURRENCE, not per rule. A one-off that ran and was then rescheduled still carries the
   * old record, so a rule-wide set would let last month's history suppress next week's schedule.
   */
  const accountedFor = new Set<string>();

  /**
   * The INSTANTS the feed has published about, per rule — what decides whether a spent one-off is
   * also published as a schedule.
   *
   * 🛑 Neither the occurrence key nor the bare rule id is the right test, and both were tried. The
   * key alone lets a phantom master through: edit a spent one-off from 09:00 to 07:00 and the
   * record still sits at 09:00, so a check against the CURRENT start finds nothing and publishes a
   * 07:00 schedule beside the 09:00 run. The rule id alone goes too far the other way: a one-off
   * genuinely rescheduled for next week has last month's history, and that would suppress a run
   * still to come.
   *
   * What separates them is PROXIMITY. An edit describes the same morning — the published instant
   * falls inside the current occurrence's own window — while a reschedule moves it days away. So
   * the question is "has the feed already told this morning's story", and the window is the same
   * one attribution uses.
   */
  const accountedInstants = new Map<string, number[]>();
  const noteAccounted = (ruleId: string, atMs: number) =>
    accountedInstants.set(ruleId, [
      ...(accountedInstants.get(ruleId) ?? []),
      atMs,
    ]);

  for (const [derivationId, detectorName] of detectorNames) {
    const matched = attribution.get(derivationId);
    if (!matched) continue;
    // `attributeRuns` answers slot → run; the events below need run → slot.
    const slotOfRun = new Map<FeedRun, string>();
    for (const [key, run] of matched) slotOfRun.set(run, key);

    // EVERY run, scheduled or not. This is the whole point of the model: a start that happened is
    // published where it happened, as itself, and the schedule only decides what to CALL it.
    for (const run of runsByDerivation.get(derivationId) ?? []) {
      // 🛑 An OPEN run gets no event — no end instant, so no DTEND, and a generator going right now
      // is not yet a thing that happened. It reappears, complete, on the next fetch after it stops.
      if (run.endMs === null) continue;
      const closed = run as ClosedRun;
      // Pre-cutoff runs were fetched only so the matching could see them.
      if (run.startMs < sinceMs) continue;
      const start = DateTime.fromMillis(run.startMs, { zone: timezone });
      if (!start.isValid) continue; // the zone was already complained about above

      const slotKey = slotOfRun.get(run);
      const plan = slotKey ? slotRules.get(slotKey) : undefined;
      if (slotKey) accountedFor.add(slotKey);
      if (plan && slotKey)
        noteAccounted(plan.row.id, recordedAt.get(slotKey) ?? run.startMs);

      past.push({
        // 🛑 `start_time` is the row's IMMUTABLE IDENTITY — half of `derived_intervals`' primary
        // key — so it is the only stable thing to key a UID on, and it is a property of the RUN
        // rather than of any schedule. Note the consequence: a detector recompute that shifts a
        // start by seconds mints a NEW UID, and a client sees a delete plus an add rather than an
        // update. Acceptable for derived, reproducible rows; it would not be for an automation.
        uid: `run-${derivationId}-${run.startMs}@liveone.energy`,
        start,
        end: DateTime.fromMillis(closed.endMs, { zone: timezone }),
        summary: plan
          ? `✅ ${plan.row.name}`
          : `✅ ${detectorName} run (unscheduled)`,
        description: plan
          ? describeRule(plan.row, plan.trigger, plan.minutes, {
              mark: "✅",
              outcome: null,
              run: closed,
            })
          : [
              `${describeRun(closed)}.`,
              // 🛑 A claim about the SCHEDULE, not about causation. "No slot's window contains this
              // start" is what the feed knows; it does not know no automation caused it, because a
              // dispatch at the very end of a grace window can start a run just outside the window
              // its slot allows, and the feed never looks at `point_commands`.
              "No scheduled slot accounts for this run.",
            ].join("\n"),
        sequence: Math.floor(closed.endMs / 1000),
      });
    }

    // …and every RECORDED slot that no run answered for. These are the ⏭️ and ⛔️ — the two things
    // a run can never evidence, and the reason `automation_slot_outcomes` exists.
    for (const [key, atMs] of recordedAt) {
      if (matched.has(key)) continue; // a run answered for it; published above
      if (atMs < sinceMs) continue;
      const plan = slotRules.get(key);
      if (!plan || plan.derivationId !== derivationId) continue;
      const outcome = outcomes.get(plan.row.id)?.get(atMs);
      // 🛑 No record, no event. An occurrence that today's schedule expands to but the evaluator
      // never wrote about cannot be placed truthfully — the expansion moves when the schedule is
      // edited — so it is simply absent rather than published at a time it may never have had.
      if (outcome === undefined) continue;
      const mark = markForOutcome(outcome);
      if (mark === null) continue;
      // 🛑 A ⛔️ WAITS for the grace window to close. `fired` is written the moment the hub accepts
      // a dispatch, and the detector needs samples before it opens an interval — so for the minutes
      // in between there is a recorded start and no run, which is exactly the shape of a failure.
      // Publishing then would put "Did not run" on the feed while the engine was turning over.
      // A ⏭️ needs no such wait: it is a decision that nothing WILL run, not an absence of evidence.
      if (
        mark === "⛔️" &&
        nowMs <= slotWindow(atMs, plan.trigger.schedule.graceMinutes).toMs
      )
        continue;
      const at = DateTime.fromMillis(atMs, { zone: timezone });
      if (!at.isValid) continue;
      accountedFor.add(key);
      noteAccounted(plan.row.id, atMs);

      past.push({
        // The RECORDED instant, which a later schedule edit cannot move.
        uid: `slot-${plan.row.id}-${atMs}@liveone.energy`,
        start: at,
        end: at.plus({ minutes: plan.minutes }),
        summary: `${mark} ${plan.row.name}`,
        description: describeRule(plan.row, plan.trigger, plan.minutes, {
          mark,
          outcome,
          run: null,
        }),
        sequence: Math.floor(plan.row.updatedAt.getTime() / 1000),
      });
    }
  }

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

  // ── The schedules, covering the FUTURE only ────────────────────────────────────────────────────
  for (const plan of plans) {
    const { row, trigger, start, minutes, recurrence } = plan;

    // A spent one-off already told as a past event is not also a schedule. Its master would be a
    // second copy of the same occurrence — and, after a schedule edit, a copy at the wrong time.
    //
    // 🛑 `start` in the past is half the condition, and it is not decoration. A one-off that RAN and
    // was then rescheduled for tomorrow still has its old record, so a rule-wide "has some history"
    // test would suppress the master and silently drop a run that is genuinely still coming.
    const own = slotWindow(start.toMillis(), trigger.schedule.graceMinutes);
    if (
      recurrence === null &&
      start.toMillis() <= nowMs &&
      (accountedInstants.get(row.id) ?? []).some(
        (atMs) => atMs >= own.fromMs && atMs <= own.toMs,
      )
    )
      continue;

    const event = calendar.createEvent({
      // Stable across every edit, so a client updates the existing entry rather than accumulating
      // duplicates. `sequence` below is what tells it an update happened.
      id: `${row.id}@liveone.energy`,
      start,
      end: start.plus({ minutes }),
      timezone,
      summary: row.enabled ? row.name : `${row.name} (disabled)`,
      description: describeRule(row, trigger, minutes, {
        mark: null,
        outcome: null,
        run: null,
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

    if (recurrence === null) continue;

    // 🛑 EXDATE every occurrence already in the past, so the series describes the FUTURE and only
    // the future. Without this the client draws the schedule backwards over history the feed has
    // just published properly — two versions of the same morning, one of them at whatever time the
    // rule happens to say TODAY. That is the defect this whole model exists to remove.
    //
    // A second `EXDATE` property beside the owner's stored one, rather than merged into it: both
    // are honoured (proven against ical.js), and the owner's skips stay legible as theirs.
    //
    // The bound is `plan.slots`, i.e. the feed's own history window. An occurrence older than that
    // is still expanded by the client from the RRULE — bare, carrying no glyph and no claim, which
    // is just "a repeating event" rather than a statement about a run.
    const exdates = plan.exdateSlots.map((atMs) =>
      DateTime.fromMillis(atMs, { zone: timezone }).toFormat(
        "yyyyLLdd'T'HHmmss",
      ),
    );
    event.repeating(
      exdates.length === 0
        ? recurrence
        : `${recurrence}\r\nEXDATE;TZID=${timezone}:${exdates.join(",")}`,
    );
  }

  // Finally the past, after every master — so a client reading top-down meets the rule before the
  // history of it. Order is not significant to a parser; this is for the human with a text editor.
  for (const event of past)
    calendar.createEvent({
      id: event.uid,
      start: event.start,
      end: event.end,
      timezone,
      summary: event.summary,
      description: event.description,
      status: ICalEventStatus.CONFIRMED,
      sequence: event.sequence,
    });

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
  /**
   * Every past occurrence of the CURRENT rule, for EXDATE — a superset of `slots`.
   *
   * 🛑 Not the same set, and the difference is the `createdAt` floor. `slots` is floored there so a
   * run from before the rule existed cannot be LABELLED with its name. The exclusions cannot share
   * that floor: a schedule whose DTSTART precedes its own creation still generates occurrences a
   * client will draw, and leaving those unexcluded puts today's schedule back over a stretch of
   * history the feed deliberately publishes nothing about.
   */
  exdateSlots: number[];
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
  // ONE expansion, bounded by the feed window; the `createdAt` floor is then applied only to the
  // half that labels runs. `occurrencesBetween` never returns anything before DTSTART, so this is
  // bounded by the window however old the series anchor is.
  const occurrences = occurrencesBetween(
    trigger.schedule,
    timezone,
    expandFromMs,
    nowMs,
  ).map((slot) => slot.atMs);

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
      slots: occurrences
        .filter((atMs) => atMs >= attributionFloorMs)
        .map((atMs) => ({
          // Keyed by RULE and occurrence: two rules on one generator can have slots at the same
          // instant, and an instant-keyed matching silently merges them.
          key: `${row.id}:${atMs}`,
          atMs,
          graceMinutes: grace,
        })),
      exdateSlots: occurrences.filter((atMs) => atMs <= nowMs),
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

/**
 * "Ran for 28 minutes (0.5 kWh)" — the kWh only when the detector actually accumulated any.
 *
 * Takes a CLOSED run by type. An open one never reaches here: it cannot be an event, and it is no
 * longer evidence for a slot either, so the two callers below have both already excluded it.
 */
function describeRun(run: ClosedRun): string {
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
  run: ClosedRun | null;
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
    run: ClosedRun | null;
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
