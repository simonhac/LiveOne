import { describe, it, expect } from "@jest/globals";
import {
  decodeUrlSafeStringToI18n,
  encodeI18nToUrlSafeString,
} from "../url-date";
import { CalendarDate, parseAbsolute, toZoned } from "@internationalized/date";

describe("URL Safe String I18n Functions", () => {
  describe("decodeUrlSafeStringToI18n", () => {
    describe("Date-only format", () => {
      it("should decode YYYY-MM-DD to CalendarDate", () => {
        const result = decodeUrlSafeStringToI18n("2025-11-02");

        expect(result).toBeInstanceOf(CalendarDate);
        const calDate = result as CalendarDate;
        expect(calDate.year).toBe(2025);
        expect(calDate.month).toBe(11);
        expect(calDate.day).toBe(2);
      });

      it("should handle leap year dates", () => {
        const result = decodeUrlSafeStringToI18n("2024-02-29");

        expect(result).toBeInstanceOf(CalendarDate);
        const calDate = result as CalendarDate;
        expect(calDate.year).toBe(2024);
        expect(calDate.month).toBe(2);
        expect(calDate.day).toBe(29);
      });
    });

    describe("DateTime format with timezoneOffsetMin parameter", () => {
      it("should decode YYYY-MM-DD_HH.MM with positive offset", () => {
        const result = decodeUrlSafeStringToI18n("2025-11-02_14.15", 600); // UTC+10

        expect("hour" in result).toBe(true);
        const zonedTime = result as any;
        expect(zonedTime.year).toBe(2025);
        expect(zonedTime.month).toBe(11);
        expect(zonedTime.day).toBe(2);
        expect(zonedTime.hour).toBe(14);
        expect(zonedTime.minute).toBe(15);
        expect(zonedTime.offset).toBe(600 * 60 * 1000); // offset in milliseconds
      });

      it("should decode YYYY-MM-DD_HH.MM with negative offset", () => {
        const result = decodeUrlSafeStringToI18n("2025-11-02_14.15", -300); // UTC-5

        const zonedTime = result as any;
        expect(zonedTime.hour).toBe(14);
        expect(zonedTime.minute).toBe(15);
        expect(zonedTime.offset).toBe(-300 * 60 * 1000);
      });

      it("should throw error when timezoneOffsetMin is missing", () => {
        expect(() => {
          decodeUrlSafeStringToI18n("2025-11-02_14.15");
        }).toThrow("timezoneOffsetMin is required");
      });
    });

    describe("DateTime format with embedded timezone", () => {
      it("should decode YYYY-MM-DD_HH.MMTHH.MM format", () => {
        const result = decodeUrlSafeStringToI18n("2025-11-02_14.15T10.00");

        const zonedTime = result as any;
        expect(zonedTime.year).toBe(2025);
        expect(zonedTime.month).toBe(11);
        expect(zonedTime.day).toBe(2);
        expect(zonedTime.hour).toBe(14);
        expect(zonedTime.minute).toBe(15);
        expect(zonedTime.offset).toBe(10 * 60 * 60 * 1000); // +10:00 in milliseconds
      });

      it("should decode YYYY-MM-DD_HH.MMTHH format (no minutes)", () => {
        const result = decodeUrlSafeStringToI18n("2025-11-02_14.15T10");

        const zonedTime = result as any;
        expect(zonedTime.hour).toBe(14);
        expect(zonedTime.minute).toBe(15);
        expect(zonedTime.offset).toBe(10 * 60 * 60 * 1000); // +10:00 in milliseconds
      });

      it("should decode with fractional hour timezone", () => {
        const result = decodeUrlSafeStringToI18n("2025-11-02_14.15T9.30");

        const zonedTime = result as any;
        expect(zonedTime.offset).toBe(9.5 * 60 * 60 * 1000); // +9:30 in milliseconds
      });

      it("should decode with negative timezone", () => {
        const result = decodeUrlSafeStringToI18n("2025-11-02_14.15T-5.00");

        const zonedTime = result as any;
        expect(zonedTime.offset).toBe(-5 * 60 * 60 * 1000); // -5:00 in milliseconds
      });
    });

    describe("Error cases", () => {
      it("should throw error for invalid format", () => {
        expect(() => {
          decodeUrlSafeStringToI18n("invalid-date");
        }).toThrow("Invalid URL date format");
      });

      it("should throw error for incomplete datetime", () => {
        expect(() => {
          decodeUrlSafeStringToI18n("2025-11-02_14");
        }).toThrow("Invalid URL date format");
      });
    });
  });

  describe("encodeI18nToUrlSafeString", () => {
    describe("CalendarDate encoding", () => {
      it("should encode CalendarDate to date-only string", () => {
        const date = new CalendarDate(2025, 11, 2);
        const result = encodeI18nToUrlSafeString(date);

        expect(result).toBe("2025-11-02");
      });

      it("should encode single-digit month and day with padding", () => {
        const date = new CalendarDate(2025, 1, 5);
        const result = encodeI18nToUrlSafeString(date);

        expect(result).toBe("2025-01-05");
      });
    });

    describe("ZonedDateTime encoding without embedded timezone", () => {
      it("should return tuple with offset for includeOffsetInString=false", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00+10:00", "+10:00");
        const zoned = toZoned(absolute, "+10:00");
        const result = encodeI18nToUrlSafeString(zoned, false);

        expect(Array.isArray(result)).toBe(true);
        const [dateStr, offset] = result as [string, number];
        expect(dateStr).toBe("2025-11-02_14.15");
        expect(offset).toBe(600); // +10:00 = 600 minutes
      });

      it("should handle negative timezone offsets", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00-05:00", "-05:00");
        const zoned = toZoned(absolute, "-05:00");
        const result = encodeI18nToUrlSafeString(zoned, false);

        const [dateStr, offset] = result as [string, number];
        expect(dateStr).toBe("2025-11-02_14.15");
        expect(offset).toBe(-300); // -5:00 = -300 minutes
      });

      it("should handle fractional hour timezone", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00+09:30", "+09:30");
        const zoned = toZoned(absolute, "+09:30");
        const result = encodeI18nToUrlSafeString(zoned, false);

        const [dateStr, offset] = result as [string, number];
        expect(dateStr).toBe("2025-11-02_14.15");
        expect(offset).toBe(570); // +9:30 = 570 minutes
      });
    });

    describe("ZonedDateTime encoding with embedded timezone", () => {
      it("should return string with THH.MM for includeOffsetInString=true", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00+10:00", "+10:00");
        const zoned = toZoned(absolute, "+10:00");
        const result = encodeI18nToUrlSafeString(zoned, true);

        expect(typeof result).toBe("string");
        expect(result).toBe("2025-11-02_14.15T10");
      });

      it("should return string with THH for whole hour timezones", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00+05:00", "+05:00");
        const zoned = toZoned(absolute, "+05:00");
        const result = encodeI18nToUrlSafeString(zoned, true);

        expect(result).toBe("2025-11-02_14.15T5");
      });

      it("should include fractional minutes in timezone", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00+09:30", "+09:30");
        const zoned = toZoned(absolute, "+09:30");
        const result = encodeI18nToUrlSafeString(zoned, true);

        expect(result).toBe("2025-11-02_14.15T9.30");
      });

      it("should handle negative timezone", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00-05:00", "-05:00");
        const zoned = toZoned(absolute, "-05:00");
        const result = encodeI18nToUrlSafeString(zoned, true);

        expect(result).toBe("2025-11-02_14.15T-5");
      });
    });

    describe("Round-trip encoding/decoding", () => {
      it("should round-trip CalendarDate", () => {
        const original = new CalendarDate(2025, 11, 2);
        const encoded = encodeI18nToUrlSafeString(original) as string;
        const decoded = decodeUrlSafeStringToI18n(encoded) as CalendarDate;

        expect(decoded.year).toBe(original.year);
        expect(decoded.month).toBe(original.month);
        expect(decoded.day).toBe(original.day);
      });

      it("should round-trip ZonedDateTime with embedded timezone", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00+10:00", "+10:00");
        const original = toZoned(absolute, "+10:00");
        const encoded = encodeI18nToUrlSafeString(original, true) as string;
        const decoded = decodeUrlSafeStringToI18n(encoded) as any;

        expect(decoded.year).toBe(original.year);
        expect(decoded.month).toBe(original.month);
        expect(decoded.day).toBe(original.day);
        expect(decoded.hour).toBe(original.hour);
        expect(decoded.minute).toBe(original.minute);
        expect(decoded.offset).toBe(original.offset);
      });

      it("should round-trip ZonedDateTime with separate offset", () => {
        const absolute = parseAbsolute("2025-11-02T14:15:00+10:00", "+10:00");
        const original = toZoned(absolute, "+10:00");
        const encoded = encodeI18nToUrlSafeString(original, false) as [
          string,
          number,
        ];
        const [dateStr, offsetMin] = encoded;
        const decoded = decodeUrlSafeStringToI18n(dateStr, offsetMin) as any;

        expect(decoded.year).toBe(original.year);
        expect(decoded.month).toBe(original.month);
        expect(decoded.day).toBe(original.day);
        expect(decoded.hour).toBe(original.hour);
        expect(decoded.minute).toBe(original.minute);
        expect(decoded.offset).toBe(original.offset);
      });
    });
  });
});
