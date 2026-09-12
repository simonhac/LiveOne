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
jest.mock("@/lib/automations/store", () => ({ listForArea: jest.fn() }));

import { loadAreaForAuth, loadAreaForOwner } from "@/lib/areas/http";
import {
  listCalendarTokens,
  mintCalendarToken,
  revokeCalendarToken,
  validateCalendarToken,
} from "@/lib/areas/calendar-tokens";
import * as store from "@/lib/automations/store";
import type {
  AutomationRow,
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

  it("carries the schedule and NOTHING about readings", async () => {
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain("Run for 30 minutes");
    expect(body).not.toContain(LOAD_PT_UUID);
    expect(body).not.toContain(ACT_PT_UUID);
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

  it("404s a malformed area id, indistinguishably", async () => {
    expect((await feed("not-an-area", `?token=${TOKEN}`)).status).toBe(404);
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
