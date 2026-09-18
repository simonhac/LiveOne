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

🛑 **A schedule describes the FUTURE; the past is assembled from records.** That one sentence is the
whole shape of this feed, and it was learned the hard way — see "Why the past is not part of the
series" below.

So there are two kinds of component:

- **One `VEVENT` per exercise rule**, carrying its `RRULE` and covering only occurrences still to
  come. Charge-session rules have no schedule and are omitted — an event with no time is not an
  event.
- **One standalone `VEVENT` per thing that already happened**: every generator run at the instant it
  actually ran, and every slot the evaluator recorded coming to nothing at the instant it was
  recorded for. These have their own UIDs and no relationship to any series.

The history bound is **366 days** — a year and a day.

| Property | Value | Why |
| --- | --- | --- |
| `UID` | rule: `<automation uuid>@liveone.energy` · run: `run-<derivation uuid>-<start ms>@…` · recorded slot: `slot-<automation uuid>-<slot ms>@…` | Stable across every edit, so a client updates its existing entry instead of accumulating duplicates. A past event's UID is built from the RECORD, never from the schedule. |
| `DTSTART`/`DTEND` | local wall clock, `TZID`-qualified | The run length is the action's `set_value` minutes, so the block is how long the engine is asked to run — not an arbitrary slot. |
| `RRULE`/`RDATE` | the stored rule, verbatim | Written by `toRecurrenceLines`; a one-off gets none of them (see below). |
| `EXDATE` | the owner's own skips, **plus a second property listing every past occurrence** | The synthetic one is what stops the series drawing over history the feed has already published properly. Two `EXDATE` properties rather than one merged list, so the owner's skips stay legible as theirs; both are honoured (proven against `ical.js`). |
| `SEQUENCE` | `updated_at` in epoch **seconds** | Monotonic per edit so clients pick up changes. Seconds, not ms: `SEQUENCE` is a 32-bit integer in practice. |
| `SUMMARY` | rule name, `(disabled)` suffixed; a past event is prefixed ✅/⏭️/⛔️ and named for the rule that asked for it, or `<detector> run (unscheduled)` | See the `STATUS` trap below, and "What actually happened". |
| `STATUS` | always `CONFIRMED` | See the `STATUS` trap below. |
| `DESCRIPTION` | the outcome sentence (past occurrences only) first, then run length, the unless-terms in words (omitted entirely when the rule has none), grace | Enough to answer "what is this, why might it not happen, and what did happen". The outcome leads because Calendar.app shows the start of a description in its list view. |

🛑 **There is no `RECURRENCE-ID` anywhere in this feed**, deliberately — see below.

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

Every past event carries one glyph: **✅** it ran · **⏭️** it was deliberately not started · **⛔️**
it should have started and did not.

The sources are records, and only records:

| Glyph | Comes from | Placed at |
| --- | --- | --- |
| ✅ | a row in `derived_intervals` | the run's own `start_time`/`end_time` |
| ⏭️ | `automation_slot_outcomes` — `satisfied` or `skipped-full` | the recorded `slot_at` |
| ⛔️ | `automation_slot_outcomes` — anything else terminal | the recorded `slot_at` |

**Every generator start is published**, scheduled or not. A run is titled for the rule whose slot
claims it, and `<detector> run (unscheduled)` otherwise — so a start from the generator's own panel
or from the UI appears by itself, and the year of history needed no backfill script.

🛑 **Nothing is inferred from silence.** A slot is ⛔️ because the evaluator *recorded* that it came
to nothing — never because the feed re-expanded today's schedule over last month and found no run.
The cost is real and was accepted deliberately: an occurrence decided before migration 0078 has no
record, so it is **absent** rather than published at a time it may never have had. Everything
decided from 0078 onward has a row.

🛑 **An OPEN run gets no event.** There is no end instant, so no `DTEND`. It reappears, complete, on
the first fetch after it stops.

🛑 **A ⛔️ waits for the grace window to close.** `fired` is written the moment the hub accepts a
dispatch, and the detector needs samples before it opens an interval — so for the minutes in between
there is a recorded start and no run, which is exactly the shape of a failure. Publishing then would
put *"Did not run"* on the feed while the engine was turning over. A ⏭️ needs no such wait: it is a
decision that nothing *will* run, not an absence of evidence.

🛑 **A recorded slot left empty takes its run back from an expansion of its own rule.** When a rule
is edited, the recorded instant and the occurrence today's schedule expands to are two versions of
the same morning and both reach the same run. Time order hands it to the phantom, leaving the
recorded slot unmatched — and an unmatched *recorded* slot is published as ⛔️, so the feed showed a
failure sitting beside the successful run it was describing.

A **transfer after matching**, and the two simpler rules that were tried first both broke something:

- *Recorded slots first, globally, inside `attributeRuns`* — a recorded slot on one rule then
  pre-empts an unrecorded slot on another, takes the only run that one could reach, and an ordinary
  start is published as unscheduled.
- *Drop any expansion whose window overlaps a record of the same rule* — an overlap proves possible
  competition, not shared identity. A 09:00 occurrence and a 12:00 `RDATE` overlap at three hours of
  grace, so recording only the later one discards the only thing that could name the earlier one's
  run.

The transfer discards nothing and is scoped to one rule, where the two slots really are competing to
describe the same morning.

**What is immutable, and what is not.** A past event's *instant* cannot be changed by editing a
rule — that is the guarantee, and it is the one that matters. Everything else about a past event is
recomputed from the rule's CURRENT configuration on every fetch, and that has consequences worth
stating plainly:

- Its **title** follows whichever rule's slot claims the run now. Rename a rule, or change its
  weekday, and an old event is retitled or falls back to "unscheduled".
- A recorded slot's **length** is its instant plus the rule's current `set_value` minutes.
- **Editing `graceMinutes` can make a past ⛔️ appear or disappear**, because the grace is half the
  attribution window: widen it and a recorded slot reaches a run it previously could not, so its
  published failure is replaced by that run; narrow it and the reverse.

The structural fix for all three is the same — persist the attribution with the decision (the
claimed run, or at minimum the grace and name in force at the time) rather than recomputing it — and
it needs a column on `automation_slot_outcomes`. It has not been worth a migration for one
generator, but that is the trade being made, not an oversight.

**One run per slot.** A slot claims exactly one start, and a second start inside the same grace
window becomes its own event. Two things this gets right that the obvious implementation does not:

- The matching spans **every rule on the detector at once**, not one rule at a time. Two rules with
  overlapping grace windows each see the earliest run in their own window — the same run — while a
  union pass claims two, and the second disappears. Slots are keyed by `(rule, occurrence)`, because
  two rules on one generator can have occurrences at the same instant.
- Answering "which run does this slot show" and "which runs did some slot claim" separately let a
  restart fall down the gap between them: the slot showed the first run and the restart was
  published nowhere at all.

It is greedy, earliest slot first — not always the matching with the most pairs, and deliberate:
earliest-first is a rule a reader can follow, and nothing here has enough slots to notice.

🛑 The attribution window is `exercise.ts`'s own tolerance, imported rather than restated —
`[slot − ATTRIBUTION_LEAD_MS, slot + grace + ATTRIBUTION_TAIL_MS]`. A feed with its own numbers
would eventually disagree with the evaluator about whose run a start was, publishing a disagreement
inside LiveOne as a fact about the generator.

🛑 Slots are expanded back past the cutoff by **one attribution window** (`attributionSlackMs`) — the
widest on the area, shared by every rule, because the floor decides which slots get to *compete* —
and **the reads reach back with them**. Neither half works alone: without the slots, a slot a minute
before the cutoff and its run a minute after are torn apart by the boundary and the run is
mislabelled "unscheduled"; without the wider read, that same pre-cutoff slot can see the *later* run
but not its own, and claims a run it never started. Nothing before the cutoff is ever published.

🛑 The unscheduled description says *"No scheduled slot accounts for this run"*, **not** "not started
by an automation". The feed knows the first and not the second: a dispatch made at the very end of a
grace window can start a run just outside the window the slot allows, and the feed never looks at
`point_commands` at all. Say what you checked.

## 🛑 Why the past is not part of the series

This is the second design. The first published each decided occurrence as an RFC 5545 **override** —
a second `VEVENT` with the master's `UID` and a `RECURRENCE-ID` naming the occurrence it replaced.
That is the correct mechanism for an *exceptional* occurrence, and it worked: iCloud accepted and
rendered it.

It was still wrong, for a reason worth keeping:

**An override is addressed by an instant the CURRENT rule generates.** So the past stayed hostage to
the schedule. On 17 September 2026 the Daylesford generator ran at 09:00 for 31 minutes; the rule was
then edited from 09:00 to 07:00; and the feed published a **7 a.m. event on a day nothing was ever
scheduled for 7 a.m.**, carrying the 9 a.m. run's real duration and energy. The master had moved
(a client expands an `RRULE` backwards as well as forwards), the override moved with it, and the
180-minute grace window was wide enough that the relocated slot swallowed the genuine run.

Two further points settled it:

- **Every** past occurrence gets a glyph, so every one becomes a detached instance. A mechanism
  designed for the rare edited occurrence was carrying 100% of the history.
- Change the rule to a different weekday and *every past event vanishes at once*, because no address
  exists to hang them on.

Hence: past events stand alone, at instants taken from records that a later `PATCH` cannot move
(`derived_intervals.start_time`; `automation_slot_outcomes.slot_at`, which a trigger PATCH
deliberately does not clear). The series `EXDATE`s its own past so it stops drawing over them.

Two implementation notes that look optional and are not:

- **Do not move the master's `DTSTART` forward** as a way to keep it out of the past. It looks
  equivalent to the `EXDATE` and is not: `COUNT` counts from `DTSTART`, so shifting it silently
  changes how many occurrences a `COUNT` rule has left.
- The `EXDATE` bound is the feed's own history window — and, unlike the slots used for labelling, it
  is **not** floored at the rule's `createdAt`. A schedule anchored before its own creation still
  generates occurrences a client will draw, and leaving those unexcluded puts today's schedule back
  over a stretch of history the feed deliberately publishes nothing about. An occurrence older than
  the window is still expanded by the client — bare, carrying no glyph and no claim, which is just
  "a repeating event" rather than a statement about a run.

A spent **one-off** is not published as a schedule at all once a past event stands for it: its master
would be a second copy of the same occurrence, and after an edit, a copy at the wrong time. The test
for "already told" is **proximity**, not identity — has the feed published an instant inside this
occurrence's own window — and neither cruder version works:

- Keyed by the current start, a phantom slips through: edit a spent one-off from 09:00 to 07:00 and
  the record still sits at 09:00, so the check finds nothing and publishes a 07:00 schedule beside
  the 09:00 run.
- Keyed by the rule, it goes too far: a one-off genuinely rescheduled for next week carries last
  month's history, and that would suppress a run still to come.

A one-off with nothing recorded is always published, so it cannot vanish either way.

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
