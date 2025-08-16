import { formatToAEST } from '@/app/api/history/route';

describe('formatToAEST', () => {
  it('should format UTC date to AEST correctly', () => {
    // Test with a known UTC date
    // 2025-08-16 00:36:41 UTC should be 2025-08-16 10:36:41 AEST (+10:00)
    const utcDate = new Date('2025-08-16T00:36:41.000Z');
    const result = formatToAEST(utcDate);
    expect(result).toBe('2025-08-16T10:36:41+10:00');
  });

  it('should format local time to AEST correctly', () => {
    // Test with a date created in local time
    // This should be converted to AEST regardless of local timezone
    const localDate = new Date(2025, 7, 16, 20, 36, 41); // August 16, 2025, 8:36:41 PM local
    const result = formatToAEST(localDate);
    // Result should be in AEST
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\+\-]\d{2}:\d{2}$/);
  });

  it('should handle daylight saving time correctly', () => {
    // Test with a date during AEDT (Australian Eastern Daylight Time)
    // January is summer in Australia, so it should be +11:00
    const summerDate = new Date('2025-01-15T00:00:00.000Z');
    const result = formatToAEST(summerDate);
    expect(result).toBe('2025-01-15T11:00:00+11:00');
  });

  it('should handle non-daylight saving time correctly', () => {
    // Test with a date during AEST (no daylight saving)
    // June is winter in Australia, so it should be +10:00
    const winterDate = new Date('2025-06-15T00:00:00.000Z');
    const result = formatToAEST(winterDate);
    expect(result).toBe('2025-06-15T10:00:00+10:00');
  });

  it('should remove milliseconds from the output', () => {
    const dateWithMillis = new Date('2025-08-16T00:36:41.999Z');
    const result = formatToAEST(dateWithMillis);
    expect(result).toBe('2025-08-16T10:36:41+10:00');
    expect(result).not.toContain('.');
    expect(result).not.toContain('999');
  });

  it('should handle midnight correctly', () => {
    const midnight = new Date('2025-08-16T14:00:00.000Z'); // Midnight AEST
    const result = formatToAEST(midnight);
    expect(result).toBe('2025-08-17T00:00:00+10:00');
  });

  it('should handle noon correctly', () => {
    const noon = new Date('2025-08-16T02:00:00.000Z'); // Noon AEST
    const result = formatToAEST(noon);
    expect(result).toBe('2025-08-16T12:00:00+10:00');
  });
});