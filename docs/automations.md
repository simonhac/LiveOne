# Automations

Status: **current** (2026-09-12)

Deferred-action rules: "do X, later, unless Y". The minutely `/api/cron/derivations` pass evaluates
every enabled row in `automations`; `lib/db/planetscale/schema.ts` is the source of truth for the
stored shapes and `lib/automations/` for the logic. This doc holds only the decisions and the
invariants — the things the code cannot say for itself.

Two trigger kinds share the table and they are near-opposites:

- **`charge-session`** is REACTIVE and STOPS something. It watches a charge already in progress and
  dispatches `turn_off` once a threshold is crossed. It arms and disarms.
- **`exercise`** is SCHEDULED and STARTS something — a diesel generator, unattended, to stop it
  glazing its bores. It never arms; `armed_context` holds a decision LOG instead.

Everything below is about the second.

## The recurrence grammar is an RFC 5545 subset

`trigger.schedule` used to be three fields — `weekdays`, `time`, `graceMinutes` — hand-evaluated
over an eight-day lookback and hand-validated in two places, with the weekday list copied four
times. It could say exactly one thing: *these weekdays, forever*. It could not say a one-off, a
fortnight, a first-Saturday, an end date, or "skip next week".

That is not a hypothetical gap. A rule **named** "one-off Sat 12 Sep" was, necessarily, a standing
weekly rule, because the grammar had no way to be anything else.

So the schedule is now `start` + an optional `rrule`, expanded by
[`rrule-temporal`](https://github.com/ggaabe/rrule-temporal) in `lib/automations/recurrence.ts` —
the only module that knows the library exists. A recurrence expander has a long tail of calendar
cases (ordinal weekdays, `BYSETPOS`, daylight saving, month-end) and hand-rolling it is what
produced the bug above.

**The subset**, whitelisted in `parseRRuleSubset`: `FREQ` (`DAILY|WEEKLY|MONTHLY|YEARLY`),
`INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` (ordinals allowed), `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`,
`WKST`, plus `EXDATE`/`RDATE` lists.

**Deliberately outside it**, and refused rather than ignored:

| Excluded | Why |
| --- | --- |
| sub-daily `FREQ` | An exercise rule that fires hourly is a fault, not a schedule. |
| `BYHOUR`/`BYMINUTE`/`BYSECOND` | Time of day comes from `start` and one place only, so "what time does this run" has exactly one answer. |
| `BYWEEKNO`/`BYYEARDAY` | Expressible, unreadable, never wanted here. |
| `RSCALE`/`SKIP` (RFC 7529) | Non-Gregorian calendars, which the area timezone model has no notion of. |

Refused, not ignored, is the load-bearing half: silently dropping a part the owner wrote would
produce a schedule they did not ask for. The whitelist runs **before** the library because the
library is lenient about parts it does not recognise — an unknown `NONSENSE=1` parses cleanly and
is discarded.

A rule is stored **canonicalised** (upper-cased, parts in whitelist order, date lists sorted and
deduped) so two spellings of the same schedule store identically.

## A one-off is a series of length one

No `rrule` at all. That is how RFC 5545 has it, and it means there is exactly one way to say "once"
rather than two that can disagree — which is why `mode: "once"` is **refused** on an exercise
trigger (422). `mode` is a charge-path concept: it decides whether a rule disarms for good after
firing, and the exercise path never arms, so nothing has ever read it there.

Internally the evaluator expands a one-off as `FREQ=DAILY;COUNT=1`, so the engine has one code
path. That synthetic rule is **not** in the calendar feed, where a repeating VEVENT would be a lie.

## The zone is the area's, and is never stored

`start`, `exdates` and `rdates` are all local wall clock in the area's `display_timezone`;
`DTSTART;TZID=<area tz>:<start>` is assembled at evaluation time. A generator's owner thinks in the
generator's local time and nothing else — and moving an area's display timezone should move its
rules with it, which is what this gives.

Consequences worth knowing:

- A weekly rule stays at 09:00 **local** across both daylight-saving transitions, so consecutive
  occurrences are 167 or 169 hours apart, not always 168.
- The `02:00–02:59` hour is **refused** for `start`. A spring-forward Sunday skips it outright, so a
  slot inside it never occurs and the rule would silently never fire. Shifting it instead would be
  us inventing a time the owner did not ask for.
- Any client rendering or expanding a schedule needs the zone, so the automations API serves
  `timezone` alongside the rows.

## An exhausted rule disables itself

When the slot being consumed is the schedule's last — a one-off that has been dealt with, a
`COUNT`/`UNTIL` series that has reached its end — the row is disabled **in the same write** that
consumes the slot, and the decision log records `final: true`. One statement, not a consume
followed by a disable: a crash between the two would leave a spent rule enabled and no longer able
to say why it never fires again.

Only a **consume** retires a rule. A `waiting` outcome (the hub declined, or a run is already in
progress) leaves the slot due, so retiring then would strand it un-fired.

## Editing a rule vs skipping one occurrence

PATCHing the trigger clears `armed_at`, `armed_context` — and, for an exercise rule, the
consumed-slot key `last_triggered_run_start`, so a rule edited inside a slot it has already dealt
with can fire again for that slot. That is the right reading of *"I changed when this runs"*.

It is the **wrong** reading of *"skip next week"*. `liveone automation skip` adds an `EXDATE`, and
the route is a whole-object replace, so it arrives as a trigger patch like any other — clearing the
key would let a slot consumed at 09:00 this morning start the engine a second time at 09:30.

So the key survives when the instants the rule generates are unchanged: same `start`, same `rrule`.
`EXDATE`/`RDATE` change which of those instants survive, not where they fall; `graceMinutes` and
`unless` are not about timing at all.

## The subscribable calendar

`GET /api/v4/areas/:id/calendar.ics?token=…` is an iCalendar feed of an area's scheduled
automations, built with `ical-generator` and carrying a real `VTIMEZONE` (without it Apple Calendar
places every event an hour out for half the year).

**Scope.** One VEVENT per *exercise* rule — charge-session rules have no schedule. A disabled rule
is still published, suffixed `(disabled)` in its summary, because "it is not running this week" is
information a subscriber wants. 🛑 It is `STATUS:CONFIRMED`, **not** `STATUS:CANCELLED`: Apple
Calendar and Google treat a cancelled event as withdrawn and render nothing at all, so the first
version of this hid the very event it meant to show, and a week containing only a disabled rule
looked like a broken feed. `SEQUENCE` is the row's `updated_at` in epoch seconds, so clients pick
up edits instead of accumulating duplicates. `X-PUBLISHED-TTL` is an hour.

**What is NOT in it:** any reading, any point value, any outcome. A subscriber learns when the site
*intends* to run something, and nothing else.

**Auth is a feed token** (`area_calendar_tokens`, `lib/areas/calendar-tokens.ts`), not a session —
because a calendar client fetches the URL unattended for years and has no way to sign in. That
makes the URL the entire credential, which is the same deliberate security decision as a dashboard
share link, and is bounded the same way: its own edge matcher, GET/HEAD only, validated in-handler.

Two things follow, and neither is optional:

- The token is ~98 bits (20 base32 chars from `crypto.randomBytes`), **not** the 3-word phrase
  `share_tokens` uses. A long-lived URL fetched by software that nobody is watching has
  guessability as its only protection.
- The handler checks the token is valid **and** that it belongs to the area in the path. A valid
  token proves the holder may read *some* area's calendar; without the second check the path is a
  free parameter and one subscriber reads every site.

A separate table from `share_tokens` on purpose: a share token grants read access to the *points* a
dashboard exposes, resolved per request against that dashboard's contents. This grants exactly one
thing. Neither predicate would be correct for the other.

Every refusal — no token, bad token, another area's token, unknown area — is the same 404. The feed
is fetched from anywhere on the internet, so distinguishing them would make the URL an existence
oracle over other people's sites.

## Operating it

`liveone automation` creates and edits the rules; `liveone calendar` manages the feed tokens. Two
domains rather than one because the second manages a **credential**, not an automation.

```bash
liveone automation create-exercise <area> --start='2026-09-17 09:00' \
  --rrule='FREQ=WEEKLY;BYDAY=TH' --minutes=30 --derivation=… --load-point=… --action-point=…
liveone automation upcoming <area> --days=90      # what will ACTUALLY happen, exdates applied
liveone automation skip <area> <rule> --date=2026-09-24
liveone calendar mint <area> --label='simon iphone' --apply
```

`upcoming` expands the same module the evaluator does, so a disagreement between it and reality is
a bug in one shared place rather than a second implementation drifting from the first. It needs no
token, and is the verification tool when there is no calendar client to hand.
