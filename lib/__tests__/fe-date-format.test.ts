import { describe, it, expect } from "@jest/globals";
import {
  formatHoursAsDuration,
  formatSecondsAsDuration,
  formatTime12h,
} from "@/lib/fe-date-format";

describe("formatTime12h", () => {
  it("spells midnight and noon as 12, not 0", () => {
    expect(formatTime12h({ hour: 0, minute: 0 })).toBe("12:00am");
    expect(formatTime12h({ hour: 12, minute: 0 })).toBe("12:00pm");
  });

  it("drops the leading zero from the hour but keeps it on the minute", () => {
    expect(formatTime12h({ hour: 9, minute: 5 })).toBe("9:05am");
    expect(formatTime12h({ hour: 13, minute: 5 })).toBe("1:05pm");
  });

  it("uses lowercase am/pm with no space", () => {
    expect(formatTime12h({ hour: 22, minute: 34 })).toBe("10:34pm");
  });

  it("keeps ':00' by default and drops it only when asked", () => {
    // The default matters: a lone "4pm" in a table of times reads as truncated.
    expect(formatTime12h({ hour: 16, minute: 0 })).toBe("4:00pm");
    expect(
      formatTime12h({ hour: 16, minute: 0 }, { omitZeroMinutes: true }),
    ).toBe("4pm");
    // Non-zero minutes survive omitZeroMinutes — it drops ":00", never real minutes.
    expect(
      formatTime12h({ hour: 16, minute: 16 }, { omitZeroMinutes: true }),
    ).toBe("4:16pm");
  });

  it("covers every hour of the day without an am/pm slip at the boundaries", () => {
    expect(formatTime12h({ hour: 11, minute: 59 })).toBe("11:59am");
    expect(formatTime12h({ hour: 12, minute: 1 })).toBe("12:01pm");
    expect(formatTime12h({ hour: 23, minute: 59 })).toBe("11:59pm");
  });
});

describe("formatHoursAsDuration", () => {
  it("shows 0h for exactly zero", () => {
    expect(formatHoursAsDuration(0)).toBe("0h");
  });

  it("rounds sub-minute values down to 0h", () => {
    expect(formatHoursAsDuration(0.005)).toBe("0h"); // 0.3 min -> 0
  });

  it("shows minutes with a 0h prefix when under an hour", () => {
    expect(formatHoursAsDuration(0.7167)).toBe("0h43m");
  });

  it("does not zero-pad minutes", () => {
    expect(formatHoursAsDuration(1.0833)).toBe("1h5m");
  });

  it("omits minutes when on a whole hour", () => {
    expect(formatHoursAsDuration(2)).toBe("2h");
  });

  it("rolls into days at >= 24h and drops minutes", () => {
    expect(formatHoursAsDuration(25.1)).toBe("1d1h");
    expect(formatHoursAsDuration(24)).toBe("1d0h");
    expect(formatHoursAsDuration(30.5)).toBe("1d6h");
  });
});

describe("formatSecondsAsDuration", () => {
  it("shows hours and minutes together", () => {
    expect(formatSecondsAsDuration(9000)).toBe("2h 30m");
  });

  it("shows minutes alone under an hour", () => {
    expect(formatSecondsAsDuration(2700)).toBe("45m");
  });

  it("drops the minutes on a whole hour", () => {
    expect(formatSecondsAsDuration(10800)).toBe("3h");
  });

  it("rounds to the nearest minute", () => {
    expect(formatSecondsAsDuration(0)).toBe("0m");
    expect(formatSecondsAsDuration(29)).toBe("0m");
    expect(formatSecondsAsDuration(31)).toBe("1m");
  });
});
