import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import {
  isInverterEvent,
  parsePortalEvents,
  portalTimestamp,
  PORTAL_COMMS_EVENT_CODE,
  summarisePortalEvents,
} from "../portal-events";

const TZ = "Australia/Melbourne";
const html = fs.readFileSync(
  path.join(__dirname, "fixtures/portal-events.html"),
  "utf8",
);
const parse = (source = html) => {
  const result = parsePortalEvents(source, TZ);
  if ("error" in result) throw new Error(result.error);
  return result;
};

describe("parsePortalEvents", () => {
  it("reads every row of the real Events page", () => {
    const { events, unreadableRows } = parse();
    expect(unreadableRows).toBe(0);
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({
      code: 50,
      description: "Unit - Instant Low DC Voltage Fault",
      createdText: "2026-09-18 11:53:00",
      clearedText: "2026-09-18 12:12:59",
      active: false,
    });
  });

  it("identifies BOTH September blackouts, and does not invent one for the generator trip", () => {
    const { events } = parse();
    const lowDc = events.filter((e) => e.code === 50).map((e) => e.createdText);
    expect(lowDc).toEqual(["2026-09-18 11:53:00", "2026-09-17 19:53:00"]);
    // The 17 September generator trip, around 20:53, falls INSIDE the preceding event's displayed
    // duration. The portal has no separate row for it, and neither must we.
    expect(events.some((e) => e.createdText.startsWith("2026-09-17 20:"))).toBe(
      false,
    );
  });

  it("converts Created and Cleared in the account's timezone, keeping the text verbatim", () => {
    const { events } = parse();
    const event = events[1];
    expect(event.createdAt?.toISOString()).toBe("2026-09-17T09:53:00.000Z");
    expect(event.clearedAt?.toISOString()).toBe("2026-09-17T11:14:02.000Z");
    expect(event.createdText).toBe("2026-09-17 19:53:00");
  });

  it("gives each occurrence a stable identity keyed on Created, not on fetch time", () => {
    const first = parse().events.map((e) => e.dedupeKey);
    const second = parse().events.map((e) => e.dedupeKey);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    expect(first[0]).toBe("p:50:2026-09-18 11:53:00");
  });

  it("separates the portal's own communications event from inverter faults", () => {
    const { events } = parse();
    const comms = events.find((e) => e.code === PORTAL_COMMS_EVENT_CODE)!;
    expect(comms.description).toMatch(/Lost Communication/);
    expect(isInverterEvent(comms)).toBe(false);
    expect(events.filter(isInverterEvent)).toHaveLength(4);
  });

  it("treats a row with no Cleared value as active", () => {
    const active = html.replace(
      '<td class="hidden-xs">2026-09-18 12:12:59</td>',
      '<td class="hidden-xs"></td>',
    );
    const { events } = parse(active);
    expect(events[0].active).toBe(true);
    // The glyph still claims "cleared". We report the disagreement rather than picking a winner.
    expect(events[0].statusInconsistent).toBe(true);
  });

  it("counts an unreadable row instead of dropping it silently", () => {
    const broken = html.replace(
      '<td class="hidden-xs">12</td>',
      '<td class="hidden-xs">not-a-code</td>',
    );
    const { events, unreadableRows } = parse(broken);
    expect(unreadableRows).toBe(1);
    expect(events).toHaveLength(4);
  });

  it("reports a login redirect as UNAVAILABLE, never as an empty history", () => {
    const login = `<html><body><form action="/login" method="post">
      <input name="email"/><input name="password" type="password"/></form></body></html>`;
    const result = parsePortalEvents(login, TZ);
    expect(result).toEqual({ error: expect.stringMatching(/login page/) });
  });

  it("reports a missing table as unavailable rather than as no events", () => {
    const result = parsePortalEvents(
      "<html><body><p>Nothing here</p></body></html>",
      TZ,
    );
    expect(result).toEqual({
      error: expect.stringMatching(/recognisable events table/),
    });
  });

  it("reads an empty table as genuinely no events", () => {
    const empty = html.replace(/<tbody>[\s\S]*<\/tbody>/, "<tbody></tbody>");
    expect(parse(empty).events).toHaveLength(0);
  });
});

describe("portalTimestamp", () => {
  it("accepts the portal's format, with or without seconds", () => {
    expect(portalTimestamp("2026-09-17 19:53:00", TZ)?.toISOString()).toBe(
      "2026-09-17T09:53:00.000Z",
    );
    expect(portalTimestamp("2026-09-17 19:53", TZ)?.toISOString()).toBe(
      "2026-09-17T09:53:00.000Z",
    );
  });
  it("returns null rather than guessing at an empty or malformed value", () => {
    expect(portalTimestamp("", TZ)).toBeNull();
    expect(portalTimestamp("yesterday", TZ)).toBeNull();
  });
  it("refuses an ambiguous local time in the DST fold", () => {
    // 2026-04-05 02:30 happens twice in Melbourne. Picking one would place a fault an hour out.
    expect(portalTimestamp("2026-04-05 02:30:00", TZ)).toBeNull();
  });
});

describe("summarisePortalEvents", () => {
  it("reports no active fault, but retains the newest Created as the last fault time", () => {
    const summary = summarisePortalEvents(parse().events);
    expect(summary.activeCode).toBeNull();
    expect(summary.lastFaultAt?.toISOString()).toBe("2026-09-18T01:53:00.000Z");
  });

  it("surfaces an active fault and when it started", () => {
    const active = html.replace(
      '<td class="hidden-xs">2026-09-18 12:12:59</td>',
      '<td class="hidden-xs"></td>',
    );
    const summary = summarisePortalEvents(parse(active).events);
    expect(summary.activeCode).toBe(50);
    expect(summary.activeSince?.toISOString()).toBe("2026-09-18T01:53:00.000Z");
  });

  it("never lets the portal's own comms event become the active fault", () => {
    const active = html.replace(
      '<td class="hidden-xs">2025-09-17 08:55:33</td>',
      '<td class="hidden-xs"></td>',
    );
    const summary = summarisePortalEvents(parse(active).events);
    expect(summary.activeCode).toBeNull();
  });
});
