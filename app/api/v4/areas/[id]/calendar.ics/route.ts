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
 * events with no time. What is NOT in it: any reading, any point value, anything about what the
 * generator actually did. A subscriber learns when the site INTENDS to run something, and nothing
 * else.
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
import { toRecurrenceLines } from "@/lib/automations/recurrence";
import type {
  AutomationRow,
  ExerciseTrigger,
} from "@/lib/db/planetscale/schema";

// The feed is a live read of the automations table; a cached response would show a subscriber a
// schedule that has already been edited.
export const dynamic = "force-dynamic";

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

  for (const row of rows) {
    const trigger = exerciseTrigger(row);
    if (!trigger) continue;

    // 🛑 LUXON, not a `Date`, and this is not a style choice.
    //
    // `ical-generator` formats a plain `Date` against a TZID using `getHours()` — the NODE
    // PROCESS's local timezone — and simply assumes the process is running in the event's zone.
    // That is true on a Melbourne laptop and false on Vercel (UTC), so the first deploy of this
    // route published every event at its UTC wall clock wearing a `TZID=Australia/Melbourne`
    // label: ten hours out, in a feed whose entire job is to say when the generator runs. The
    // unit tests passed, because they ran on the laptop.
    //
    // The luxon branch of `formatDate` calls `setZone()` and does a real conversion, which is why
    // the library lists it as an optional peer. Proven identical under TZ=UTC, America/New_York,
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
      continue;
    }
    // The requested run LENGTH is the action's value — so the block in the calendar is how long
    // the engine is being asked to run for, not an arbitrary slot.
    //
    // Through the PARSER, like the trigger above it. Drizzle's `.$type<AutomationAction>()` is a
    // compile-time convenience for writers and nothing at all at runtime (see `types.ts`), so a
    // legacy or hand-written row with `action: null` makes `row.action.kind` throw — and one bad
    // row would take out the whole feed rather than its own event.
    const action = parseAutomationAction(row.action);
    const minutes =
      action.ok &&
      action.value.kind === "point-action" &&
      action.value.action === "set_value"
        ? action.value.value
        : 30;

    const event = calendar.createEvent({
      // Stable across every edit, so a client updates the existing entry rather than accumulating
      // duplicates. `sequence` below is what tells it an update happened.
      id: `${row.id}@liveone.energy`,
      start,
      end: start.plus({ minutes }),
      timezone,
      summary: row.enabled ? row.name : `${row.name} (disabled)`,
      description: describeRule(row, trigger, minutes),
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

    const recurrence = toRecurrenceLines(trigger.schedule, timezone);
    if (recurrence !== null) event.repeating(recurrence);
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

/** The exercise trigger of a row, or null — an unparseable or charge-session row is skipped. */
function exerciseTrigger(row: AutomationRow): ExerciseTrigger | null {
  const parsed = parseAutomationTrigger(row.trigger);
  if (!parsed.ok || parsed.value.kind !== "exercise") return null;
  return parsed.value;
}

/** The event body: what it does, and what would stop it doing it. */
function describeRule(
  row: AutomationRow,
  trigger: ExerciseTrigger,
  minutes: number,
): string {
  const lines = [`Run for ${minutes} minutes.`];
  lines.push(
    `Skipped if it has already run for ${trigger.unless.minMinutes} minutes or more above ` +
      `${trigger.unless.minLoadKw} kW in the previous ${trigger.unless.withinDays} days.`,
  );
  if (!row.enabled) lines.push("This rule is currently DISABLED.");
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
