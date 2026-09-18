# The area calendar feed

Status: **current** (2026-09-18)

A subscribable iCalendar feed of an area's scheduled automations:
`GET /api/v4/areas/:id/calendar.ics?token=…`. Paste the `webcal://` form into Calendar.app, Google
Calendar or anything else that speaks iCalendar, and the site's intended generator runs appear
alongside everything else — each one, once it is past, marked with what actually happened.

The grammar those schedules are written in — and why it replaced `weekdays`+`time` — is
[automations.md](automations.md). This doc is about the FEED: its shape, its security model, and
the four production failures it took to render one event. That last part is the point. Every
broken version passed the test suite.

## What it serves

One `VEVENT` per **exercise** rule on the area (charge-session rules have no schedule and are
omitted — an event with no time is not an event), plus two kinds of event about the **past**:
an override per decided occurrence, and one per generator run no schedule accounts for. The history
bound is **366 days** — a year and a day, one bound rather than two, so a run and the slot that
explains it can never fall on opposite sides of the cutoff.

| Property | Value | Why |
| --- | --- | --- |
| `UID` | `<automation uuid>@liveone.energy` | Stable across every edit, so a client updates its existing entry instead of accumulating duplicates. |
| `DTSTART`/`DTEND` | local wall clock, `TZID`-qualified | The run length is the action's `set_value` minutes, so the block is how long the engine is asked to run — not an arbitrary slot. |
| `RRULE`/`EXDATE`/`RDATE` | the stored rule, verbatim | Written by `toRecurrenceLines`; a one-off gets none of them (see below). |
| `SEQUENCE` | `updated_at` in epoch **seconds** | Monotonic per edit so clients pick up changes. Seconds, not ms: `SEQUENCE` is a 32-bit integer in practice. |
| `SUMMARY` | rule name, `(disabled)` suffixed; a decided past occurrence is prefixed ✅/⏭️/⛔️ | See the `STATUS` trap below, and "What actually happened". |
| `STATUS` | always `CONFIRMED` | See the `STATUS` trap below. |
| `DESCRIPTION` | the outcome sentence (past occurrences only) first, then run length, the unless-terms in words (omitted entirely when the rule has none), grace | Enough to answer "what is this, why might it not happen, and what did happen". The outcome leads because Calendar.app shows the start of a description in its list view. |
| `RECURRENCE-ID` | on an OVERRIDE only: the occurrence it replaces, TZID-qualified | How a single decided occurrence of a recurring rule gets a different title. See below. |

**A one-off gets no `RRULE` at all.** Internally the evaluator expands one as `FREQ=DAILY;COUNT=1`
so it has a single code path, but that synthetic rule is stripped from the feed: a calendar client
shown `COUNT=1` renders a *repeating* event, which is a lie about a thing that happens once.

🛑 **A rule with no `unless` says nothing about skipping**, rather than describing a condition it
does not have. `unless` used to be a required field, so a one-off "run it for 10 minutes" had to
carry a threshold picked to be unreachable — and this feed rendered that number verbatim, telling
every subscriber the run would be *"Skipped if it has already run for 600 minutes or more above
1.5 kW in the previous 7 days"*. The parser now accepts the absence, and `describeRule` omits the
sentence with it.

## What actually happened

Each past occurrence carries one glyph on its title: **✅** it ran · **⏭️** it was deliberately not
started · **⛔️** it should have started and did not. Nothing at all for a future slot, or one still
inside its grace window — an undecided occurrence is left exactly as the master renders it.

The rules are in `lib/automations/calendar-marks.ts`, in this order:

1. **A run started in the slot's window → ✅**, whatever the record says. The subscriber's question
   is "did the generator run", and a human starting it at the right time answers that as well as a
   dispatch does. It also covers `aborted-complete` — supervision stopping a run that had already
   done its work is a run that happened.
2. **`satisfied` or `skipped-full` → ⏭️.** Only the evaluator's own record can say this.
3. **Past the window with neither → ⛔️.** Including *no record at all*, which is every slot decided
   before `automation_slot_outcomes` existed. "We have no idea" is not something to publish; what a
   subscriber can verify is that nothing ran.

🛑 **Two silences that look identical are not.** A ⛔️ inferred from an absent record is suppressed
for a rule that is **currently disabled**: a disabled rule is never evaluated, so every expired
occurrence has no record and no run — exactly the shape rule 3 reads as failure — and a rule
switched off for a month would fill that month with red for weeks nothing was ever going to happen
in. The flag is only a proxy (it says what is true now, not what was true then), which is why it
cannot overturn a **recorded** failure: the evaluator writing `missed` proves the rule was live at
the time, and that verdict stands however the rule was switched afterwards.

🛑 **An OPEN run gets no event but still proves its slot started.** It cannot be an event — there is
no `DTEND` to write — but discarding the row made a generator that was *running at that moment*
publish "no start was detected", because a run beginning near the end of a grace window is still
going when the window closes. Its occurrence reads ✅ *"It started, and is still running."*

**One run per slot, matched ONCE PER DETECTOR.** A slot claims exactly one start, and a second start
inside the same grace window becomes its own unscheduled event. Two things this gets right that the
obvious implementation does not:

- The two questions — "which run does this slot show" and "which runs did some slot claim" — are one
  question with one answer. Answered separately, a restart fell down the gap between them: the slot
  showed the first run and the restart was published nowhere at all. A generator that had to be
  started twice is exactly the morning a subscriber wants to see.
- The matching spans **every rule on the detector at once**, not one rule at a time. Two rules with
  overlapping grace windows each see the earliest run in their own window — the same run — while a
  union pass claims two, and the second disappears. Slots are keyed by `(rule, occurrence)`, because
  two rules on one generator can have occurrences at the same instant.

It is greedy, earliest slot first. That is not always the matching with the most pairs (a long-grace
slot can take a run a zero-grace slot needed), and it is deliberate: earliest-first is a rule a
reader can follow, and nothing here has enough slots to notice the difference.

🛑 **The window is `exercise.ts`'s own attribution tolerance, imported rather than restated** —
`[slot − ATTRIBUTION_LEAD_MS, slot + grace + ATTRIBUTION_TAIL_MS]`. A feed with its own numbers
would eventually mark a slot ⛔️ that the evaluator had already counted as run, publishing a
disagreement inside LiveOne as a fact about the generator.

### The recurring-series problem, and RFC 5545's answer

A recurring rule is **one** VEVENT with an RRULE, so there is no per-occurrence component to
retitle. The answer is an **override**: a second VEVENT with the **same UID** and a
`RECURRENCE-ID` naming the occurrence it replaces — exactly what Calendar.app writes when you edit
"this event only". The master keeps its RRULE and its plain title.

- `RECURRENCE-ID` is formatted like `DTSTART`: TZID-qualified local wall clock, built from a **luxon
  `DateTime`**, never a `Date`. The process-timezone trap in bug 1 below applies to it identically,
  and its failure is quieter: an override naming an instant no occurrence falls on is silently
  ignored, which looks exactly like the feature not shipping.
- The override's `SEQUENCE` is the **master's**. An override is not independently edited.
- 🛑 "Is this master a series?" is asked of the **recurrence lines the feed publishes**
  (`toRecurrenceLines(...) === null`), never of `schedule.rrule`. They are different questions: a
  schedule may carry `rdates` and no rrule at all, which renders as a repeating event. Reading that
  as a one-off applied one occurrence's outcome to the master — i.e. to every future occurrence —
  and, past the second occurrence, dropped the marking altogether.
- A **one-off** has no recurrence lines, so there is nothing to override: its master VEVENT is
  retitled in place — and a decided one-off drops the `(disabled)` suffix, because the evaluator disables a
  one-off in the write that consumes its last slot, so *every* spent one-off is a disabled rule and
  "✅ Top-up run (disabled)" reads as a contradiction. A standing rule, and an undecided one-off,
  keep the suffix.

### Runs nothing scheduled

Every closed run in the window that no slot can claim gets its own event: `UID`
`run-<derivation uuid>-<start ms>@liveone.energy`, the run's **actual** times, and
`✅ <detector> run (unscheduled)`. This is why the year of history needed no backfill script — the
feed reads the runs, so a start from the generator's panel next month appears by itself.

- The detector set is the union of the rules' own detectors and **every enabled generator detector
  whose owner device is in the area**, so an area with no automations at all still has a calendar.
- 🛑 The description says *"No scheduled slot accounts for this run"*, **not** "not started by an
  automation". The feed knows the first and not the second: a dispatch made at the very end of a
  grace window can start a run just outside the window the slot allows, and the feed never looks at
  `point_commands` at all. Say what you checked.
- 🛑 Slots are expanded back past the 366-day cutoff by **one attribution window**
  (`attributionSlackMs`) — the WIDEST on the area, shared by every rule, because the floor decides
  which slots get to *compete*: per-rule floors let a tight-grace rule's slot fall outside its own
  floor while a loose-grace rule's survived, and the loose one took the run the tight one should
  have had. The reads reach back with them. Neither half works alone: without
  the slots, a slot a minute before the cutoff and its run a minute after are torn apart by the
  boundary and the run is published as "unscheduled"; without the wider read, that same pre-cutoff
  slot can see the *later* run but not its own, and claims a run it never started — hiding a real
  unscheduled event. Nothing before the cutoff is ever published either way.
- `start_time` is the run row's immutable identity (half of `derived_intervals`' primary key), so it
  is the only stable thing to key a UID on. The consequence is worth knowing: a detector recompute
  that shifts a start by seconds mints a **new** UID and a client sees a delete plus an add.
  Acceptable for derived, reproducible rows; it would not be for an automation.
- **Open intervals are excluded.** A generator running right now is not yet an outcome.

### Where ⏭️ comes from

`automations.armed_context` holds only the **latest** decision, one per rule, overwritten every
tick — useless a week later. And the runs cannot supply the distinction: "deliberately skipped" and
"should have started and did not" are both *no run in the window*. So migration 0078 added
**`automation_slot_outcomes`**, one row per `(automation, slot)`, terminal decisions only. It is
written by `recordExerciseOutcome` in a **second statement** beside the rule update, deliberately
not in a transaction with it: a crash between them costs one slot's ⏭️/⛔️ distinction, and a
display nicety does not belong inside the path that decides whether a generator starts.

**What is NOT in it:** any reading, any point value. A subscriber learns when the site intends to
run something, and whether it did — never what anything measured. This reverses the feed's original
"no outcome at all" invariant, deliberately: a schedule alone left "did it actually run" to somebody
opening the app, which is the question a subscriber actually has.

## Security: the URL is the whole credential

A calendar client fetches this unattended, for years, with no way to sign in and nowhere to put a
password. So the token lives in the URL, and the URL is the credential — the same deliberate
decision as a dashboard share link, bounded the same way:

- Its own edge matcher (`isCalendarFeedRoute`), **GET/HEAD only**, in `middleware.ts`.
- Deliberately **not** added to `shareableRoutes`. That list is documented as "the handler
  authorizes with `requireDashboardAccess`", and this handler does not — it has its own table and
  its own predicate. Sharing the matcher would blur which credential belongs where.
- The handler validates the token **and** checks it belongs to the area in the path. A valid token
  proves the holder may read *some* area's calendar; without the second check the path is a free
  parameter and one subscriber reads every site.
- Every refusal — no token, bad token, another area's token, unknown area — is the **same 404**.
  The feed is fetched from anywhere on the internet; distinguishing them would make the URL an
  existence oracle over other people's sites.

`area_calendar_tokens` is a separate table from `share_tokens` because the two grant different
things: a share token grants read access to the *points* a dashboard exposes, resolved per request
against that dashboard's contents; this grants exactly one thing. Neither predicate is right for
the other.

Tokens are 20 base32 chars from `crypto.randomBytes` (~98 bits), **not** the 3-word phrase
`share_tokens` uses (~22 bits). A long-lived URL fetched by software nobody is watching has
guessability as its only protection. Managed by `liveone calendar {list,mint,revoke}` — its own CLI
domain, because what it manages is a credential, not an automation.

## 🛑 What we learned

The feed reached production **four times** before it rendered a single event in Calendar.app. Every
version passed the unit suite; three also parsed cleanly under `ical.js`, Thunderbird's parser. The
bugs are worth recording individually, but the pattern matters more than any of them: **iCalendar
fails silently, at every layer.**

### 1. A library that formats dates in the process's timezone

`ical-generator` formats a plain `Date` against a `TZID` using `getHours()` — the **Node process's**
local zone — and assumes the process runs in the event's timezone. True on a Melbourne laptop,
false on Vercel. Production published every event ten hours out, labelled `TZID=Australia/Melbourne`.

The tests asserted the correct value and passed, **because they ran where the broken code gives the
right answer.** That is the real defect. `npm test` now pins `TZ=UTC` in `package.json` — a Jest
`setupFile` is too late, Node has already cached the zone and `getHours()` keeps answering locally
(measured, not assumed). The suite passes under UTC, and the `DTSTART` assertion now *fails* against
the old code, which is the only reason to trust it.

The fix is [luxon](https://moment.github.io/luxon/), the `formatDate` branch that calls `setZone()`
and does real zone math — which is why ical-generator lists it as an optional peer.

### 2. A data file that never reached the bundle, twice

`@touch4it/ical-timezones` resolves zone data with `readFileSync(path.join(__dirname, "zones", …))`
inside an **empty catch**, returning `null`. Two separate causes, and each fix looks sufficient on
its own:

- `outputFileTracingIncludes` — a dynamic read is invisible to Next's static tracing, so the `.ics`
  data was never deployed.
- `serverExternalPackages` — with the package *bundled*, `__dirname` resolves to
  `.next/server/app/api/.../calendar.ics/`, so the join misses whatever is on disk. The files were
  shipped and **still** not found.

Both are needed. Neither is discoverable under Jest, which reads `node_modules` directly — so this
one is only ever reproducible in a deployed bundle. The generator is now wrapped so a third cause
is greppable instead of invisible; it warns rather than throws, because most clients resolve a bare
IANA `TZID` from their own database and failing the whole subscription is worse for the subscriber
than a loud log is for us. That warning guards a **real** case: the package's zone list predates the
Kiev→Kyiv rename, so luxon places such an event happily and the package has nothing to describe it
with.

### 3. `STATUS:CANCELLED` means "render nothing"

A disabled rule was published as `STATUS:CANCELLED`, on this reasoning, written in the code:

> *"A disabled rule is shown CANCELLED rather than dropped: 'it is not running this week' is
> information a subscriber wants, and silently removing the event looks like a bug."*

Apple Calendar and Google treat a cancelled event as **withdrawn and render nothing**. The status
did precisely the thing the comment said it was avoiding, and a week whose only event was a disabled
rule looked like an empty, broken feed. Disabled rules are now `CONFIRMED`, marked in the `SUMMARY`
and the `DESCRIPTION`.

### 4. iCloud accepts the fetch and silently discards the calendar

The one that actually mattered, and the hardest to see. Calendar.app's subscription info showed:

> **Last updated: Never**

…against a feed iCloud had fetched many times — the server logged every request, each a 200. With
`Location: iCloud`, Apple's *servers* do the fetching, and iCloud validates more strictly than
`ical.js` does. Two non-conformances, both from asking ical-generator for things it emits in the
wrong place:

- **`DTSTAMP` without `Z`.** RFC 5545 requires UTC. Naming a *calendar-level* timezone makes the
  library format the calendar's own properties in it, dropping the `Z`. Fixed with
  `{name: null, generator}`, which still builds the `VTIMEZONE` from each event's zone.
- **Calendar properties after the first component.** `icalbody` is calprops *then* components.
  `TIMEZONE-ID`, `X-WR-TIMEZONE`, `REFRESH-INTERVAL` and `X-PUBLISHED-TTL` all trailed
  `END:VTIMEZONE`. The first two went with `name: null`; the last two come from `ttl`, and
  `calendar.x()` lands in the same wrong spot — so **there is no conformant way to publish a
  refresh hint with this library**, and it was dropped. Little is lost: Apple ignores it in favour
  of the subscription's own Auto-refresh setting.

**`Last updated: Never` is the only symptom iCloud gives you.** No error, no partial render, no
failed request to find in the log. If a subscription looks empty, ask for that field first — it
distinguishes "rejected" from "stale" from "genuinely empty", which nothing else does.

### What now guards this

- `npm test` pins `TZ=UTC`, and there is a **CI job** (`.github/workflows/test.yml`) — the suite
  previously ran nowhere but a developer's laptop. Runners are UTC, so bug 1 would have been caught
  on the first push.
- The feed tests read the output **structurally**, not with `toContain`: `DTSTAMP` shape, and no
  calendar property after any component. Those are the assertions that would have caught bug 4.
- One test hands the feed to `ical.js` and expands the rule, which is how `EXDATE` removal and the
  4 October DST step (167 hours between occurrences, not 168) are covered at all.
- ⚠️ But note bug 4: **a reference parser is not sufficient.** `ical.js` accepted every malformed
  version. Structural assertions caught what it did not.

## Verifying by hand

```bash
liveone calendar mint <area> --label='…' --apply     # the webcal:// + https:// URLs
liveone automation upcoming <area> --days=90         # what will really happen, exdates applied
curl -s "<https URL>" | tr -d '\r'                   # read the feed as a client sees it
```

`upcoming` needs no token and expands the same module the evaluator does, so a disagreement between
it and reality is a bug in one shared place rather than a second implementation drifting from the
first. It is the fastest check that a schedule says what you meant, with or without a calendar app.
