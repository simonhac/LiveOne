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
    expect(body).toContain("Run for 30 minutes");
    expect(body).not.toContain(LOAD_PT_UUID);
    expect(body).not.toContain(ACT_PT_UUID);
  });

  it("states the skip condition when the rule has one", async () => {
    const body = unfold(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(body).toContain(
      "Skipped if it has already run for 30 minutes or more above 1.5 kW in the previous 7 days.",
    );
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
    expect(body).toContain("Run for 30 minutes.");
    expect(body).not.toContain("Skipped if");
    // The grace line is not part of the skip condition and must survive without it.
    expect(body).toContain("A missed start stays due for 180 minutes.");
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
 * The outcome marking, at the ROUTE level.
 *
 * `calendar-marks.test.ts` pins WHICH glyph a slot gets; these pin that the glyph reaches a
 * subscriber as legal iCalendar — which for a recurring rule means an OVERRIDE component, the one
 * shape a `toContain` on the whole body cannot tell apart from a duplicate event.
 */
describe("GET …/calendar.ics — what actually happened", () => {
  /** The override components: same UID as the master, plus a RECURRENCE-ID. */
  const overrides = (body: string) =>
    vevents(body).filter((ve) => ve.includes("RECURRENCE-ID"));
  const master = (body: string) =>
    vevents(body).find((ve) => ve.includes("RRULE:"));

  /** A decided slot, as `listSlotOutcomesForAutomations` returns it. */
  const decided = (slotAtMs: number, outcome: ExerciseOutcome) =>
    new Map([[AU_UUID, new Map([[slotAtMs, outcome]])]]);

  const afterTheSlot = () => setNow(Date.parse("2026-09-18T09:00:00+10:00"));

  it("🛑 marks a run at a past slot with an OVERRIDE, leaving the master series alone", async () => {
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 60_000),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();

    // The master is untouched: still the rule, still recurring, still plainly titled.
    expect(master(body)).toContain("SUMMARY:Generator exercise");
    expect(master(body)).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");
    expect(master(body)).not.toContain("✅");

    const [override, ...rest] = overrides(body);
    expect(rest).toEqual([]);
    // 🛑 The master's UID. Without it this is a second event on top of the occurrence, not a
    // replacement of it — the subscriber sees the run twice.
    expect(override).toContain(`UID:${AU_UUID}@liveone.energy`);
    // 🛑 TZID-qualified local wall clock, like DTSTART. A RECURRENCE-ID naming an instant no
    // occurrence falls on is silently ignored, which looks exactly like the feature not shipping.
    expect(override).toContain(`RECURRENCE-ID;TZID=${TZ}:20260917T090000`);
    expect(override).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
    expect(override).toContain("SUMMARY:✅ Generator exercise");
    expect(override).toContain("Ran for 30 minutes (0.5 kWh).");
    expect(override).not.toContain("RRULE:");
  });

  it("🛑 a reference parser resolves the override onto the occurrence it replaces", async () => {
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([runRow(SLOT_17_SEP)]);

    const raw = await (await feed(AREA, `?token=${TOKEN}`)).text();
    const comp = new ICAL.Component(ICAL.parse(raw));
    const components = comp.getAllSubcomponents("vevent");
    const masterComp = components.find(
      (ve) => !ve.hasProperty("recurrence-id"),
    )!;
    const event = new ICAL.Event(masterComp);
    for (const ve of components)
      if (ve.hasProperty("recurrence-id")) event.relateException(ve);

    // The question a client actually asks, and asked with the SERIES' OWN instants rather than a
    // hand-built `ICAL.Time`: an exception is keyed by its recurrence id, so a time carrying a
    // differently-resolved zone silently matches nothing and the test passes or fails on whether
    // some other suite happened to register Australia/Melbourne in ICAL's global TimezoneService.
    const iter = event.iterator();
    const seventeenth = iter.next();
    const first = iter.next(); // 24 Sep is EXDATEd, so this is 1 Oct
    expect(event.getOccurrenceDetails(seventeenth).item.summary).toBe(
      "✅ Generator exercise",
    );
    // …and the next one is still the plain rule, not the marked past.
    expect(event.getOccurrenceDetails(first).item.summary).toBe(
      "Generator exercise",
    );
  });

  it("⛔️ a past slot with no run and no record at all", async () => {
    afterTheSlot();
    const [override] = overrides(
      await (await feed(AREA, `?token=${TOKEN}`)).text(),
    );
    expect(override).toContain("SUMMARY:⛔️ Generator exercise");
    expect(override).toContain(
      "Did not run: no start was detected within 180 minutes of the scheduled time.",
    );
  });

  it("⏭️ a slot the evaluator deliberately skipped", async () => {
    afterTheSlot();
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "satisfied"),
    );
    const [override] = overrides(
      await (await feed(AREA, `?token=${TOKEN}`)).text(),
    );
    expect(override).toContain("SUMMARY:⏭️ Generator exercise");
    expect(override).toContain(
      "Skipped: the generator had already run enough.",
    );
  });

  it("⏭️ says WHICH kind of skip — a full battery is not the same story", async () => {
    afterTheSlot();
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "skipped-full"),
    );
    const [override] = overrides(
      await (await feed(AREA, `?token=${TOKEN}`)).text(),
    );
    expect(override).toContain(
      "Skipped: the battery was too full to load the engine.",
    );
  });

  it("🛑 says NOTHING about a slot still inside its grace window", async () => {
    // Half an hour past a 09:00 slot with three hours of grace: the evaluator may yet start it,
    // and publishing ⛔️ here would be a verdict on a slot that has not finished.
    setNow(SLOT_17_SEP + 30 * 60_000);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(overrides(body)).toEqual([]);
  });

  it("🛑 never marks an EXDATEd occurrence — it was never going to happen", async () => {
    setNow(Date.parse("2026-09-25T09:00:00+10:00"));
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(new Map());
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // 17 Sep is marked; the excluded 24 Sep is not.
    expect(overrides(body)).toHaveLength(1);
    expect(overrides(body)[0]).toContain("20260917T090000");
  });

  it("🛑 never marks a slot from before the rule existed", async () => {
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([
      // Created AFTER the 17 Sep occurrence its own rule would expand to.
      exerciseRow({ createdAt: new Date("2026-09-18T00:00:00Z") }),
    ]);
    expect(
      overrides(await (await feed(AREA, `?token=${TOKEN}`)).text()),
    ).toEqual([]);
  });

  it("retitles a decided ONE-OFF in place, with no override and no (disabled)", async () => {
    // A spent one-off is disabled by the evaluator in the write that consumes its last slot, so
    // every decided one-off is a disabled rule — and "✅ Top-up (disabled)" reads as a
    // contradiction to somebody who just wants to know whether it ran.
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
    expect(body).toContain("SUMMARY:✅ Generator exercise");
    expect(body).not.toContain("(disabled)");
    expect(body).not.toContain("This rule is currently DISABLED.");
    expect(overrides(body)).toEqual([]);
  });

  it("an UNDECIDED disabled one-off still says (disabled)", async () => {
    // Still inside its grace window: nothing has been decided, so "disabled" is the only thing
    // there is to say, and it is still true.
    setNow(SLOT_17_SEP + 60_000);
    mockStore.listForArea.mockResolvedValue([
      exerciseRow({
        enabled: false,
        trigger: {
          ...(exerciseRow().trigger as ExerciseTrigger),
          schedule: { start: "2026-09-17T09:00", graceMinutes: 180 },
        },
      }),
    ]);
    const body = unfold(await (await feed(AREA, `?token=${TOKEN}`)).text());
    expect(body).toContain("SUMMARY:Generator exercise (disabled)");
    expect(body).toContain("This rule is currently DISABLED.");
  });

  it("publishes a run no schedule accounts for, as its own event", async () => {
    afterTheSlot();
    const panelStart = Date.parse("2026-08-02T14:00:00+10:00");
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(panelStart, 45, 3.25),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    const unscheduled = vevents(body).find((ve) =>
      ve.includes("(unscheduled)"),
    )!;
    // 🛑 Keyed on `start_time`, the run row's immutable identity — the only stable thing there is.
    expect(unscheduled).toContain(
      `UID:run-${DX_UUID}-${panelStart}@liveone.energy`,
    );
    // The ACTUAL times, not a slot's.
    expect(unscheduled).toContain(`DTSTART;TZID=${TZ}:20260802T140000`);
    expect(unscheduled).toContain(`DTEND;TZID=${TZ}:20260802T144500`);
    expect(unscheduled).toContain("SUMMARY:✅ Generator run (unscheduled)");
    expect(unscheduled).toContain("Ran for 45 minutes (3.3 kWh).");
    // 🛑 A claim about the SCHEDULE, not about causation — the feed knows no slot's window contains
    // this start; it does NOT know no automation caused it.
    expect(unscheduled).toContain("No scheduled slot accounts for this run.");
  });

  it("🛑 does NOT publish a slot's own run a second time as unscheduled", async () => {
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 60_000),
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).not.toContain("(unscheduled)");
    expect(overrides(body)).toHaveLength(1);
  });

  it("🛑 an OPEN run gets no EVENT, but still proves its slot started", async () => {
    // The distinction a review caught the code getting wrong. An open interval cannot be an event
    // — there is no DTEND to write — but discarding the row entirely made a generator that was
    // RUNNING AT THAT MOMENT publish "no start was detected": a run beginning near the end of a
    // grace window is still going when the window closes.
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      { ...runRow(SLOT_17_SEP), endTime: null, energyKwh: null },
    ] as DerivedInterval[]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).not.toContain("(unscheduled)");
    expect(overrides(body)[0]).toContain("SUMMARY:✅ Generator exercise");
    // The comma is RFC 5545-escaped in a DESCRIPTION.
    expect(overrides(body)[0]).toContain("It started\\, and is still running.");
  });

  it("🛑 a SECOND run in one grace window is published rather than swallowed", async () => {
    // The slot takes the first start; the restart becomes its own event. Before the fix the slot
    // showed the first run and the restart appeared nowhere at all — and a generator that had to
    // be started twice is exactly the morning worth seeing.
    afterTheSlot();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 60_000, 3, 0.1),
      runRow(SLOT_17_SEP + 40 * 60_000, 30, 1.2),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(overrides(body)[0]).toContain("Ran for 3 minutes (0.1 kWh).");
    const restart = vevents(body).find((ve) => ve.includes("(unscheduled)"))!;
    expect(restart).toContain("Ran for 30 minutes (1.2 kWh).");
  });

  it("🛑 an RDATE-only schedule is a SERIES, not a one-off", async () => {
    // `toRecurrenceLines` renders `start` + `rdates` with no RRULE as a repeating event, so reading
    // "no rrule" as "one occurrence" applied ONE occurrence's outcome to the master — i.e. to every
    // future occurrence — and, past the second, dropped the marking entirely.
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
    // The master keeps its plain title — its outcome is NOT smeared over the RDATE occurrence…
    const [firstEvent] = vevents(body);
    expect(firstEvent).toContain("SUMMARY:Generator exercise");
    expect(firstEvent).toContain(`RDATE;TZID=${TZ}:20260919T090000`);
    // …and both occurrences are marked individually.
    expect(overrides(body)).toHaveLength(2);
    expect(overrides(body)[0]).toContain("SUMMARY:✅ Generator exercise");
    expect(overrides(body)[1]).toContain("SUMMARY:⛔️ Generator exercise");
    expect(overrides(body)[1]).toContain(
      `RECURRENCE-ID;TZID=${TZ}:20260919T090000`,
    );
  });

  it("🛑 says nothing about a DISABLED rule's silent past slots", async () => {
    // A disabled rule is never evaluated, so every expired occurrence has no record and no run —
    // the exact shape the marker otherwise reads as a failure. A rule switched off for a month
    // would fill that month with red for weeks nothing was ever going to happen in.
    setNow(Date.parse("2026-10-20T09:00:00+10:00"));
    mockStore.listForArea.mockResolvedValue([exerciseRow({ enabled: false })]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(overrides(body)).toEqual([]);
    expect(body).toContain("SUMMARY:Generator exercise (disabled)");
  });

  it("🛑 but a RECORDED miss survives the rule being switched off afterwards", async () => {
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([exerciseRow({ enabled: false })]);
    mockStore.listSlotOutcomesForAutomations.mockResolvedValue(
      decided(SLOT_17_SEP, "missed"),
    );
    const [override] = overrides(
      await (await feed(AREA, `?token=${TOKEN}`)).text(),
    );
    expect(override).toContain("SUMMARY:⛔️ Generator exercise");
  });

  // `now` such that the 366-day cutoff lands BETWEEN the 17 Sep slot and a run a minute after it.
  const cutoffBetweenSlotAndRun = () =>
    setNow(SLOT_17_SEP + 30_000 + 366 * 86_400_000);

  it("🛑 a run just inside the cutoff is not orphaned by a slot just outside it", async () => {
    // The history bound is arbitrary; attribution must not be. The 17 Sep slot falls before the
    // cutoff while its run lands after — so without expanding slots back by one attribution
    // window, the run would be published as "unscheduled": a false statement built entirely out of
    // where the boundary happened to fall.
    cutoffBetweenSlotAndRun();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 60_000),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).not.toContain("(unscheduled)");
    // And the slot itself is outside the published history, so it gets no override of its own —
    // it was expanded ONLY so that it could claim its run.
    expect(
      overrides(body).filter((ve) => ve.includes("20260917T090000")),
    ).toEqual([]);
  });

  it("🛑 …and the pre-cutoff slot takes its OWN run, not the next one along", async () => {
    // The other half of the same boundary. Expanding slots backwards without also READING
    // backwards let the pre-cutoff slot claim a run it never started — hiding a real unscheduled
    // event — because the run it should have claimed was never fetched.
    cutoffBetweenSlotAndRun();
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP - 60_000, 20, 0.4), // its own run, BEFORE the cutoff
      runRow(SLOT_17_SEP + 60_000, 45, 2.5), // a second start, after it
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // The pre-cutoff run is claimed but never published — it is outside the history.
    expect(body).not.toContain("20260917T085900");
    // The second start is nobody's slot, so it is published as what it is.
    const unscheduled = vevents(body).find((ve) =>
      ve.includes("(unscheduled)"),
    );
    expect(unscheduled).toContain("Ran for 45 minutes (2.5 kWh).");
  });

  it("🛑 a TIGHT-grace rule's pre-cutoff slot still competes for its run", async () => {
    // The expansion floor is shared across rules — the widest window on the area, not each rule's
    // own. Per-rule floors decided which slots got to COMPETE: the 1-minute-grace rule's slot fell
    // outside its own floor while the 180-minute rule's survived, so the loose rule took the run the
    // tight one should have had, and the leftover was published as "unscheduled".
    cutoffBetweenSlotAndRun();
    const tight = exerciseRow({
      name: "Tight",
      trigger: {
        ...(exerciseRow().trigger as ExerciseTrigger),
        schedule: { start: "2026-09-17T08:59", graceMinutes: 1 },
      },
    });
    const loose = exerciseRow({
      id: "b2c3d4e5-0000-4000-8000-000000000002",
      name: "Loose",
      trigger: {
        ...(exerciseRow().trigger as ExerciseTrigger),
        schedule: { start: "2026-09-17T09:00", graceMinutes: 180 },
      },
    });
    mockStore.listForArea.mockResolvedValue([tight, loose]);
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP, 20, 0.4), // before the cutoff; inside BOTH windows
      runRow(SLOT_17_SEP + 60_000, 45, 2.5), // after it; only the loose rule can reach
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // The tight rule takes the earlier run, so the loose rule takes the later one — and nothing is
    // left over to be called unscheduled.
    expect(body).not.toContain("(unscheduled)");
  });

  it("🛑 reads further back than it publishes, by one attribution window", async () => {
    // Only when a rule's occurrences actually reach past the cutoff — which is the straddle case.
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

  it("🛑 TWO rules on one detector cannot hide a run between them", async () => {
    // Attribution is a per-DETECTOR matching, not a per-rule one. Run once per rule and once over
    // the union and the two disagree: each rule's own pass shows it the earliest run in its window
    // — the same run, for both — while the union pass claims two, and the second vanishes.
    afterTheSlot();
    const nineAm = exerciseRow();
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
    mockStore.listForArea.mockResolvedValue([nineAm, tenAm]);
    // Both runs fall inside BOTH rules' grace windows.
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(SLOT_17_SEP + 90 * 60_000, 10, 0.2),
      runRow(SLOT_17_SEP + 100 * 60_000, 30, 1.1),
    ]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // One run each, and neither is lost.
    expect(unfold(body)).toContain("Ran for 10 minutes (0.2 kWh).");
    expect(unfold(body)).toContain("Ran for 30 minutes (1.1 kWh).");
    expect(body).not.toContain("(unscheduled)");
    expect(overrides(body)).toHaveLength(2);
  });

  it("🛑 an UNATTRIBUTED open run is published nowhere at all", async () => {
    // No slot to be evidence for, and no DTEND to write an event with.
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([]);
    mockStore.intervalsOverlapping.mockResolvedValue([
      {
        ...runRow(Date.parse("2026-09-18T08:00:00+10:00")),
        endTime: null,
        energyKwh: null,
      },
    ] as DerivedInterval[]);

    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).not.toContain("BEGIN:VEVENT");
  });

  it("serves an area's runs even when it has no automations at all", async () => {
    afterTheSlot();
    mockStore.listForArea.mockResolvedValue([]);
    mockStore.intervalsOverlapping.mockResolvedValue([
      runRow(Date.parse("2026-08-02T14:00:00+10:00")),
    ]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain("SUMMARY:✅ Generator run (unscheduled)");
    expect(mockStore.intervalsOverlapping).toHaveBeenCalledWith(
      DX_UUID,
      expect.any(Number),
      expect.any(Number),
    );
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
    // The slot outcomes are read over the SAME window — a run and the slot explaining it must
    // never fall on opposite sides of the cutoff.
    expect(mockStore.listSlotOutcomesForAutomations).toHaveBeenCalledWith(
      [AU_UUID],
      fromMs,
    );
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
