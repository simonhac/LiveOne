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
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
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
    // Local wall clock, TZID-qualified — a floating or UTC DTSTART would put the run an hour out
    // for half the year in every subscriber's client.
    expect(body).toContain(`DTSTART;TZID=${TZ}:20260917T090000`);
    expect(body).toContain(`DTEND;TZID=${TZ}:20260917T093000`);
    expect(body).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");
    expect(body).toContain(`EXDATE;TZID=${TZ}:20260924T090000`);
  });

  it("ships a real VTIMEZONE and a publish TTL", async () => {
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    // Without the VTIMEZONE component Apple Calendar cannot resolve the TZID above.
    expect(body).toContain("BEGIN:VTIMEZONE");
    expect(body).toContain(`TZID:${TZ}`);
    expect(body).toContain("X-PUBLISHED-TTL:PT1H");
  });

  it("carries the schedule and NOTHING about readings", async () => {
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain("Run for 30 minutes");
    expect(body).not.toContain(LOAD_PT_UUID);
    expect(body).not.toContain(ACT_PT_UUID);
  });

  it("shows a disabled rule as CANCELLED rather than dropping it", async () => {
    mockStore.listForArea.mockResolvedValue([exerciseRow({ enabled: false })]);
    const body = await (await feed(AREA, `?token=${TOKEN}`)).text();
    expect(body).toContain("STATUS:CANCELLED");
    expect(body).toContain("SUMMARY:Generator exercise (disabled)");
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
