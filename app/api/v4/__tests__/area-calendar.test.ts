/**
 * ROUTE-level tests for the subscribable calendar feed and its tokens.
 *
 * The things only a route test can pin:
 *
 *  1. 🛑 **A valid token is not enough — it must be THIS area's.** The feed is authenticated by a
 *     URL, so the path and the credential arrive together and independently; without the second
 *     check, any token would read any area's schedule by editing the path.
 *  2. 🛑 **Every refusal is the same 404.** The feed is fetched by software from anywhere on the
 *     internet, so distinguishing "no such area" from "not your token" would make the URL an
 *     existence oracle over other people's sites.
 *  3. **The feed carries schedules and nothing else.** A subscriber learns when the site INTENDS
 *     to run something. No reading, no point value, no outcome.
 *  4. **Minting is session-authorized, not token-authorized** — a credential that could mint its
 *     own successor could never be fully revoked.
 *
 * 🛑 The DTSTART assertions below only mean anything because `npm test` pins `TZ=UTC`. The first
 * deploy of this route published every event ten hours out — `ical-generator` formats a plain
 * `Date` against a TZID using the NODE PROCESS's local zone — and these tests stayed green,
 * because they ran on a laptop in Australia/Melbourne where that happens to give the right answer.
 * Do not run this suite with a bare `jest`, and do not "simplify" the pin out of package.json.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import ICAL from "ical.js";
import { NextRequest, NextResponse } from "next/server";
import { Area, Automation, Derivation, Point } from "@/lib/ids";

const AREA = Area.generate();
const AREA_UUID = Area.toUuid(AREA);
const OTHER_AREA = Area.generate();
const OTHER_AREA_UUID = Area.toUuid(OTHER_AREA);
const DX_UUID = Derivation.toUuid(Derivation.generate());
const LOAD_PT_UUID = Point.toUuid(Point.generate());
const ACT_PT_UUID = Point.toUuid(Point.generate());
const AU = Automation.generate();
const AU_UUID = Automation.toUuid(AU);
const TZ = "Australia/Melbourne";
const TOKEN = "bcdfghjkmnpqrstvwxyz";

jest.mock("@/lib/areas/http", () => ({
  loadAreaForOwner: jest.fn(),
  loadAreaForAuth: jest.fn(),
}));
jest.mock("@/lib/areas/calendar-tokens", () => ({
  validateCalendarToken: jest.fn(),
  mintCalendarToken: jest.fn(),
  listCalendarTokens: jest.fn(),
  revokeCalendarToken: jest.fn(),
}));
jest.mock("@/lib/automations/store", () => ({
  listForArea: jest.fn(),
  intervalsOverlapping: jest.fn(),
  listSlotOutcomesForAutomations: jest.fn(),
}));
jest.mock("@/lib/derivations/resolve", () => ({
  listGeneratorDetectorsForArea: jest.fn(),
  derivationNames: jest.fn(),
}));
// The per-area overlay is a DB read; here the rows already carry the area's figures, so it is the
// identity. What it does is pinned where it lives (the run-periods route tests).
jest.mock("@/lib/run-tracking/area-provenance", () => ({
  withAreaProvenance: jest.fn(async (rows: unknown) => rows),
}));

import { loadAreaForAuth, loadAreaForOwner } from "@/lib/areas/http";
import {
  listCalendarTokens,
  mintCalendarToken,
  revokeCalendarToken,
  validateCalendarToken,
} from "@/lib/areas/calendar-tokens";
import * as store from "@/lib/automations/store";
import {
  derivationNames,
  listGeneratorDetectorsForArea,
} from "@/lib/derivations/resolve";
import type {
  AutomationRow,
  DerivedInterval,
  ExerciseOutcome,
  ExerciseTrigger,
} from "@/lib/db/planetscale/schema";
import { GET as FEED } from "../areas/[id]/calendar.ics/route";
import {
  DELETE as REVOKE,
  GET as LIST,
  POST as MINT,
} from "../areas/[id]/calendar-tokens/route";

const mockAreaAuth = jest.mocked(loadAreaForAuth);
const mockAreaOwner = jest.mocked(loadAreaForOwner);
const mockValidate = jest.mocked(validateCalendarToken);
const mockMint = jest.mocked(mintCalendarToken);
const mockList = jest.mocked(listCalendarTokens);
const mockRevoke = jest.mocked(revokeCalendarToken);
const mockStore = jest.mocked(store);
const mockDetectors = jest.mocked(listGeneratorDetectorsForArea);
const mockNames = jest.mocked(derivationNames);

/**
 * 🛑 The feed now reads the CLOCK — it expands each rule's past occurrences and marks them — so
 * every assertion below about how many events there are is a statement about "now". Pinned here,
 * not left to the machine's date, for `exercise.ts`'s reason: every interesting case is a clock
 * case. The default sits BEFORE the fixture's first occurrence, so a test that says nothing about
 * outcomes gets the same feed it always did.
 */
const NOW_BEFORE_FIRST_SLOT = Date.parse("2026-09-16T00:00:00+10:00");
const SLOT_17_SEP = Date.parse("2026-09-17T09:00:00+10:00");
let nowMs = NOW_BEFORE_FIRST_SLOT;
const setNow = (ms: number) => {
  nowMs = ms;
};

/** A closed `derived_intervals` row, as `intervalsOverlapping` returns it. */
const runRow = (startMs: number, minutes = 30, energyKwh = 0.5) =>
  ({
    derivationId: DX_UUID,
    startTime: new Date(startMs),
    endTime: new Date(startMs + minutes * 60_000),
    durationSeconds: minutes * 60,
    energyKwh,
  }) as DerivedInterval;

/** The VEVENT blocks of a feed body, unfolded, in order. */
const vevents = (body: string) =>
  unfold(body)
    .split("BEGIN:VEVENT")
    .slice(1)
    .map((block) => block.slice(0, block.indexOf("END:VEVENT")));

const exerciseRow = (over: Partial<AutomationRow> = {}): AutomationRow =>
  ({
    id: AU_UUID,
    areaId: AREA_UUID,
    name: "Generator exercise",
    enabled: true,
    mode: "standing",
    trigger: {
      kind: "exercise",
      source: { kind: "derivation", derivationId: DX_UUID },
      schedule: {
        start: "2026-09-17T09:00",
        rrule: "FREQ=WEEKLY;BYDAY=TH",
        exdates: ["2026-09-24T09:00"],
        graceMinutes: 180,
      },
      unless: {
        loadPointId: LOAD_PT_UUID,
        minMinutes: 30,
        minLoadKw: 1.5,
        dipToleranceSeconds: 180,
        withinDays: 7,
      },
    },
    action: {
      kind: "point-action",
      pointId: ACT_PT_UUID,
      action: "set_value",
      value: 30,
    },
    armedAt: null,
    lastTriggeredAt: null,
    lastTriggeredRunStart: null,
    armedContext: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-10T03:04:05Z"),
    revision: 3,
    ...over,
  }) as AutomationRow;

/**
 * Undo RFC 5545 line folding.
 *
 * A long DESCRIPTION is wrapped at 75 octets with a leading space on the continuation, so a naive
 * `toContain` on any sentence in it fails for reasons that have nothing to do with the content.
 */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

const feed = (areaId: string, query: string) =>
  FEED(
    new NextRequest(
      `https://liveone.energy/api/v4/areas/${areaId}/calendar.ics${query}`,
    ),
    { params: Promise.resolve({ id: areaId }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockValidate.mockResolvedValue({ areaUuid: AREA_UUID });
  mockAreaAuth.mockResolvedValue({
    id: AREA_UUID,
    displayName: "Daylesford",
    displayTimezone: TZ,
    ownerClerkUserId: "user_simon",
  } as never);
  mockAreaOwner.mockResolvedValue({
    userId: "user_simon",
    isAdmin: false,
    area: { id: AREA_UUID, displayName: "Daylesford", displayTimezone: TZ },
  } as never);
  mockStore.listForArea.mockResolvedValue([exerciseRow()]);
  mockStore.intervalsOverlapping.mockResolvedValue([]);
  mockStore.listSlotOutcomesForAutomations.mockResolvedValue(new Map());
  mockDetectors.mockResolvedValue([{ id: DX_UUID, name: "Generator" }]);
  mockNames.mockResolvedValue(new Map());
  nowMs = NOW_BEFORE_FIRST_SLOT;
  jest.spyOn(Date, "now").mockImplementation(() => nowMs);
});

describe("GET …/calendar.ics", () => {
  it("serves a VCALENDAR with one VEVENT per exercise rule", async () => {
    const res = await feed(AREA, `?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    const body = await res.text();

    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("NAME:Daylesford automations");
    expect(body).toContain(`UID:${AU_UUID}@liveone.energy`);
    expect(body).toContain("SUMMARY:Generator exercise");
    // 🛑 The regression assertion. Local wall clock, TZID-qualified. Under TZ=UTC the pre-luxon
    // code emitted `20260916T230000` here — the UTC wall clock wearing a Melbourne label.
    expect(body).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
    expect(body).toContain(`DTEND;TZID=${TZ}:20260917T093000`);
    expect(body).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");
    expect(body).toContain(`EXDATE;TZID=${TZ}:20260924T090000`);
  });

  // 🛑 The assertions above are `toContain` on a string, which is how three broken feeds reached
  // production looking fine. These hand the output to a REFERENCE PARSER (ical.js, Thunderbird's)
  // and ask what it actually sees — the question a subscriber's client is really asking.
  it("parses as valid iCalendar, on the right instants", async () => {
    const raw = await (await feed(AREA, `?token=${TOKEN}`)).text();
    const comp = new ICAL.Component(ICAL.parse(raw));
    const events = comp
      .getAllSubcomponents("vevent")
      .map((ve) => new ICAL.Event(ve));

    expect(events).toHaveLength(1);
    const weekly = events[0];
    expect(weekly.summary).toBe("Generator exercise");
    expect(weekly.startDate.zone.tzid).toBe(TZ);
    expect(weekly.startDate.toString()).toBe("2026-09-17T09:00:00");
    expect(weekly.isRecurring()).toBe(true);

    // Expanded by the parser, which is the only way to know a CLIENT will land where we meant.
    // Two things are pinned here and neither is visible in the raw text:
    //   - 24 Sep is absent. That is the fixture's EXDATE actually removing an instance.
    //   - 8 Oct is 22:00Z, not 23:00Z. The 4 Oct DST change moves the ABSOLUTE instant while
    //     09:00 local stands still, so consecutive occurrences are 167 hours apart there, not
    //     168. An event that merely looked right in September would silently drift.
    const iter = weekly.iterator();
    const occ: string[] = [];
    for (let i = 0; i < 4; i++) occ.push(iter.next().toJSDate().toISOString());
    expect(occ).toEqual([
      "2026-09-16T23:00:00.000Z", // Thu 17 Sep 09:00 AEST
      "2026-09-30T23:00:00.000Z", // Thu  1 Oct 09:00 AEST (24 Sep excluded)
      "2026-10-07T22:00:00.000Z", // Thu  8 Oct 09:00 AEDT
      "2026-10-14T22:00:00.000Z", // Thu 15 Oct 09:00 AEDT
    ]);
  });

  it("stamps DTSTAMP in UTC, as the RFC requires", async () => {
    // A calendar-level `timezone` makes ical-generator drop the `Z` here, which is invalid and is
    // exactly the kind of thing a strict client may reject the event over.
    const raw = await (await feed(AREA, `?token=${TOKEN}`)).text();
    for (const line of raw.split("\r\n").filter((l) => l.startsWith("DTSTAMP")))
      expect(line).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/);
  });

  it("puts every calendar property BEFORE the first component", async () => {
    // Properties trailing a component is not legal iCalendar. Naming the calendar timezone
    // emitted TIMEZONE-ID and X-WR-TIMEZONE after END:VTIMEZONE.
    const lines = (await (await feed(AREA, `?token=${TOKEN}`)).text()).split(
      "\r\n",
    );
    const firstComponent = lines.findIndex(
      (l) => l.startsWith("BEGIN:V") && l !== "BEGIN:VCALENDAR",
    );
    const strays = lines
      .slice(firstComponent)
      .filter((l) =>
        /^(TIMEZONE-ID|X-WR-|REFRESH-INTERVAL|X-PUBLISHED-TTL|NAME:|URL:|PRODID|VERSION)/.test(
          l,
        ),
      );
    expect(strays).toEqual([]);
  });

  it("ships a real VTIMEZONE", async () => {
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // Without the VTIMEZONE component a client cannot resolve the TZID on every DTSTART above.
    expect(body).toContain("BEGIN:VTIMEZONE");
    expect(body).toContain(`TZID:${TZ}`);
    // 🛑 And NO refresh hint: it is the only thing that emits calendar properties after a
    // component, which is not legal iCalendar. Clients poll on their own schedule.
    expect(body).not.toContain("X-PUBLISHED-TTL");
    expect(body).not.toContain("REFRESH-INTERVAL");
  });

  it("🛑 says so LOUDLY when a zone has no VTIMEZONE data", async () => {
    // Not hypothetical: the package's zone list predates the Kiev→Kyiv rename, so luxon places
    // the event happily and the package has nothing to describe the zone with. It reports that
    // and a missing data FILE as the same silent null, which is how a VTIMEZONE-less feed shipped
    // twice without a word.
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    mockAreaAuth.mockResolvedValue({
      id: AREA_UUID,
      displayName: "Daylesford",
      displayTimezone: "Europe/Kyiv",
      ownerClerkUserId: "user_simon",
    } as never);

    const res = await feed(AREA, `?token=${TOKEN}`);
    const body = await res.text();

    // Degraded, not dead: most clients resolve a bare IANA TZID from their own database, and
    // failing the whole subscription would be worse for the subscriber than a loud log is for us.
    expect(res.status).toBe(200);
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).not.toContain("BEGIN:VTIMEZONE");
    expect(err.mock.calls.flat().join(" ")).toContain("no VTIMEZONE");
    err.mockRestore();
  });

  it("omits an event whose zone cannot place it, rather than 500ing the feed", async () => {
    // An area with a nonsense display_timezone yields an invalid DateTime, and `createEvent`
    // THROWS on one — so a single misconfigured row would take out the whole subscription.
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    mockAreaAuth.mockResolvedValue({
      id: AREA_UUID,
      displayName: "Daylesford",
      displayTimezone: "Mars/Olympus_Mons",
      ownerClerkUserId: "user_simon",
    } as never);

    const res = await feed(AREA, `?token=${TOKEN}`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).not.toContain("BEGIN:VEVENT");
    expect(err.mock.calls.flat().join(" ")).toContain(
      "omitting it from the feed",
    );
    err.mockRestore();
  });

  // Renamed from "carries the schedule and NOTHING about readings". Run OUTCOMES are now in the
  // feed deliberately; point values still are not, and that is the line this guards.
  it("carries no point values", async () => {
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain("Will run for 30 minutes");
    expect(body).not.toContain(LOAD_PT_UUID);
    expect(body).not.toContain(ACT_PT_UUID);
  });

  it("states the skip condition when the rule has one — in the FUTURE tense, on a schedule", async () => {
    const body = unfold(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(body).toContain(
      "Will be skipped if it has already run for 30 minutes or more above 1.5 kW in the previous 7 days.",
    );
    expect(body).toContain("A missed start will stay due for 180 minutes.");
    // The heading belongs to a DECIDED occurrence's terms, never to the schedule itself.
    expect(body).not.toContain("Criteria:");
  });

  it("🛑 says NOTHING about skipping when the rule has no skip condition", async () => {
    // This is what the feed used to publish for a one-off, because `unless` was required and the
    // only way to neutralise it was an unreachable threshold: "Skipped if it has already run for
    // 600 minutes or more above 1.5 kW in the previous 7 days." That sentence went to every
    // subscriber and described a rule that nothing could skip.
    const { unless: _dropped, ...trigger } = exerciseRow()
      .trigger as ExerciseTrigger;
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({ trigger: trigger as ExerciseTrigger }),
    ]);
    const body = unfold(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(body).toContain("Will run for 30 minutes.");
    expect(body).not.toContain("skipped if");
    // The grace line is not part of the skip condition and must survive without it.
    expect(body).toContain("A missed start will stay due for 180 minutes.");
  });

  it("🛑 marks a disabled rule in the SUMMARY and leaves it CONFIRMED, never CANCELLED", async () => {
    // Apple Calendar and Google treat STATUS:CANCELLED as withdrawn and render NOTHING. Emitting
    // it for a disabled rule made a week whose only event was one look empty and broken — the
    // precise outcome showing the event was meant to prevent.
    mockStore.listForArea.mockResolvedValue([exerciseRow({ enabled: false })]);
    const body = unfold(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(body).not.toContain("STATUS:CANCELLED");
    expect(body).toContain("STATUS:CONFIRMED");
    expect(body).toContain("SUMMARY:Generator exercise (disabled)");
    expect(body).toContain("This rule is currently DISABLED.");
  });

  it("emits an unrepeated VEVENT for a one-off", async () => {
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-12T09:00", graceMinutes: 180 },
        },
      }),
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // 🛑 NOT `FREQ=DAILY;COUNT=1`. That synthetic rule exists for the evaluator's single code
    // path; in a calendar client it would render as a repeating event.
    const vevent = body.slice(body.indexOf("BEGIN:VEVENT"));
    expect(vevent).not.toContain("RRULE:");
  });

  it("omits charge-session rules — they have no schedule", async () => {
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        trigger: {
          kind: "charge-session",
          source: { kind: "point", pointId: LOAD_PT_UUID },
          afterMinutes: 60,
        } as never,
      }),
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).not.toContain("BEGIN:VEVENT");
  });

  it("bumps SEQUENCE with the row's updated_at, so clients pick up edits", async () => {
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain(
      `SEQUENCE:${Math.floor(Date.parse("2026-09-10T03:04:05Z") / 1000)}`,
    );
  });

  it("404s with no token at all, without touching the database", async () => {
    expect((await feed(AREA, "")).status).toBe(404);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockStore.listForArea).not.toHaveBeenCalled();
  });

  it("404s an invalid token", async () => {
    mockValidate.mockResolvedValue(null);
    expect((await feed(AREA, "?token=nope")).status).toBe(404);
  });

  it("🛑 404s a VALID token belonging to a DIFFERENT area", async () => {
    // The token is good — it just is not this area's. Without this check the path is a free
    // parameter and one subscriber reads every site.
    mockValidate.mockResolvedValue({ areaUuid: OTHER_AREA_UUID });
    const res = await feed(AREA, `?token=${TOKEN}`);
    expect(res.status).toBe(404);
    expect(mockStore.listForArea).not.toHaveBeenCalled();
  });

  // 🛑 The token IS the credential for this route, so echoing the request URL into the body makes
  // every exported or forwarded copy of the .ics file a working subscription.
  it("🛑 names the feed in URL: without leaking the token into the body", async () => {
    const body = await (await feed(AREA, "?token=supersecret")).text();
    expect(body).not.toContain("supersecret");
    // Unfolded first: RFC 5545 breaks a content line at 75 octets and continues it with a leading
    // space, and this URL is longer than that — so a naive substring match on the raw body would
    // fail even when the property is perfectly correct.
    const unfolded = body.replace(/\r\n /g, "");
    expect(unfolded).toContain(
      `URL:https://liveone.energy/api/v4/areas/${AREA}/calendar.ics`,
    );
  });

  // Drizzle's `.$type<>()` is compile-time only (see `lib/automations/types.ts`), so a legacy or
  // hand-written row can hold anything. The trigger was already parsed; the action was not, and
  // `row.action.kind` on a null threw — taking out the whole feed rather than one event.
  it("🛑 survives a row whose action JSON is malformed, and still serves the others", async () => {
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({ id: AU_UUID, action: null as never }),
      exerciseRow({
        id: "b2c3d4e5-0000-4000-8000-000000000002",
        name: "Second exercise",
      }),
    ]);
    const res = await feed(AREA, `?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The good row is served...
    expect(body).toContain("SUMMARY:Second exercise");
    // ...and the malformed one still gets an event, with the fallback duration rather than a throw.
    expect(body).toContain("SUMMARY:Generator exercise");
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  });

  it("404s a malformed area id, indistinguishably", async () => {
    expect((await feed("not-an-area", `?token=${TOKEN}`)).status).toBe(404);
  });
});

/**
 * The past, at the ROUTE level.
 *
 * 🛑 The model these pin: **a schedule describes the future; the past is assembled from records.**
 * Every generator start becomes a standalone event at the instant it actually happened, and every
 * slot the evaluator recorded coming to nothing becomes one at the instant it was recorded for.
 * The master series EXDATEs its own past so it stops drawing over that history.
 *
 * This replaced a `RECURRENCE-ID` override design, and the reason is the test named "🛑 editing the
 * schedule does not move a run that already happened" below: an override is addressed by an instant
 * the CURRENT rule generates, so editing the rule moved history — a 9 a.m. run was published as a
 * 7 a.m. one, with its real duration attached.
 */
describe("GET …/calendar.ics — what actually happened", () => {
  const master = (body: string) =>
    vevents(body).find((ve) => ve.includes("RRULE:"));
  const past = (body: string) =>
    vevents(body).filter((ve) => /UID:(run|slot)-/.test(ve));
  const exdatesOf = (ve: string) =>
    [...ve.matchAll(/EXDATE;TZID=[^:]+:([^\n]*)/g)].flatMap((m) =>
      m[1].trim().split(","),
    );

  /** A decided slot, as `listSlotOutcomesForAutomations` returns it. */
  const decided = (slotAtMs: number, outcome: ExerciseOutcome) =>
    new Map([[AU_UUID, new Map([[slotAtMs, outcome]])]]);

  const afterTheSlot = () => setNow(Date.parse("2026-09-18T09:00:00+10:00"));

  it("🛑 publishes a run as a STANDALONE event, and EXDATEs the occurrence it answered", async () => {
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 60_000, 31, 0.5),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();

    // 🛑 No override anywhere. The past is not part of the series any more.
    expect(body).not.toContain("RECURRENCE-ID");

    const [event, ...rest] = past(body);
    expect(rest).toEqual([]);
    expect(event).toContain(
      `UID:run-${DX_UUID}-${SLOT_17_SEP + 60_000}@liveone.energy`,
    );
    expect(event).toContain("SUMMARY:✅ Generator exercise");
    expect(event).toContain(`DTSTART;TZID=${TZ}:20260917T090100`);
    expect(event).toContain("Ran for 31 minutes (0.5 kWh).");

    // The rule's terms follow under a heading, in the PAST tense — and without the grace line,
    // which only ever mattered before the fact.
    expect(event).toContain(
      "Ran for 31 minutes (0.5 kWh).\\n\\nCriteria:\\nWas scheduled to run for 30 minutes.\\n" +
        "Would have been skipped if it had already run for 30 minutes or more above 1.5 kW in " +
        "the previous 7 days.",
    );
    expect(event).not.toContain("stay");
    expect(event).not.toContain("Will ");

    // The master keeps its rule and its plain title, and stops drawing 17 Sep itself.
    expect(master(body)).toContain("SUMMARY:Generator exercise");
    expect(master(body)).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");
    expect(exdatesOf(master(body)!)).toContain("20260917T090000");
  });

  it("states a run's cost and CO₂ beside its energy", async () => {
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      {
        ...runRow(SLOT_17_SEP + 60_000, 57, 4.4),
        costC: 312,
        emissionsG: 4100,
        estimatedKwh: 0,
      } as DerivedInterval,
    ]);
    const [event] = past(await (await feed(AREA, `?token=${TOKEN}`)).text());
    // RFC 5545 escapes a comma in TEXT as `\\,`.
    expect(event).toContain(
      "Ran for 57 minutes (4.4 kWh\\, $3.12\\, 4.1 kg CO₂).",
    );
  });

  it("🛑 omits a cost that covers only part of the run's energy, rather than understating it", async () => {
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      {
        ...runRow(SLOT_17_SEP + 60_000, 57, 4.4),
        costC: 40, // priced over 1.4 of 4.4 kWh — a confident "$0.40" would be silently wrong
        emissionsG: 497,
        estimatedKwh: 3.0,
      } as DerivedInterval,
    ]);
    const [event] = past(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(event).toContain("Ran for 57 minutes (4.4 kWh\\, 497 g CO₂).");
    expect(event).not.toContain("$");
  });

  it("🛑 editing the schedule does not move a run that already happened", async () => {
    // The defect that killed the override design, reproduced from prod: the generator ran at
    // 09:00 on 17 Sep, the schedule was then changed to 07:00, and the feed published the 9 a.m.
    // run — with its real 31-minute duration — as a 7 a.m. event, on a day nothing was ever
    // scheduled for 7 a.m.
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: {
            start: "2026-09-17T07:00", // edited AFTER the run
            rrule: "FREQ=WEEKLY;BYDAY=TH",
            graceMinutes: 180,
          },
        },
      }),
    ]);
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP, 31, 0.5), // 09:00, where it really ran
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();

    // The event sits where the generator ran, NOT where the rule now says.
    const [event] = past(body);
    expect(event).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
    expect(event).not.toContain(`DTSTART;TZID=${TZ}:20260917T070000`);
    expect(event).toContain("SUMMARY:✅ Generator exercise");
    // …and the new 7 a.m. occurrence is excluded, so nothing is drawn twice.
    expect(exdatesOf(master(body)!)).toContain("20260917T070000");
    expect(body).not.toContain("RECURRENCE-ID");
  });

  it("🛑 an edited schedule does not put a ⛔️ beside the run it describes", async () => {
    // The recorded 09:00 slot and the phantom 07:00 one both reach the 09:00 run. Served in time
    // order the phantom takes it, leaving the recorded slot unmatched — and an unmatched recorded
    // slot is published as ⛔️. The feed would show "Did not run" next to the successful run.
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: {
            start: "2026-09-17T07:00", // edited AFTER the run
            rrule: "FREQ=WEEKLY;BYDAY=TH",
            graceMinutes: 180,
          },
        },
      }),
    ]);
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "fired"), // recorded at 09:00, where it really was
    );
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP, 31, 0.5),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).not.toContain("⛔️");
    expect(past(body)).toHaveLength(1);
    expect(past(body)[0]).toContain("SUMMARY:✅ Generator exercise");
    expect(past(body)[0]).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
  });

  it("🛑 a `fired` slot is not called a failure before the detector has caught up", async () => {
    // `fired` is written the moment the hub accepts a dispatch; the detector needs samples before
    // it opens an interval. For the minutes in between there is a record and no run — exactly the
    // shape of a failure — and publishing then puts "Did not run" on the feed while the engine is
    // turning over.
    setNow(SLOT_17_SEP + 60_000); // one minute in, deep inside the 180-minute grace
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "fired"),
    );

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(body)).toEqual([]);

    // …and once the window has closed with still nothing detected, it IS a failure.
    setNow(SLOT_17_SEP + 200 * 60_000);
    const later = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(later)[0]).toContain("SUMMARY:⛔️ Generator exercise");
  });

  it("🛑 a ⏭️ needs no such wait — it is a decision, not an absence of evidence", async () => {
    setNow(SLOT_17_SEP + 60_000);
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "satisfied"),
    );
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(body)[0]).toContain("SUMMARY:⏭️ Generator exercise");
  });

  it("🛑 a one-off RESCHEDULED for the future is still published as a schedule", async () => {
    // Its old record still produces a past event, so a rule-wide "has some history" test would
    // suppress the master and silently drop a run that is genuinely still coming.
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        enabled: true,
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-25T09:00", graceMinutes: 180 }, // moved forward
        },
      }),
    ]);
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "missed"), // what happened the first time round
    );

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain(`UID:${AU_UUID}@liveone.energy`);
    expect(body).toContain(`DTSTART;TZID=${TZ}:20260925T090000`);
    // …and the old attempt is still on the record, at its own instant.
    expect(past(body)[0]).toContain("SUMMARY:⛔️ Generator exercise");
    expect(past(body)[0]).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
  });

  it("🛑 …and still published once its NEW occurrence arrives but is undecided", async () => {
    // `accountedFor` is keyed by OCCURRENCE, not by rule. Keyed by rule, the 17 Sep record would
    // suppress the master the moment the 25 Sep occurrence came round — and with its own ⛔️ still
    // correctly withheld inside grace, the rule would vanish from the feed entirely.
    setNow(Date.parse("2026-09-25T09:01:00+10:00"));
    const newSlot = Date.parse("2026-09-25T09:00:00+10:00");
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-25T09:00", graceMinutes: 180 },
        },
      }),
    ]);
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      new Map([
        [
          AU_UUID,
          new Map<number, ExerciseOutcome>([
            [SLOT_17_SEP, "missed"],
            [newSlot, "fired"], // dispatched a minute ago; no run detected yet
          ]),
        ],
      ]),
    );

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain(`UID:${AU_UUID}@liveone.energy`);
    expect(body).toContain(`DTSTART;TZID=${TZ}:20260925T090000`);
    // The 17 Sep miss is published; the 25 Sep dispatch is still inside grace, so it is not.
    expect(past(body)).toHaveLength(1);
    expect(past(body)[0]).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
  });

  it("🛑 an edited SPENT one-off does not reappear beside its own run", async () => {
    // The record sits at 09:00 where it happened; the rule now says 07:00. Checking only the
    // CURRENT start finds nothing accounted for and publishes a 07:00 schedule next to the 09:00
    // run — two entries for one morning, one of them at a time nothing happened at.
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        enabled: false,
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-17T07:00", graceMinutes: 180 }, // edited after the run
        },
      }),
    ]);
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "fired"),
    );
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP, 31, 0.5),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(vevents(body)).toHaveLength(1);
    expect(body).not.toContain(`UID:${AU_UUID}@liveone.energy`);
    expect(body).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
  });

  it("🛑 an RDATE occurrence keeps its own run when only its SIBLING was recorded", async () => {
    // Windows overlap without describing the same morning: 09:00 and a 12:00 RDATE, three hours of
    // grace each. Dropping the unrecorded 09:00 expansion because a record overlaps it loses the
    // only thing that could put a name to the 09:00 run, which then reads as unscheduled.
    setNow(Date.parse("2026-09-18T09:00:00+10:00"));
    const noon = Date.parse("2026-09-17T12:00:00+10:00");
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: {
            start: "2026-09-17T09:00",
            rdates: ["2026-09-17T12:00"],
            graceMinutes: 180,
          },
        },
      }),
    ]);
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(noon, "fired"), // only the LATER occurrence is on the record
    );
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP, 30, 1.0),
      runRow(noon, 30, 1.1),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(body)).toHaveLength(2);
    expect(body).not.toContain("(unscheduled)");
  });

  it("🛑 EXCLUDES past occurrences from before the rule was created", async () => {
    // `plan.slots` is floored at `createdAt` so a run predating the rule cannot be labelled with
    // its name. The exclusions cannot share that floor: a schedule anchored before its own creation
    // still generates occurrences a client will draw, and leaving them puts today's schedule back
    // over a stretch the feed deliberately publishes nothing about.
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        createdAt: new Date("2026-09-15T00:00:00Z"),
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: {
            start: "2026-09-03T09:00", // a Thursday, BEFORE createdAt
            rrule: "FREQ=WEEKLY;BYDAY=TH",
            graceMinutes: 180,
          },
        },
      }),
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(exdatesOf(master(body)!)).toEqual(
      expect.arrayContaining([
        "20260903T090000", // predates createdAt, still excluded
        "20260910T090000",
        "20260917T090000",
      ]),
    );
  });

  it("⏭️ a recorded skip becomes an event at the RECORDED instant", async () => {
    afterTheSlot();
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "satisfied"),
    );
    const [event] = past(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(event).toContain(
      `UID:slot-${AU_UUID}-${SLOT_17_SEP}@liveone.energy`,
    );
    expect(event).toContain("SUMMARY:⏭️ Generator exercise");
    expect(event).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
    expect(event).toContain("Skipped: the generator had already run enough.");
  });

  it("⏭️ says WHICH kind of skip — a full battery is not the same story", async () => {
    afterTheSlot();
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "skipped-full"),
    );
    const [event] = past(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(event).toContain(
      "Skipped: the battery was too full to load the engine.",
    );
  });

  it("⛔️ a recorded miss becomes an event, whatever the rule says now", async () => {
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([exerciseRow({ enabled: false })]);
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "missed"),
    );
    const [event] = past(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(event).toContain("SUMMARY:⛔️ Generator exercise");
    expect(event).toContain(
      "Did not run: no start was detected within 180 minutes of the scheduled time.",
    );
  });

  it("🛑 a past occurrence with NO record and NO run is published nowhere", async () => {
    // The deliberate cost of the model. Such an occurrence can only be placed by re-expanding
    // today's schedule, which is exactly the thing that moved history — so it is absent rather
    // than published at a time it may never have had. Everything decided from now on has a row.
    afterTheSlot();
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(body)).toEqual([]);
    // It is still excluded from the series, so nothing is drawn at the current rule's time either.
    expect(exdatesOf(master(body)!)).toContain("20260917T090000");
  });

  it("🛑 what a CLIENT expands: no past occurrence, and the owner's own skip still gone", async () => {
    // Asserted through the parser rather than on the EXDATE text, because the text passes whether
    // or not the exclusions do anything. The fixture skips 24 Sep; 17 Sep is past. Both must be
    // absent from the series, and the first occurrence a subscriber sees must be 1 October.
    setNow(Date.parse("2026-09-25T09:00:00+10:00"));
    const raw = await (await feed(AREA, `?token=${TOKEN}`)).text();
    const comp = new ICAL.Component(ICAL.parse(raw));
    const series = comp
      .getAllSubcomponents("vevent")
      .find((ve) => ve.hasProperty("rrule"))!;
    const iter = new ICAL.Event(series).iterator();
    const occ = [0, 1].map(() => iter.next().toJSDate().toISOString());
    expect(occ).toEqual([
      "2026-09-30T23:00:00.000Z", // Thu 1 Oct 09:00 AEST — 17 and 24 Sep both excluded
      "2026-10-07T22:00:00.000Z", // Thu 8 Oct 09:00 AEDT
    ]);
  });

  it("🛑 publishes EVERY generator start, scheduled or not", async () => {
    afterTheSlot();
    const panelStart = Date.parse("2026-08-02T14:00:00+10:00");
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(panelStart, 45, 3.25), // nobody scheduled this
      runRow(SLOT_17_SEP, 31, 0.5), // the Thursday exercise
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(body)).toHaveLength(2);

    const unscheduled = past(body).find((ve) => ve.includes("(unscheduled)"))!;
    expect(unscheduled).toContain(
      `UID:run-${DX_UUID}-${panelStart}@liveone.energy`,
    );
    expect(unscheduled).toContain(`DTSTART;TZID=${TZ}:20260802T140000`);
    expect(unscheduled).toContain(`DTEND;TZID=${TZ}:20260802T144500`);
    expect(unscheduled).toContain("SUMMARY:✅ Generator run (unscheduled)");
    expect(unscheduled).toContain("Ran for 45 minutes (3.3 kWh).");
    expect(unscheduled).toContain("No scheduled slot accounts for this run.");

    expect(
      past(body).find((ve) => ve.includes("SUMMARY:✅ Generator exercise")),
    ).toBeDefined();
  });

  it("🛑 names who started a run no slot accounts for — the inverter", async () => {
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      {
        ...runRow(Date.parse("2026-09-17T19:55:00+10:00"), 57, 4.4),
        startCause: "inverter",
      } as DerivedInterval,
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    const [event] = past(body);
    expect(event).toContain("SUMMARY:✅ Generator run (started by inverter)");
    expect(event).toContain("Started by the inverter.");
    expect(event).not.toContain("No scheduled slot");
  });

  it("🛑 names the RULE behind a LiveOne start, never the raw requester", async () => {
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      {
        ...runRow(Date.parse("2026-09-17T19:55:00+10:00"), 10, 0.7),
        startCause: "automation",
        startRequestedBy: `automation:${AU}`,
      } as DerivedInterval,
      {
        ...runRow(Date.parse("2026-09-17T21:00:00+10:00"), 10, 0.7),
        startCause: "user",
        startRequestedBy: "user_simon",
      } as DerivedInterval,
    ]);
    const body = unfold(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(body).toContain("SUMMARY:✅ Generator run (started from LiveOne)");
    expect(body).toContain(
      'Started from LiveOne by the automation "Generator exercise".',
    );
    expect(body).toContain("Started manually from LiveOne.");
    expect(body).not.toContain("user_simon");
    expect(body).not.toContain(AU);
  });

  it("🛑 a SECOND run in one grace window is published too, as its own event", async () => {
    // The slot takes the first start; the restart stands on its own. A generator that had to be
    // started twice is exactly the morning worth seeing.
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 60_000, 3, 0.1),
      runRow(SLOT_17_SEP + 40 * 60_000, 30, 1.2),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(body)).toHaveLength(2);
    expect(unfold(body)).toContain("Ran for 3 minutes (0.1 kWh).");
    expect(unfold(body)).toContain("Ran for 30 minutes (1.2 kWh).");
    expect(body).toContain("SUMMARY:✅ Generator exercise");
    expect(body).toContain("(unscheduled)");
  });

  it("🛑 an OPEN run gets no event — but still answers for its slot", async () => {
    // Two things at once, and the second is the regression: an open run cannot be an event (no
    // DTEND), yet it must still stop the recorded `fired` slot being published as ⛔️. Drop open
    // runs from the matching and the feed says "Did not run" about a generator that is running.
    afterTheSlot();
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "fired"),
    );
    mockStore.intervalsOverlapping.mockResolvedValue([
      { ...runRow(SLOT_17_SEP), endTime: null, energyKwh: null },
    ] as DerivedInterval[]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(body)).toEqual([]);
    expect(body).not.toContain("⛔️");
  });

  it("🛑 TWO rules on one detector each keep their own run", async () => {
    afterTheSlot();
    const tenAm = exerciseRow({
      id: "b2c3d4e5-0000-4000-8000-000000000002",
      name: "Second exercise",
      trigger: {
        ...(exerciseRow().trigger as ExerciseTrigger),
        schedule: {
          start: "2026-09-17T10:00",
          rrule: "FREQ=WEEKLY;BYDAY=TH",
          graceMinutes: 180,
        },
      },
    });
    mockStore.listForArea.mockResolvedValue([exerciseRow(), tenAm]);
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 90 * 60_000, 10, 0.2),
      runRow(SLOT_17_SEP + 100 * 60_000, 30, 1.1),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(past(body)).toHaveLength(2);
    expect(body).toContain("SUMMARY:✅ Generator exercise");
    expect(body).toContain("SUMMARY:✅ Second exercise");
    expect(body).not.toContain("(unscheduled)");
  });

  it("🛑 an RDATE-only schedule is a SERIES, and its past is excluded too", async () => {
    setNow(Date.parse("2026-09-20T09:00:00+10:00"));
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: {
            start: "2026-09-17T09:00",
            rdates: ["2026-09-19T09:00"],
            graceMinutes: 180,
          },
        },
      }),
    ]);
    mockStore.intervalsOverlapping.mockResolvedValue([runRow(SLOT_17_SEP)]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    const series = vevents(body).find((ve) => ve.includes("RDATE"))!;
    // Both occurrences are past, so both are excluded — the run is published on its own.
    expect(exdatesOf(series)).toEqual(
      expect.arrayContaining(["20260917T090000", "20260919T090000"]),
    );
    expect(past(body)).toHaveLength(1);
    expect(past(body)[0]).toContain("SUMMARY:✅ Generator exercise");
  });

  it("a spent ONE-OFF becomes its past event, and stops being a schedule", async () => {
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        enabled: false,
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-17T09:00", graceMinutes: 180 },
        },
      }),
    ]);
    mockStore.intervalsOverlapping.mockResolvedValue([runRow(SLOT_17_SEP)]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // One event, and it is the RUN — not the rule. "✅ … (disabled)" was always a contradiction.
    expect(vevents(body)).toHaveLength(1);
    expect(body).toContain("SUMMARY:✅ Generator exercise");
    expect(body).not.toContain("(disabled)");
    expect(body).not.toContain(`UID:${AU_UUID}@liveone.energy`);
  });

  it("🛑 a one-off with nothing recorded is still published as a schedule", async () => {
    // Otherwise it would vanish entirely: no past event to stand for it, and no master either.
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        enabled: false,
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-17T09:00", graceMinutes: 180 },
        },
      }),
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain(`UID:${AU_UUID}@liveone.energy`);
    expect(body).toContain("SUMMARY:Generator exercise (disabled)");
  });

  it("🛑 a FUTURE occurrence is never excluded", async () => {
    setNow(Date.parse("2026-09-16T00:00:00+10:00"));
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // Only the owner's own 24 Sep skip; nothing synthetic.
    expect(exdatesOf(master(body)!)).toEqual(["20260924T090000"]);
  });

  // `now` such that the 366-day cutoff lands BETWEEN the 17 Sep slot and a run a minute after it.
  const cutoffBetweenSlotAndRun = () =>
    setNow(SLOT_17_SEP + 30_000 + 366 * 86_400_000);

  it("🛑 reads further back than it publishes, by one attribution window", async () => {
    cutoffBetweenSlotAndRun();
    await feed(AREA, `?token=${TOKEN}`);
    const [, fromMs] = mockStore.intervalsOverlapping.mock.calls[0];
    const sinceMs = nowMs - 366 * 86_400_000;
    // The fixture's 180-minute grace, its lead and its tail — `attributionSlackMs(180)`.
    expect(sinceMs - fromMs).toBe(180 * 60_000 + 120_000 + 300_000);
    // And the outcomes are read from the same floor, so all three reads agree.
    expect(mockStore.listSlotOutcomesForAutomations).toHaveBeenCalledWith(
      [AU_UUID],
      fromMs,
    );
  });

  it("🛑 a run just inside the cutoff is still labelled by the slot that asked for it", async () => {
    // The history bound is arbitrary; attribution must not be. The 17 Sep slot falls before the
    // cutoff while its run lands after, so without expanding slots back by one attribution window
    // the run would be published as "unscheduled" — a false statement built entirely out of where
    // the boundary happened to fall.
    cutoffBetweenSlotAndRun();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 60_000),
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).not.toContain("(unscheduled)");
    expect(body).toContain("SUMMARY:✅ Generator exercise");
  });

  it("🛑 …and the pre-cutoff slot takes its OWN run, not the next one along", async () => {
    // Expanding slots backwards without also READING backwards let the pre-cutoff slot claim a run
    // it never started — mislabelling a real unscheduled start — because the run it should have
    // claimed was never fetched.
    cutoffBetweenSlotAndRun();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP - 60_000, 20, 0.4), // its own run, BEFORE the cutoff
      runRow(SLOT_17_SEP + 60_000, 45, 2.5), // a second start, after it
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // The pre-cutoff run is claimed but never published — it is outside the history.
    expect(past(body)).toHaveLength(1);
    const unscheduled = past(body)[0];
    expect(unscheduled).toContain("(unscheduled)");
    expect(unscheduled).toContain("Ran for 45 minutes (2.5 kWh).");
  });

  it("🛑 a TIGHT-grace rule's pre-cutoff slot still competes for its run", async () => {
    // The expansion floor is shared across rules — the widest window on the area, not each rule's
    // own. Per-rule floors decided which slots got to COMPETE: the 1-minute-grace rule's slot fell
    // outside its own floor while the 180-minute rule's survived, so the loose rule took the run
    // the tight one should have had and the leftover was mislabelled "unscheduled".
    cutoffBetweenSlotAndRun();
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        name: "Tight",
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-17T08:59", graceMinutes: 1 },
        },
      }),
      exerciseRow({
        id: "b2c3d4e5-0000-4000-8000-000000000002",
        name: "Loose",
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-17T09:00", graceMinutes: 180 },
        },
      }),
    ]);
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP, 20, 0.4), // before the cutoff; inside BOTH windows
      runRow(SLOT_17_SEP + 60_000, 45, 2.5), // after it; only the loose rule can reach
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // The tight rule takes the earlier run, so the loose rule takes the later one — and the
    // published start is named for its rule rather than called unscheduled.
    expect(body).not.toContain("(unscheduled)");
    expect(body).toContain("SUMMARY:✅ Loose");
  });

  it("serves an area's runs even when it has no automations at all", async () => {
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([]);
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(Date.parse("2026-08-02T14:00:00+10:00")),
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain("SUMMARY:✅ Generator run (unscheduled)");
  });

  it("bounds the history it reads to a year and a day", async () => {
    afterTheSlot();
    await feed(AREA, `?token=${TOKEN}`);
    const [, fromMs, toMs] = mockStore.intervalsOverlapping.mock.calls[0];
    expect(toMs).toBe(nowMs);
    // Exactly 366 days here: the attribution slack only widens the read when a rule's occurrences
    // actually reach past the cutoff, and this fixture was created well inside it. The widened
    // case is pinned separately.
    expect(toMs - fromMs).toBe(366 * 86_400_000);
  });
});

describe("…/calendar-tokens", () => {
  const tokenRow = {
    token: TOKEN,
    label: "simon iphone",
    createdAtMs: Date.parse("2026-09-01T00:00:00Z"),
    expiresAtMs: null,
    revokedAtMs: null,
    lastUsedAtMs: null,
  };
  const req = (method: string, body?: unknown, query = "") =>
    new NextRequest(
      `https://liveone.energy/api/v4/areas/${AREA}/calendar-tokens${query}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
      },
    );
  const params = { params: Promise.resolve({ id: AREA }) };

  it("mints a token and returns BOTH url forms", async () => {
    mockMint.mockResolvedValue(tokenRow);
    const res = await MINT(req("POST", { label: "simon iphone" }), params);
    expect(res.status).toBe(201);
    const { token } = await res.json();
    // webcal:// is what makes a client SUBSCRIBE rather than import a snapshot.
    expect(token.webcal).toBe(
      `webcal://liveone.energy/api/v4/areas/${AREA}/calendar.ics?token=${TOKEN}`,
    );
    expect(token.https).toBe(
      `https://liveone.energy/api/v4/areas/${AREA}/calendar.ics?token=${TOKEN}`,
    );
  });

  it("422s a mint with no label — an unlabelled long-lived URL cannot be revoked knowingly", async () => {
    const res = await MINT(req("POST", { label: "  " }), params);
    expect(res.status).toBe(422);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("422s a nonsense expiry rather than minting a token that never expires", async () => {
    const res = await MINT(
      req("POST", { label: "x", expiresInDays: -5 }),
      params,
    );
    expect(res.status).toBe(422);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("lists revoked and expired tokens too — 'when did this stop working' needs them", async () => {
    mockList.mockResolvedValue([
      { ...tokenRow, revokedAtMs: Date.parse("2026-09-05T00:00:00Z") },
    ]);
    const res = await LIST(req("GET"), params);
    expect(res.status).toBe(200);
    const { tokens } = await res.json();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].revokedAtMs).toBe(Date.parse("2026-09-05T00:00:00Z"));
  });

  it("revokes, scoped to the area the caller owns", async () => {
    mockRevoke.mockResolvedValue(true);
    const res = await REVOKE(
      req("DELETE", undefined, `?token=${TOKEN}`),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(mockRevoke).toHaveBeenCalledWith(AREA_UUID, TOKEN);
  });

  it("422s a revoke with no token named", async () => {
    const res = await REVOKE(req("DELETE"), params);
    expect(res.status).toBe(422);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("🛑 every verb goes through the owner gate — a feed token can never mint its own successor", async () => {
    mockAreaOwner.mockResolvedValue({
      error: NextResponse.json(
        { error: "Write access required" },
        { status: 403 },
      ),
    } as never);
    expect((await LIST(req("GET"), params)).status).toBe(403);
    expect((await MINT(req("POST", { label: "x" }), params)).status).toBe(403);
    expect(
      (await REVOKE(req("DELETE", undefined, `?token=${TOKEN}`), params))
        .status,
    ).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
