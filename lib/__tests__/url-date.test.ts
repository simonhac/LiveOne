import { describe, it, expect } from "@jest/globals";
import {
  decodeUrlSafeStringToI18n,
  encodeI18nToUrlSafeString,
  encodeUrlDate,
  decodeUrlDate,
  decodeUrlDateToEpoch,
  decodeUrlOffset,
  UrlDateFormatError,
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

/**
 * The strict decoders. These are fed straight from the address bar, so "unparseable" is a routine
 * input, not an exceptional one — but it must arrive as a TYPED error rather than as a NaN that
 * detonates later. See `decodeRangeFromParams`, which recovers from `UrlDateFormatError` and only
 * from `UrlDateFormatError`.
 */
describe("decodeUrlDate", () => {
  it("decodes the canonical date-only form as local start-of-day", () => {
    expect(decodeUrlDate("2026-08-24", 600)).toBe("2026-08-23T14:00:00.000Z");
  });

  it("decodes the canonical date-time form", () => {
    expect(decodeUrlDate("2025-11-02_14.15", 600)).toBe(
      "2025-11-02T04:15:00.000Z",
    );
  });

  // The reported crash: a colon where the format wants a dot. This used to reach
  // `Number("00:00") -> NaN` and throw a bare `RangeError: Invalid time value` out of a render.
  it("rejects a colon-separated time (the reported bad URL) with a typed error", () => {
    expect(() => decodeUrlDate("2026-08-24_00:00", 600)).toThrow(
      UrlDateFormatError,
    );
    try {
      decodeUrlDate("2026-08-24_00:00", 600);
    } catch (err) {
      expect((err as UrlDateFormatError).value).toBe("2026-08-24_00:00");
    }
  });

  it.each([
    ["empty", ""],
    ["nonsense", "abc"],
    ["hyphen time separator", "2026-08-24_00-00"],
    ["ISO T separator", "2026-08-24T00:00"],
    ["space separator", "2026-08-24 00:00"],
    ["full ISO instant", "2026-08-24T00:00:00Z"],
    ["trailing separator", "2026-08-24_"],
    ["unpadded components", "2026-8-4_9.5"],
    ["impossible day", "2026-02-31"],
    ["impossible month", "2026-13-01"],
    ["hour out of range", "2026-08-24_25.00"],
    ["minute out of range", "2026-08-24_00.60"],
    ["embedded timezone", "2025-11-02_14.15T10"],
  ])("rejects %s (%s)", (_label, input) => {
    expect(() => decodeUrlDate(input, 600)).toThrow(UrlDateFormatError);
  });

  // A non-finite offset comes from area config, not the URL — a bug on our side. It must NOT look
  // like bad user input, or `decodeRangeFromParams` would quietly swap it for "the last 24 hours".
  it("throws a plain Error (NOT UrlDateFormatError) for a non-finite offset", () => {
    expect(() => decodeUrlDate("2026-08-24_00.00", NaN)).toThrow(Error);
    expect(() => decodeUrlDate("2026-08-24_00.00", NaN)).not.toThrow(
      UrlDateFormatError,
    );
  });

  it.each([600, -300, 570])("round-trips through encodeUrlDate (%i)", (off) => {
    const iso = "2025-11-02T04:15:00.000Z";
    expect(decodeUrlDate(encodeUrlDate(iso, off), off)).toBe(iso);
  });

  // The admin readings route turns this throw into a 400. Keep it throwing.
  it("still throws via decodeUrlDateToEpoch, which the admin route relies on for its 400", () => {
    expect(() => decodeUrlDateToEpoch("garbage", 600)).toThrow(
      UrlDateFormatError,
    );
    expect(decodeUrlDateToEpoch("2026-08-24", 600)).toBe(
      Date.parse("2026-08-23T14:00:00.000Z"),
    );
  });
});

describe("decodeUrlOffset", () => {
  it.each([
    ["600m", 600],
    ["-300m", -300],
    ["570m", 570],
    ["0m", 0],
  ])("decodes %s", (input, expected) => {
    expect(decodeUrlOffset(input as string)).toBe(expected);
  });

  it.each([
    ["missing unit", "600"],
    ["nonsense", "abc"],
    ["empty", ""],
    ["doubled unit", "600mm"],
    ["out of range", "9999m"],
  ])("rejects %s (%s)", (_label, input) => {
    expect(() => decodeUrlOffset(input)).toThrow(UrlDateFormatError);
  });
});
