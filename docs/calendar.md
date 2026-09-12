# The area calendar feed

Status: **current** (2026-09-12)

A subscribable iCalendar feed of an area's scheduled automations:
`GET /api/v4/areas/:id/calendar.ics?token=…`. Paste the `webcal://` form into Calendar.app, Google
Calendar or anything else that speaks iCalendar, and the site's intended generator runs appear
alongside everything else.

The grammar those schedules are written in — and why it replaced `weekdays`+`time` — is
[automations.md](automations.md). This doc is about the FEED: its shape, its security model, and
the four production failures it took to render one event. That last part is the point. Every
broken version passed the test suite.

## What it serves

One `VEVENT` per **exercise** rule on the area. Charge-session rules have no schedule and are
omitted — an event with no time is not an event.

| Property | Value | Why |
| --- | --- | --- |
| `UID` | `<automation uuid>@liveone.energy` | Stable across every edit, so a client updates its existing entry instead of accumulating duplicates. |
| `DTSTART`/`DTEND` | local wall clock, `TZID`-qualified | The run length is the action's `set_value` minutes, so the block is how long the engine is asked to run — not an arbitrary slot. |
| `RRULE`/`EXDATE`/`RDATE` | the stored rule, verbatim | Written by `toRecurrenceLines`; a one-off gets none of them (see below). |
| `SEQUENCE` | `updated_at` in epoch **seconds** | Monotonic per edit so clients pick up changes. Seconds, not ms: `SEQUENCE` is a 32-bit integer in practice. |
| `SUMMARY` | rule name, `(disabled)` suffixed | See the `STATUS` trap below. |
| `STATUS` | always `CONFIRMED` | See the `STATUS` trap below. |
| `DESCRIPTION` | run length, the unless-terms in words, grace | Enough to answer "what is this and why might it not happen". |

**A one-off gets no `RRULE` at all.** Internally the evaluator expands one as `FREQ=DAILY;COUNT=1`
so it has a single code path, but that synthetic rule is stripped from the feed: a calendar client
shown `COUNT=1` renders a *repeating* event, which is a lie about a thing that happens once.

**What is NOT in it:** any reading, any point value, any outcome. A subscriber learns when the site
*intends* to run something, and nothing else.

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
