import { describe, test, expect } from '@jest/globals';
import { 
  parseTimeRange, 
  parseDateRange, 
  parseRelativeTime,
  formatDateAEST,
  formatTimeAEST,
  fromUnixTimestamp,
  getYesterdayDate
} from '@/lib/date-utils';
import { CalendarDate, ZonedDateTime } from '@internationalized/date';

describe('parseTimeRange', () => {
  const systemOffset = 10; // AEST

  test('parses ISO8601 datetime with timezone', () => {
    const [start, end] = parseTimeRange(
      '2025-08-16T10:00:00+10:00',
      '2025-08-16T15:00:00+10:00',
      systemOffset
    );
    
    expect(start).toBeInstanceOf(ZonedDateTime);
    expect(end).toBeInstanceOf(ZonedDateTime);
    expect(start.toString()).toContain('2025-08-16T10:00:00');
    expect(end.toString()).toContain('2025-08-16T15:00:00');
  });

  test('parses ISO8601 datetime without timezone (assumes UTC)', () => {
    const [start, end] = parseTimeRange(
      '2025-08-16T00:00:00',
      '2025-08-16T05:00:00',
      systemOffset
    );
    
    expect(start).toBeInstanceOf(ZonedDateTime);
    expect(end).toBeInstanceOf(ZonedDateTime);
    // 00:00 UTC is 10:00 AEST
    expect(start.toString()).toContain('2025-08-16T10:00:00');
    expect(end.toString()).toContain('2025-08-16T15:00:00');
  });

  test('parses date-only strings as start and end of day', () => {
    const [start, end] = parseTimeRange(
      '2025-08-16',
      '2025-08-17',
      systemOffset
    );
    
    expect(start).toBeInstanceOf(ZonedDateTime);
    expect(end).toBeInstanceOf(ZonedDateTime);
    // Start should be 00:00:00 on Aug 16 in system timezone
    expect(start.toString()).toContain('2025-08-16T00:00:00');
    // End should be 00:00:00 on Aug 18 (end of Aug 17) in system timezone
    expect(end.toString()).toContain('2025-08-18T00:00:00');
  });

  test('handles mixed date and datetime inputs', () => {
    const [start, end] = parseTimeRange(
      '2025-08-16',
      '2025-08-17T12:00:00Z',
      systemOffset
    );
    
    expect(start).toBeInstanceOf(ZonedDateTime);
    expect(end).toBeInstanceOf(ZonedDateTime);
    expect(start.toString()).toContain('2025-08-16T00:00:00');
    // 12:00 UTC is 22:00 AEST
    expect(end.toString()).toContain('2025-08-17T22:00:00');
  });

  test('handles different timezone offsets', () => {
    const [start, end] = parseTimeRange(
      '2025-08-16T10:00:00-05:00',
      '2025-08-16T15:00:00-05:00',
      systemOffset
    );
    
    expect(start).toBeInstanceOf(ZonedDateTime);
    expect(end).toBeInstanceOf(ZonedDateTime);
    // 10:00 EST (-5) is 01:00 next day in AEST (+10)
    expect(start.toString()).toContain('2025-08-17T01:00:00');
    expect(end.toString()).toContain('2025-08-17T06:00:00');
  });
});

describe('parseDateRange', () => {
  test('parses valid date strings', () => {
    const [start, end] = parseDateRange('2025-08-16', '2025-08-20');
    
    expect(start).toBeInstanceOf(CalendarDate);
    expect(end).toBeInstanceOf(CalendarDate);
    expect(formatDateAEST(start)).toBe('2025-08-16');
    expect(formatDateAEST(end)).toBe('2025-08-20');
  });

  test('accepts same start and end date', () => {
    const [start, end] = parseDateRange('2025-08-16', '2025-08-16');
    
    expect(formatDateAEST(start)).toBe('2025-08-16');
    expect(formatDateAEST(end)).toBe('2025-08-16');
  });

  test('rejects datetime strings', () => {
    expect(() => {
      parseDateRange('2025-08-16T10:00:00', '2025-08-20');
    }).toThrow('Invalid start date format');

    expect(() => {
      parseDateRange('2025-08-16', '2025-08-20T10:00:00');
    }).toThrow('Invalid end date format');
  });

  test('rejects invalid date formats', () => {
    expect(() => {
      parseDateRange('08/16/2025', '08/20/2025');
    }).toThrow('Invalid start date format');

    expect(() => {
      parseDateRange('2025-8-16', '2025-8-20');
    }).toThrow('Invalid start date format');

    expect(() => {
      parseDateRange('20250816', '20250820');
    }).toThrow('Invalid start date format');
  });

  test('rejects end date before start date', () => {
    expect(() => {
      parseDateRange('2025-08-20', '2025-08-16');
    }).toThrow('Start date (2025-08-20) must be before or equal to end date (2025-08-16)');
  });
});

describe('parseRelativeTime', () => {
  const systemOffset = 10;

  describe('for daily intervals (1d)', () => {
    test('parses days correctly', () => {
      const [start, end] = parseRelativeTime('7d', '1d', systemOffset);
      
      expect(start).toBeInstanceOf(CalendarDate);
      expect(end).toBeInstanceOf(CalendarDate);
      
      const endDate = end as CalendarDate;
      const startDate = start as CalendarDate;
      
      // Should be 7 days total (including today)
      const dayDiff = endDate.toDate('UTC').getTime() - startDate.toDate('UTC').getTime();
      expect(dayDiff).toBe(6 * 24 * 60 * 60 * 1000); // 6 days difference (7 days inclusive)
    });

    test('includes today in the range', () => {
      const [start, end] = parseRelativeTime('1d', '1d', systemOffset);
      
      const startDate = start as CalendarDate;
      const endDate = end as CalendarDate;
      
      // Start and end should be the same (today)
      expect(formatDateAEST(startDate)).toBe(formatDateAEST(endDate));
    });

    test('rejects hours for daily intervals', () => {
      expect(() => {
        parseRelativeTime('24h', '1d', systemOffset);
      }).toThrow('Hours and minutes not supported for daily intervals');
    });

    test('rejects minutes for daily intervals', () => {
      expect(() => {
        parseRelativeTime('30m', '1d', systemOffset);
      }).toThrow('Hours and minutes not supported for daily intervals');
    });
  });

  describe('for minute intervals (5m, 30m)', () => {
    test('parses days correctly', () => {
      const [start, end] = parseRelativeTime('7d', '5m', systemOffset);
      
      expect(start).toBeInstanceOf(ZonedDateTime);
      expect(end).toBeInstanceOf(ZonedDateTime);
      
      const startTime = start as ZonedDateTime;
      const endTime = end as ZonedDateTime;
      
      // Should be exactly 7 days
      const diff = endTime.toAbsoluteString().localeCompare(startTime.toAbsoluteString());
      expect(diff).toBeGreaterThan(0);
    });

    test('parses hours correctly', () => {
      const [start, end] = parseRelativeTime('24h', '5m', systemOffset);
      
      expect(start).toBeInstanceOf(ZonedDateTime);
      expect(end).toBeInstanceOf(ZonedDateTime);
    });

    test('parses minutes correctly', () => {
      const [start, end] = parseRelativeTime('30m', '5m', systemOffset);
      
      expect(start).toBeInstanceOf(ZonedDateTime);
      expect(end).toBeInstanceOf(ZonedDateTime);
    });
    
    test('aligns to 5-minute boundaries for 5m interval', () => {
      const [start, end] = parseRelativeTime('2h', '5m', systemOffset);
      
      const startTime = start as ZonedDateTime;
      const endTime = end as ZonedDateTime;
      
      // Both should be aligned to 5-minute boundaries
      expect(startTime.minute % 5).toBe(0);
      expect(startTime.second).toBe(0);
      expect(endTime.minute % 5).toBe(0);
      expect(endTime.second).toBe(0);
    });
    
    test('aligns to 30-minute boundaries for 30m interval', () => {
      const [start, end] = parseRelativeTime('4h', '30m', systemOffset);
      
      const startTime = start as ZonedDateTime;
      const endTime = end as ZonedDateTime;
      
      // Both should be aligned to 30-minute boundaries
      expect(startTime.minute % 30).toBe(0);
      expect(startTime.second).toBe(0);
      expect(endTime.minute % 30).toBe(0);
      expect(endTime.second).toBe(0);
    });
    
    test('maintains exact duration after alignment', () => {
      const [start, end] = parseRelativeTime('24h', '30m', systemOffset);
      
      const startTime = start as ZonedDateTime;
      const endTime = end as ZonedDateTime;
      
      // The difference should be exactly 24 hours
      const diffMs = endTime.toDate().getTime() - startTime.toDate().getTime();
      expect(diffMs).toBe(24 * 60 * 60 * 1000);
    });
  });

  test('rejects invalid format', () => {
    expect(() => {
      parseRelativeTime('7 days', '1d', systemOffset);
    }).toThrow('Invalid relative time format');

    expect(() => {
      parseRelativeTime('7', '1d', systemOffset);
    }).toThrow('Invalid relative time format');

    expect(() => {
      parseRelativeTime('d7', '1d', systemOffset);
    }).toThrow('Invalid relative time format');
  });

  test('rejects invalid units', () => {
    expect(() => {
      parseRelativeTime('7w', '1d', systemOffset);
    }).toThrow('Invalid relative time format');

    expect(() => {
      parseRelativeTime('7y', '1d', systemOffset);
    }).toThrow('Invalid relative time format');
  });
});

describe('getYesterdayDate', () => {
  test('returns yesterday in AEST timezone', () => {
    // Mock a specific date for consistent testing
    const originalDate = Date;
    const mockDate = new Date('2025-08-22T01:00:00Z'); // 11:00 AM AEST on Aug 22
    global.Date = class extends originalDate {
      constructor() {
        super();
        return mockDate;
      }
      static now() {
        return mockDate.getTime();
      }
    } as any;

    try {
      // 600 minutes = 10 hours offset for AEST
      const yesterday = getYesterdayDate(600);
      expect(yesterday).toBe('2025-08-21');
    } finally {
      global.Date = originalDate;
    }
  });

  test('handles timezone offset correctly when UTC day differs', () => {
    const originalDate = Date;
    // Set time to just after midnight UTC (10:30 AM AEST on Aug 22)
    const mockDate = new Date('2025-08-22T00:30:00Z');
    global.Date = class extends originalDate {
      constructor() {
        super();
        return mockDate;
      }
      static now() {
        return mockDate.getTime();
      }
    } as any;

    try {
      // In AEST (UTC+10), it's Aug 22, so yesterday is Aug 21
      const yesterdayAEST = getYesterdayDate(600);
      expect(yesterdayAEST).toBe('2025-08-21');
      
      // In PST (UTC-8), it's still Aug 21, so yesterday is Aug 20
      const yesterdayPST = getYesterdayDate(-480);
      expect(yesterdayPST).toBe('2025-08-20');
    } finally {
      global.Date = originalDate;
    }
  });

  test('handles negative timezone offsets', () => {
    const originalDate = Date;
    const mockDate = new Date('2025-08-22T12:00:00Z'); // Noon UTC
    global.Date = class extends originalDate {
      constructor() {
        super();
        return mockDate;
      }
      static now() {
        return mockDate.getTime();
      }
    } as any;

    try {
      // In EST (UTC-5), it's 7 AM on Aug 22, so yesterday is Aug 21
      const yesterdayEST = getYesterdayDate(-300);
      expect(yesterdayEST).toBe('2025-08-21');
    } finally {
      global.Date = originalDate;
    }
  });

  test('formats date with zero-padding', () => {
    const originalDate = Date;
    // Early January
    const mockDate = new Date('2025-01-02T12:00:00Z');
    global.Date = class extends originalDate {
      constructor() {
        super();
        return mockDate;
      }
      static now() {
        return mockDate.getTime();
      }
    } as any;

    try {
      const yesterday = getYesterdayDate(0); // UTC
      expect(yesterday).toBe('2025-01-01');
      expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      global.Date = originalDate;
    }
  });

  test('handles year boundary correctly', () => {
    const originalDate = Date;
    // January 1st at noon UTC
    const mockDate = new Date('2025-01-01T12:00:00Z');
    global.Date = class extends originalDate {
      constructor() {
        super();
        return mockDate;
      }
      static now() {
        return mockDate.getTime();
      }
    } as any;

    try {
      const yesterday = getYesterdayDate(0); // UTC
      expect(yesterday).toBe('2024-12-31');
    } finally {
      global.Date = originalDate;
    }
  });

  test('handles month boundary correctly', () => {
    const originalDate = Date;
    // March 1st (testing February edge case)
    const mockDate = new Date('2025-03-01T12:00:00Z');
    global.Date = class extends originalDate {
      constructor() {
        super();
        return mockDate;
      }
      static now() {
        return mockDate.getTime();
      }
    } as any;

    try {
      const yesterday = getYesterdayDate(0); // UTC
      expect(yesterday).toBe('2025-02-28'); // 2025 is not a leap year
    } finally {
      global.Date = originalDate;
    }
  });

  test('requires timezone offset parameter', () => {
    // TypeScript should enforce this, but we can test runtime behavior
    // The function signature requires the parameter, so this is mainly
    // for documentation purposes
    expect(getYesterdayDate).toHaveLength(1);
  });
});

describe('date formatting', () => {
  describe('formatDateAEST', () => {
    test('formats CalendarDate correctly', () => {
      const date = new CalendarDate(2025, 8, 16);
      expect(formatDateAEST(date)).toBe('2025-08-16');
    });

    test('handles single digit months and days', () => {
      const date = new CalendarDate(2025, 1, 5);
      expect(formatDateAEST(date)).toBe('2025-01-05');
    });
  });

  describe('formatTimeAEST', () => {
    test('formats UTC date to AEST correctly', () => {
      // 2025-08-16 00:36:41 UTC should be 2025-08-16 10:36:41 AEST (+10:00)
      const utcDate = fromUnixTimestamp(new Date('2025-08-16T00:36:41.000Z').getTime() / 1000);
      const result = formatTimeAEST(utcDate);
      expect(result).toBe('2025-08-16T10:36:41+10:00');
    });

    test('always uses UTC+10 (no daylight saving)', () => {
      // Brisbane doesn't observe daylight saving time
      // January (summer) should still be +10:00
      const summerDate = fromUnixTimestamp(new Date('2025-01-15T00:00:00.000Z').getTime() / 1000);
      const result = formatTimeAEST(summerDate);
      expect(result).toBe('2025-01-15T10:00:00+10:00');
    });

    test('uses UTC+10 year-round', () => {
      // June (winter) should also be +10:00
      const winterDate = fromUnixTimestamp(new Date('2025-06-15T00:00:00.000Z').getTime() / 1000);
      const result = formatTimeAEST(winterDate);
      expect(result).toBe('2025-06-15T10:00:00+10:00');
    });

    test('removes milliseconds from the output', () => {
      const dateWithMillis = fromUnixTimestamp(new Date('2025-08-16T00:36:41.999Z').getTime() / 1000);
      const result = formatTimeAEST(dateWithMillis);
      expect(result).toBe('2025-08-16T10:36:41+10:00');
      expect(result).not.toContain('.');
      expect(result).not.toContain('999');
    });

    test('handles midnight correctly', () => {
      const midnight = fromUnixTimestamp(new Date('2025-08-16T14:00:00.000Z').getTime() / 1000); // Midnight AEST
      const result = formatTimeAEST(midnight);
      expect(result).toBe('2025-08-17T00:00:00+10:00');
    });

    test('handles noon correctly', () => {
      const noon = fromUnixTimestamp(new Date('2025-08-16T02:00:00.000Z').getTime() / 1000); // Noon AEST
      const result = formatTimeAEST(noon);
      expect(result).toBe('2025-08-16T12:00:00+10:00');
    });

    test('formats result with correct pattern', () => {
      const localDate = fromUnixTimestamp(new Date(2025, 7, 16, 20, 36, 41).getTime() / 1000); // August 16, 2025, 8:36:41 PM local
      const result = formatTimeAEST(localDate);
      // Result should be in AEST with proper format
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\+\-]\d{2}:\d{2}$/);
    });

    test('handles dates consistently without hour jumps', () => {
      // Test multiple dates to ensure no intermittent failures
      // This test catches the bug where milliseconds with fewer than 3 digits
      // caused regex failure and incorrect fallback behavior
      const results = new Set();
      
      for (let i = 0; i < 100; i++) {
        const date = fromUnixTimestamp(new Date('2025-08-16T12:30:45.000Z').getTime() / 1000);
        const result = formatTimeAEST(date);
        const hour = result.substring(11, 13);
        results.add(hour);
      }
      
      // Should only have one hour value (22 for AEST)
      expect(results.size).toBe(1);
      expect(results.has('22')).toBe(true);
      expect(results.has('12')).toBe(false); // Should never show UTC hour
    });

    test('handles all millisecond formats correctly', () => {
      // Test dates that would produce different millisecond formats
      // Some dates might have .1, .11, or .111 milliseconds in the ZonedDateTime string
      const testDates = [
        new Date('2025-08-16T12:30:45.001Z'),
        new Date('2025-08-16T12:30:45.010Z'),
        new Date('2025-08-16T12:30:45.100Z'),
        new Date('2025-08-16T12:30:45.011Z'),
        new Date('2025-08-16T12:30:45.111Z'),
      ];
      
      for (const date of testDates) {
        const result = formatTimeAEST(fromUnixTimestamp(date.getTime() / 1000));
        // All should format to AEST (22:30:45+10:00)
        expect(result).toBe('2025-08-16T22:30:45+10:00');
      }
    });
  });
});