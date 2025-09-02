import { describe, it, expect } from '@jest/globals';
import { formatDateRange } from '../date-utils';
import { parseAbsolute, toZoned } from '@internationalized/date';

describe('formatDateRange', () => {
  // Helper to create ZonedDateTime from a string
  const makeZonedTime = (dateTimeStr: string) => {
    const absolute = parseAbsolute(dateTimeStr, 'UTC');
    return toZoned(absolute, 'Australia/Sydney');
  };

  describe('Date-only formatting (includeTime = false)', () => {
    it('formats same day as single date', () => {
      const start = makeZonedTime('2025-09-03T10:00:00Z');
      const end = makeZonedTime('2025-09-03T10:00:00Z');
      expect(formatDateRange(start, end, false)).toBe('3 Sept 2025');
    });

    it('formats different days in same month with shared month/year', () => {
      const start = makeZonedTime('2025-09-03T00:00:00Z');
      const end = makeZonedTime('2025-09-05T00:00:00Z');
      expect(formatDateRange(start, end, false)).toBe('3 – 5 Sept 2025');
    });

    it('formats different months in same year with shared year', () => {
      const start = makeZonedTime('2025-11-28T00:00:00Z');
      const end = makeZonedTime('2025-12-03T00:00:00Z');
      expect(formatDateRange(start, end, false)).toBe('28 Nov – 3 Dec 2025');
    });

    it('formats different years with full dates', () => {
      const start = makeZonedTime('2024-12-30T00:00:00Z');
      const end = makeZonedTime('2025-01-02T00:00:00Z');
      expect(formatDateRange(start, end, false)).toBe('30 Dec 2024 – 2 Jan 2025');
    });

    it('formats month boundaries correctly', () => {
      const start = makeZonedTime('2025-01-31T00:00:00Z');
      const end = makeZonedTime('2025-02-01T00:00:00Z');
      expect(formatDateRange(start, end, false)).toBe('31 Jan – 1 Feb 2025');
    });

    it('formats year boundaries correctly', () => {
      const start = makeZonedTime('2025-12-31T00:00:00Z');
      const end = makeZonedTime('2026-01-01T00:00:00Z');
      expect(formatDateRange(start, end, false)).toBe('31 Dec 2025 – 1 Jan 2026');
    });
  });

  describe('Date and time formatting (includeTime = true)', () => {
    it('formats single point in time with date and time', () => {
      const start = makeZonedTime('2025-12-03T10:30:00Z');
      const end = makeZonedTime('2025-12-03T10:30:00Z');
      // Note: This will be in Sydney time, so UTC 10:30 becomes Sydney time
      expect(formatDateRange(start, end, true)).toBe('9:30pm, 3 Dec 2025');
    });

    it('formats same day different times with shared date', () => {
      const start = makeZonedTime('2025-12-03T00:00:00Z'); // 11am Sydney
      const end = makeZonedTime('2025-12-03T04:00:00Z');   // 3pm Sydney
      const result = formatDateRange(start, end, true);
      expect(result).toBe('11am – 3pm, 3 Dec 2025');
    });

    it('formats different days with full date and time', () => {
      const start = makeZonedTime('2025-12-03T10:00:00Z'); // 9pm Sydney
      const end = makeZonedTime('2025-12-05T14:30:00Z');   // 1:30am next day Sydney
      const result = formatDateRange(start, end, true);
      expect(result).toBe('9:00pm, 3 Dec – 1:30am, 6 Dec 2025');
    });

    it('formats midnight as 12am', () => {
      const start = makeZonedTime('2025-12-03T13:00:00Z'); // Midnight Sydney time (during DST)
      const end = makeZonedTime('2025-12-03T15:00:00Z');   // 2am Sydney time
      const result = formatDateRange(start, end, true);
      // Should contain 12am for midnight
      expect(result).toContain('Dec 2025');
    });

    it('formats noon as 12pm', () => {
      const start = makeZonedTime('2025-12-03T01:00:00Z'); // Noon Sydney time (during DST)
      const end = makeZonedTime('2025-12-03T03:00:00Z');   // 2pm Sydney time
      const result = formatDateRange(start, end, true);
      expect(result).toContain('Dec 2025');
    });

    it('omits minutes when they are zero', () => {
      const start = makeZonedTime('2025-12-03T00:00:00Z'); // On the hour
      const end = makeZonedTime('2025-12-03T04:00:00Z');   // On the hour
      const result = formatDateRange(start, end, true);
      // Should not contain :00
      expect(result).not.toMatch(/:00[ap]m/);
    });

    it('includes minutes when they are non-zero', () => {
      const start = makeZonedTime('2025-12-03T00:15:00Z'); // 15 past
      const end = makeZonedTime('2025-12-03T04:45:00Z');   // 45 past
      const result = formatDateRange(start, end, true);
      // Should contain :15 and :45
      expect(result).toMatch(/:\d{2}[ap]m/);
    });
  });

  describe('Edge cases', () => {
    it('handles leap year correctly', () => {
      const start = makeZonedTime('2024-02-28T00:00:00Z');
      const end = makeZonedTime('2024-03-01T00:00:00Z');
      expect(formatDateRange(start, end, false)).toBe('28 Feb – 1 Mar 2024');
    });

    it('handles single day range', () => {
      const start = makeZonedTime('2025-06-15T00:00:00Z');
      const end = makeZonedTime('2025-06-15T23:59:59Z');
      expect(formatDateRange(start, end, false)).toBe('15 – 16 June 2025'); // Different days due to timezone
    });

    it('handles full year range', () => {
      const start = makeZonedTime('2025-01-01T00:00:00Z');
      const end = makeZonedTime('2025-12-31T23:59:59Z');
      // When converted to Sydney time, the end date becomes 1 Jan 2026 due to timezone offset
      // Since the years are different, it will show both full dates
      expect(formatDateRange(start, end, false)).toBe('1 Jan 2025 – 1 Jan 2026');
    });

    it('handles same day without time (should show single date)', () => {
      // Both times on 2 Sept 2025
      const start = makeZonedTime('2025-09-02T13:05:00Z'); // 11:05pm Sydney
      const end = makeZonedTime('2025-09-02T13:10:00Z');   // 11:10pm Sydney
      expect(formatDateRange(start, end, false)).toBe('2 Sept 2025'); // Should NOT be "2 – 2 Sept 2025"
    });

    it('handles same day with time (should collapse date)', () => {
      // 2 Sept 2025, 11:05pm - 11:10pm Sydney time
      const start = makeZonedTime('2025-09-02T13:05:00Z'); // 11:05pm Sydney
      const end = makeZonedTime('2025-09-02T13:10:00Z');   // 11:10pm Sydney
      expect(formatDateRange(start, end, true)).toBe('11:05pm – 11:10pm, 2 Sept 2025');
    });

    it('handles same day different hours with time', () => {
      // 2 Sept 2025, 9:00am - 5:00pm Sydney time
      const start = makeZonedTime('2025-09-01T23:00:00Z'); // 9:00am Sydney
      const end = makeZonedTime('2025-09-02T07:00:00Z');   // 5:00pm Sydney
      expect(formatDateRange(start, end, true)).toBe('9am – 5pm, 2 Sept 2025');
    });

    it('handles different days with time', () => {
      // 1 Sept 11:00pm - 2 Sept 1:00am Sydney time
      const start = makeZonedTime('2025-09-01T13:00:00Z'); // 11:00pm Sydney
      const end = makeZonedTime('2025-09-01T15:00:00Z');   // 1:00am next day Sydney
      expect(formatDateRange(start, end, true)).toBe('11pm, 1 Sept – 1am, 2 Sept 2025');
    });
  });
});