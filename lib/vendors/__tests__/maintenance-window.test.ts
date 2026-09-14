/**
 * The window comparison, and the ONE fact about Amber's window that is easy to get wrong.
 *
 * The Amber cases here are the regression guard for `lib/vendors/amber/adapter.ts`: the window is
 * keyed to UTC+10, not to Melbourne wall-clock, and the difference is invisible for the ~7 months
 * of the year that Victoria is on AEST. Without a test on an AEDT date, "fixing" the zone to
 * `Australia/Melbourne` looks obviously right and passes everything.
 */

import { describe, it, expect } from "@jest/globals";
import {
  maintenanceWindowOpenForMs,
  type MaintenanceWindow,
} from "../maintenance-window";
import { AmberAdapter } from "../amber/adapter";

const w = (over: Partial<MaintenanceWindow> = {}): MaintenanceWindow => ({
  timezone: "Australia/Brisbane",
  start: "00:05",
  end: "00:35",
  ...over,
});

const MIN = 60_000;
const at = (iso: string) => new Date(iso);
const isIn = (w: MaintenanceWindow, now: Date) =>
  maintenanceWindowOpenForMs(w, now) !== null;

describe("maintenanceWindowOpenForMs", () => {
  it("is inclusive of the start and exclusive of the end", () => {
    expect(isIn(w(), at("2026-09-14T14:04:59Z"))).toBe(false);
    expect(isIn(w(), at("2026-09-14T14:05:00Z"))).toBe(true);
    expect(isIn(w(), at("2026-09-14T14:34:59Z"))).toBe(true);
    expect(isIn(w(), at("2026-09-14T14:35:00Z"))).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    const wrap = w({ start: "23:50", end: "00:10" });
    expect(isIn(wrap, at("2026-09-14T13:49:00Z"))).toBe(false); // 23:49
    expect(isIn(wrap, at("2026-09-14T13:55:00Z"))).toBe(true); // 23:55
    expect(isIn(wrap, at("2026-09-14T14:05:00Z"))).toBe(true); // 00:05
    expect(isIn(wrap, at("2026-09-14T14:15:00Z"))).toBe(false); // 00:15
  });

  // Fail towards alerting, never towards silence: a typo must not quietly disable a monitor.
  it("returns false for a window it cannot make sense of", () => {
    expect(isIn(w({ start: "0:05" }), at("2026-09-14T14:20:00Z"))).toBe(false);
    expect(isIn(w({ end: "24:00" }), at("2026-09-14T14:20:00Z"))).toBe(false);
    expect(
      isIn(w({ start: "00:05", end: "00:05" }), at("2026-09-14T14:05:00Z")),
    ).toBe(false);
    expect(
      isIn(w({ timezone: "Mars/Olympus" }), at("2026-09-14T14:20:00Z")),
    ).toBe(false);
  });

  it("reports how long the window has been open, in whole milliseconds", () => {
    expect(maintenanceWindowOpenForMs(w(), at("2026-09-14T14:05:00Z"))).toBe(0);
    expect(maintenanceWindowOpenForMs(w(), at("2026-09-14T14:20:00Z"))).toBe(
      15 * MIN,
    );
    expect(maintenanceWindowOpenForMs(w(), at("2026-09-14T14:34:00Z"))).toBe(
      29 * MIN,
    );
    expect(
      maintenanceWindowOpenForMs(w(), at("2026-09-14T14:35:00Z")),
    ).toBeNull();
  });

  it("counts elapsed minutes correctly across a midnight wrap", () => {
    const wrap = w({ start: "23:50", end: "00:10" });
    expect(maintenanceWindowOpenForMs(wrap, at("2026-09-14T13:55:00Z"))).toBe(
      5 * MIN,
    ); // 23:55
    expect(maintenanceWindowOpenForMs(wrap, at("2026-09-14T14:05:00Z"))).toBe(
      15 * MIN,
    ); // 00:05
  });

  // `fromDate` silently falls back to the PROCESS zone when handed no zone, which would suppress at
  // whatever time of day the server's clock happened to agree with. Guarded explicitly.
  it("returns null for a missing timezone rather than using the process zone", () => {
    const noZone = { start: "00:05", end: "00:35" } as MaintenanceWindow;
    expect(
      maintenanceWindowOpenForMs(noZone, at("2026-09-14T00:20:00Z")),
    ).toBeNull();
    expect(
      maintenanceWindowOpenForMs(
        w({ timezone: "" }),
        at("2026-09-14T14:20:00Z"),
      ),
    ).toBeNull();
  });

  // A Symbol throws on string coercion, so this pins the `typeof` guard rather than the regex.
  it("does not throw on a non-string time", () => {
    for (const start of [5, Symbol("nope"), null, undefined]) {
      const bad = {
        timezone: "UTC",
        start,
        end: "00:35",
      } as unknown as MaintenanceWindow;
      expect(
        maintenanceWindowOpenForMs(bad, at("2026-09-14T00:20:00Z")),
      ).toBeNull();
    }
  });

  // Wall-clock semantics in a DST-observing zone: documented, not a defect. No vendor declares one
  // today; this pins the behaviour for the first that does.
  // Documented limitation, pinned so it is a decision rather than a surprise: across a fall-back
  // the wall-clock elapsed count jumps BACKWARDS mid-window. Prefer a fixed-offset zone.
  it("reports wall-clock, not elapsed, minutes across a DST transition", () => {
    const melb = w({
      timezone: "Australia/Melbourne",
      start: "01:55",
      end: "03:35",
    });
    expect(maintenanceWindowOpenForMs(melb, at("2026-04-04T15:55:00Z"))).toBe(
      60 * MIN,
    );
    expect(maintenanceWindowOpenForMs(melb, at("2026-04-04T16:00:00Z"))).toBe(
      5 * MIN,
    );
  });

  it("has wall-clock semantics in a DST zone (fires twice on a fall-back day)", () => {
    const melb = w({
      timezone: "Australia/Melbourne",
      start: "02:05",
      end: "02:35",
    });
    // 5 Apr 2026, 02:00 AEDT rewinds to 01:00 AEST — 02:05 local happens once at +11, once at +10.
    expect(isIn(melb, at("2026-04-04T15:20:00Z"))).toBe(true); // 02:20 AEDT
    expect(isIn(melb, at("2026-04-04T16:20:00Z"))).toBe(true); // 02:20 AEST
  });
});

describe("the Amber declaration", () => {
  const amber = new AmberAdapter().maintenanceWindow;

  it("covers 14:05–14:35 UTC in AEST", () => {
    expect(isIn(amber, at("2026-09-14T14:04:00Z"))).toBe(false);
    expect(isIn(amber, at("2026-09-14T14:20:00Z"))).toBe(true);
    expect(isIn(amber, at("2026-09-14T14:40:00Z"))).toBe(false);
  });

  // 🛑 The load-bearing case. In January, Melbourne is UTC+11, so a Melbourne-keyed window would
  // cover 13:05–13:35 UTC and NOT 14:05–14:35. The measurement says otherwise: 677 failed polls
  // across 139 AEDT nights, every one of them in UTC hour 14, none in hour 13.
  it("still covers 14:05–14:35 UTC during daylight saving", () => {
    expect(isIn(amber, at("2026-01-15T14:20:00Z"))).toBe(true);
    expect(isIn(amber, at("2026-01-15T13:20:00Z"))).toBe(false);
  });

  // The window REPLACED a 45-minute staleness budget; keeping both would hand Amber back the
  // all-day blind spot the window exists to avoid.
  it("declares no staleness budget, so it keeps the tight generic cliff", () => {
    expect(new AmberAdapter().staleBudgetMinutes).toBeUndefined();
  });

  it("does not shift across the 5 Apr 2026 DST transition", () => {
    expect(isIn(amber, at("2026-04-04T14:20:00Z"))).toBe(true); // AEDT
    expect(isIn(amber, at("2026-04-06T14:20:00Z"))).toBe(true); // AEST
  });
});
