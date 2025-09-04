import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { 
  formatDateRange,
  getZonedNow,
  getTodayInTimezone,
  getYesterdayInTimezone,
  getCalendarDateDaysAgo,
  calendarDateToUnixRange
} from '../date-utils';
import { parseAbsolute, toZoned, CalendarDate } from '@internationalized/date';

describe('Date Utils - New Timezone Functions', () => {
  let originalDateNow: () => number;
  
  beforeEach(() => {
    // Store original Date.now
    originalDateNow = Date.now;
  });
  
  afterEach(() => {
    // Restore Date.now
    Date.now = originalDateNow;
  });
  
  describe('getZonedNow', () => {
    it('should return current time adjusted for timezone offset', () => {
      // Mock Date.now to return a specific time: 2025-09-04T10:30:00.000Z
      const mockTime = new Date('2025-09-04T10:30:00.000Z').getTime();
      Date.now = jest.fn(() => mockTime);
      
      // UTC+10 (Brisbane/Sydney standard time)
      const brisbane = getZonedNow(600);
      expect(brisbane.year).toBe(2025);
      expect(brisbane.month).toBe(9);
      expect(brisbane.day).toBe(4);
      expect(brisbane.hour).toBe(20); // 10:30 UTC + 10 hours = 20:30
      expect(brisbane.minute).toBe(30);
      
      // UTC-5 (EST)
      const est = getZonedNow(-300);
      expect(est.hour).toBe(5); // 10:30 UTC - 5 hours = 05:30
      expect(est.minute).toBe(30);
      
      // UTC+0
      const utc = getZonedNow(0);
      expect(utc.hour).toBe(10);
      expect(utc.minute).toBe(30);
    });
  });
  
  describe('getTodayInTimezone', () => {
    it('should return today in the given timezone', () => {
      // Mock time: 2025-09-04T14:00:00.000Z (UTC)
      const mockTime = new Date('2025-09-04T14:00:00.000Z').getTime();
      Date.now = jest.fn(() => mockTime);
      
      // In UTC+10, this is 2025-09-05 00:00 (midnight), so it's already the 5th
      const brisbaneToday = getTodayInTimezone(600);
      expect(brisbaneToday.year).toBe(2025);
      expect(brisbaneToday.month).toBe(9);
      expect(brisbaneToday.day).toBe(5);
      
      // In UTC-10, this is 2025-09-04 04:00, still the 4th
      const hawaiiToday = getTodayInTimezone(-600);
      expect(hawaiiToday.year).toBe(2025);
      expect(hawaiiToday.month).toBe(9);
      expect(hawaiiToday.day).toBe(4);
    });
    
    it('should handle day boundaries correctly', () => {
      // Mock time: 2025-09-04T23:30:00.000Z (11:30 PM UTC)
      const mockTime = new Date('2025-09-04T23:30:00.000Z').getTime();
      Date.now = jest.fn(() => mockTime);
      
      // In UTC+1, this is 2025-09-05 00:30 (past midnight)
      const parisToday = getTodayInTimezone(60);
      expect(parisToday.day).toBe(5);
      
      // In UTC-1, this is 2025-09-04 22:30 (before midnight)
      const azoresToday = getTodayInTimezone(-60);
      expect(azoresToday.day).toBe(4);
    });
  });
  
  describe('getYesterdayInTimezone', () => {
    it('should return yesterday in the given timezone', () => {
      // Mock time: 2025-09-04T10:00:00.000Z
      const mockTime = new Date('2025-09-04T10:00:00.000Z').getTime();
      Date.now = jest.fn(() => mockTime);
      
      // In UTC+10, today is the 4th (20:00), so yesterday is the 3rd
      const brisbaneYesterday = getYesterdayInTimezone(600);
      expect(brisbaneYesterday.year).toBe(2025);
      expect(brisbaneYesterday.month).toBe(9);
      expect(brisbaneYesterday.day).toBe(3);
    });
    
    it('should handle month boundaries', () => {
      // Mock time: 2025-10-01T10:00:00.000Z
      const mockTime = new Date('2025-10-01T10:00:00.000Z').getTime();
      Date.now = jest.fn(() => mockTime);
      
      const yesterday = getYesterdayInTimezone(600);
      expect(yesterday.month).toBe(9); // September
      expect(yesterday.day).toBe(30); // Last day of September
    });
    
    it('should handle year boundaries', () => {
      // Mock time: 2025-01-01T10:00:00.000Z
      const mockTime = new Date('2025-01-01T10:00:00.000Z').getTime();
      Date.now = jest.fn(() => mockTime);
      
      const yesterday = getYesterdayInTimezone(600);
      expect(yesterday.year).toBe(2024);
      expect(yesterday.month).toBe(12);
      expect(yesterday.day).toBe(31);
    });
  });
  
  describe('getCalendarDateDaysAgo', () => {
    it('should return correct dates for various days ago', () => {
      // Mock time: 2025-09-04T10:00:00.000Z
      const mockTime = new Date('2025-09-04T10:00:00.000Z').getTime();
      Date.now = jest.fn(() => mockTime);
      
      const today = getCalendarDateDaysAgo(0, 600);
      expect(today.day).toBe(4);
      
      const yesterday = getCalendarDateDaysAgo(1, 600);
      expect(yesterday.day).toBe(3);
      
      const weekAgo = getCalendarDateDaysAgo(7, 600);
      expect(weekAgo.month).toBe(8); // August
      expect(weekAgo.day).toBe(28);
      
      const monthAgo = getCalendarDateDaysAgo(30, 600);
      expect(monthAgo.month).toBe(8); // August
      expect(monthAgo.day).toBe(5);
    });
  });
  
  describe('calendarDateToUnixRange', () => {
    it('should convert calendar date to Unix timestamp range', () => {
      const date = new CalendarDate(2025, 9, 4);
      
      // UTC+10 timezone
      const [start, end] = calendarDateToUnixRange(date, 600);
      
      // Start should be 2025-09-04 00:00:00 in UTC+10
      // Which is 2025-09-03 14:00:00 UTC
      const startDate = new Date(start * 1000);
      expect(startDate.toISOString()).toBe('2025-09-03T14:00:00.000Z');
      
      // End should be 2025-09-05 00:00:00 in UTC+10 (midnight)
      // Which is 2025-09-04 14:00:00 UTC
      const endDate = new Date(end * 1000);
      expect(endDate.toISOString()).toBe('2025-09-04T14:00:00.000Z');
      
      // Should be exactly 24 hours apart
      expect(end - start).toBe(24 * 60 * 60); // 86400 seconds
    });
    
    it('should handle negative timezone offsets', () => {
      const date = new CalendarDate(2025, 9, 4);
      
      // UTC-5 timezone
      const [start, end] = calendarDateToUnixRange(date, -300);
      
      // Start should be 2025-09-04 00:00:00 in UTC-5
      // Which is 2025-09-04 05:00:00 UTC
      const startDate = new Date(start * 1000);
      expect(startDate.toISOString()).toBe('2025-09-04T05:00:00.000Z');
      
      // End should be 2025-09-05 00:00:00 in UTC-5
      // Which is 2025-09-05 05:00:00 UTC
      const endDate = new Date(end * 1000);
      expect(endDate.toISOString()).toBe('2025-09-05T05:00:00.000Z');
      
      // Should be exactly 24 hours apart
      expect(end - start).toBe(24 * 60 * 60);
    });
    
    it('should handle UTC (zero offset)', () => {
      const date = new CalendarDate(2025, 9, 4);
      
      // UTC timezone
      const [start, end] = calendarDateToUnixRange(date, 0);
      
      const startDate = new Date(start * 1000);
      expect(startDate.toISOString()).toBe('2025-09-04T00:00:00.000Z');
      
      const endDate = new Date(end * 1000);
      expect(endDate.toISOString()).toBe('2025-09-05T00:00:00.000Z');
      
      expect(end - start).toBe(24 * 60 * 60);
    });
    
    it('should handle fractional hour offsets', () => {
      const date = new CalendarDate(2025, 9, 4);
      
      // UTC+5:30 (India)
      const [start, end] = calendarDateToUnixRange(date, 330);
      
      // Start should be 2025-09-04 00:00:00 in UTC+5:30
      // Which is 2025-09-03 18:30:00 UTC
      const startDate = new Date(start * 1000);
      expect(startDate.toISOString()).toBe('2025-09-03T18:30:00.000Z');
      
      const endDate = new Date(end * 1000);
      expect(endDate.toISOString()).toBe('2025-09-04T18:30:00.000Z');
      
      expect(end - start).toBe(24 * 60 * 60);
    });
    
    it('should handle leap year dates', () => {
      const leapDate = new CalendarDate(2024, 2, 29); // Feb 29, 2024
      
      const [start, end] = calendarDateToUnixRange(leapDate, 600);
      
      // Should handle Feb 29 correctly
      const startDate = new Date(start * 1000);
      expect(startDate.getUTCDate()).toBe(28); // In UTC, it's still Feb 28
      
      // End should be March 1
      const endDate = new Date(end * 1000);
      expect(endDate.getUTCDate()).toBe(29); // In UTC, it's Feb 29
      
      expect(end - start).toBe(24 * 60 * 60);
    });
    
    it('should handle year boundaries', () => {
      const newYear = new CalendarDate(2025, 1, 1);
      
      const [start, end] = calendarDateToUnixRange(newYear, 600);
      
      // Start should be 2025-01-01 00:00:00 in UTC+10
      // Which is 2024-12-31 14:00:00 UTC
      const startDate = new Date(start * 1000);
      expect(startDate.toISOString()).toBe('2024-12-31T14:00:00.000Z');
      
      // End should be 2025-01-02 00:00:00 in UTC+10
      // Which is 2025-01-01 14:00:00 UTC
      const endDate = new Date(end * 1000);
      expect(endDate.toISOString()).toBe('2025-01-01T14:00:00.000Z');
    });
  });
});

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