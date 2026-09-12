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
import { getVtimezoneComponent } from "@touch4it/ical-timezones";
import { Area } from "@/lib/ids";
import { loadAreaForAuth } from "@/lib/areas/http";
import { validateCalendarToken } from "@/lib/areas/calendar-tokens";
import * as store from "@/lib/automations/store";
import { parseAutomationTrigger } from "@/lib/automations/types";
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
    // A real VTIMEZONE component, not just a TZID string: Apple Calendar will otherwise place
    // every event at the wrong hour for half the year.
    timezone: { name: timezone, generator: getVtimezoneComponent },
    // An hour. The schedules change rarely, and a client that re-reads more often than this is
    // spending our request budget to learn nothing.
    ttl: 3600,
    url: request.url,
  });

  for (const row of rows) {
    const trigger = exerciseTrigger(row);
    if (!trigger) continue;

    const startMs = wallClockToMs(trigger.schedule.start, timezone);
    // The requested run LENGTH is the action's value — so the block in the calendar is how long
    // the engine is being asked to run for, not an arbitrary slot.
    const minutes =
      row.action.kind === "point-action" && row.action.action === "set_value"
        ? row.action.value
        : 30;

    const event = calendar.createEvent({
      // Stable across every edit, so a client updates the existing entry rather than accumulating
      // duplicates. `sequence` below is what tells it an update happened.
      id: `${row.id}@liveone.energy`,
      start: new Date(startMs),
      end: new Date(startMs + minutes * 60_000),
      timezone,
      summary: row.enabled ? row.name : `${row.name} (disabled)`,
      description: describeRule(row, trigger, minutes),
      // A disabled rule is shown CANCELLED rather than dropped: "it is not running this week" is
      // information a subscriber wants, and silently removing the event looks like a bug.
      status: row.enabled
        ? ICalEventStatus.CONFIRMED
        : ICalEventStatus.CANCELLED,
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

/**
 * "YYYY-MM-DDTHH:MM" in a zone → the instant.
 *
 * Two passes: read the wall clock as if it were UTC, ask what offset the zone was at that
 * approximate instant, then subtract it. The approximation only misreads the offset for a start
 * within an hour of a DST transition — and the 02:00–02:59 hour, the one that is genuinely
 * ambiguous, is refused by the parser before a schedule can ever hold it.
 */
function wallClockToMs(wallClock: string, timezone: string): number {
  const asUtc = Date.parse(`${wallClock}:00Z`);
  return asUtc - offsetMsAt(asUtc, timezone);
}

function offsetMsAt(atMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return local - atMs;
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
