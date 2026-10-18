import { describe, it, expect } from "@jest/globals";
import { formatOutage, recoveryNotice } from "../recovery";

const KUTIS = {
  id: 13,
  displayName: "Kutis",
  vendorType: "sigenergy",
  displayTimezone: "Australia/Melbourne",
};
const SIGEN = { dataSource: "poll", pollIntervalMinutes: 5 };
const MIN = 60_000;
// 2026-10-17 01:00:30Z = 12:00 AEDT — the poll that ended the Kutis outage.
const RECOVERED = Date.parse("2026-10-17T01:00:30Z");

describe("recoveryNotice", () => {
  it("announces the 17 Oct Kutis recovery, in station time", () => {
    const text = recoveryNotice({
      device: KUTIS,
      adapter: SIGEN,
      prev: {
        prevSuccessMs: RECOVERED - (9 * 60 + 55) * MIN,
        prevConsecutiveErrors: 116,
      },
      recoveredAtMs: RECOVERED,
    });
    expect(text).toBe(
      "✅ sigenergy device 13 (Kutis) recovered at 12:00 AEDT after 9 h 55 m without a successful poll (116 failed polls).",
    );
  });

  it("stays quiet for a blip the monitor never alerted on", () => {
    // Two missed slots: inside the 15 min budget, and under the failing threshold.
    expect(
      recoveryNotice({
        device: KUTIS,
        adapter: SIGEN,
        prev: { prevSuccessMs: RECOVERED - 10 * MIN, prevConsecutiveErrors: 2 },
        recoveredAtMs: RECOVERED,
      }),
    ).toBeNull();
  });

  it("announces a failing streak that alerted before it went stale", () => {
    // `device_failing` alerts at 5 consecutive failures even inside the budget.
    expect(
      recoveryNotice({
        device: KUTIS,
        adapter: { dataSource: "poll", pollIntervalMinutes: 1 },
        prev: { prevSuccessMs: RECOVERED - 2 * MIN, prevConsecutiveErrors: 6 },
        recoveredAtMs: RECOVERED,
      }),
    ).toContain("recovered");
  });

  it("stays quiet when the outage sat inside the vendor's maintenance window", () => {
    // A window open all day; the device went dark inside it, so the monitor only ever warned.
    const adapter = {
      ...SIGEN,
      maintenanceWindow: {
        start: "00:00",
        end: "23:59",
        timezone: "Australia/Melbourne",
      },
    };
    expect(
      recoveryNotice({
        device: KUTIS,
        adapter,
        prev: { prevSuccessMs: RECOVERED - 30 * MIN, prevConsecutiveErrors: 6 },
        recoveredAtMs: RECOVERED,
      }),
    ).toBeNull();
  });

  it("has nothing to say about a first-ever poll or a push device", () => {
    expect(
      recoveryNotice({
        device: KUTIS,
        adapter: SIGEN,
        prev: { prevSuccessMs: null, prevConsecutiveErrors: 0 },
        recoveredAtMs: RECOVERED,
      }),
    ).toBeNull();
    expect(
      recoveryNotice({
        device: KUTIS,
        adapter: { dataSource: "push" },
        prev: {
          prevSuccessMs: RECOVERED - 600 * MIN,
          prevConsecutiveErrors: 0,
        },
        recoveredAtMs: RECOVERED,
      }),
    ).toBeNull();
  });
});

describe("formatOutage", () => {
  it("reads like a person would say it", () => {
    expect(formatOutage(40 * MIN)).toBe("40 m");
    expect(formatOutage(595 * MIN)).toBe("9 h 55 m");
    expect(formatOutage((51 * 60 + 5) * MIN)).toBe("2 d 3 h");
  });
});
