import { describe, it, expect } from "@jest/globals";
import { jsonResponse } from "../json";
import { CalendarDate, parseDate } from "@internationalized/date";

describe("CalendarDate round-trip", () => {
  it("should serialize and parse CalendarDate correctly", () => {
    const original = new CalendarDate(2025, 11, 19);
    const str = original.toString();
    expect(str).toBe("2025-11-19");

    const parsed = parseDate(str);
    expect(parsed.year).toBe(original.year);
    expect(parsed.month).toBe(original.month);
    expect(parsed.day).toBe(original.day);
  });

  it("should handle single-digit months and days with zero padding", () => {
    const date = new CalendarDate(2025, 1, 5);
    expect(date.toString()).toBe("2025-01-05");
  });

  it("should handle leap year dates", () => {
    const date = new CalendarDate(2024, 2, 29);
    expect(date.toString()).toBe("2024-02-29");
  });
});

describe("jsonResponse with CalendarDate", () => {
  it("should serialize CalendarDate to YYYY-MM-DD string", async () => {
    const data = {
      firstDay: new CalendarDate(2025, 11, 19),
      numberOfDays: 1,
    };

    const response = jsonResponse(data);
    const text = await response.text();
    const parsed = JSON.parse(text);

    expect(parsed.firstDay).toBe("2025-11-19");
    expect(parsed.numberOfDays).toBe(1);
  });

  it("should serialize nested CalendarDate objects", async () => {
    const data = {
      audit: {
        systemId: 10001,
        firstDay: new CalendarDate(2025, 11, 19),
        stages: [
          {
            stage: "stage 1",
            info: {
              completeness: "all-billable",
            },
          },
        ],
      },
    };

    const response = jsonResponse(data);
    const text = await response.text();
    const parsed = JSON.parse(text);

    expect(parsed.audit.firstDay).toBe("2025-11-19");
    expect(parsed.audit.systemId).toBe(10001);
  });

  it("should serialize arrays of CalendarDate objects", async () => {
    const data = {
      dates: [
        new CalendarDate(2025, 11, 19),
        new CalendarDate(2025, 11, 20),
        new CalendarDate(2025, 11, 21),
      ],
    };

    const response = jsonResponse(data);
    const text = await response.text();
    const parsed = JSON.parse(text);

    expect(parsed.dates).toEqual(["2025-11-19", "2025-11-20", "2025-11-21"]);
  });

  it("should handle mixed data with CalendarDate, Date, and timestamps", async () => {
    const now = new Date("2025-11-19T10:30:00Z");
    const data = {
      firstDay: new CalendarDate(2025, 11, 19),
      startedAt: now,
      measurementTimeMs: 1731627600000, // 2024-11-14T23:40:00.000Z
      value: 5000,
    };

    const response = jsonResponse(data, 600); // AEST = UTC+10
    const text = await response.text();
    const parsed = JSON.parse(text);

    expect(parsed.firstDay).toBe("2025-11-19");
    expect(parsed.startedAt).toBe("2025-11-19T20:30:00+10:00"); // UTC+10
    expect(parsed.measurementTime).toBe("2024-11-15T09:40:00+10:00"); // Unix timestamp converted (UTC+10)
    expect(parsed.measurementTimeMs).toBeUndefined(); // "Ms" suffix removed
    expect(parsed.value).toBe(5000);
  });

  it("should preserve null and undefined values", async () => {
    const data = {
      firstDay: new CalendarDate(2025, 11, 19),
      nullValue: null,
      undefinedValue: undefined,
    };

    const response = jsonResponse(data);
    const text = await response.text();
    const parsed = JSON.parse(text);

    expect(parsed.firstDay).toBe("2025-11-19");
    expect(parsed.nullValue).toBe(null);
    expect(parsed.undefinedValue).toBeUndefined();
  });
});
