import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getNextMinuteBoundary } from '../date-utils';

describe('getNextMinuteBoundary', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore real timers after each test
    jest.useRealTimers();
  });

  describe('1-minute intervals', () => {
    it('should return next minute when at :30 seconds', () => {
      // Mock Date to return 14:23:30 in UTC+10
      const mockDate = new Date('2025-01-15T14:23:30+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(1, 600); // UTC+10

      expect(result.minute).toBe(24);
      expect(result.second).toBe(0);
      expect(result.millisecond).toBe(0);
    });

    it('should return next minute when at :00 seconds', () => {
      const mockDate = new Date('2025-01-15T14:23:00+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(1, 600);

      expect(result.minute).toBe(24);
      expect(result.second).toBe(0);
    });

    it('should roll over to next hour at :59', () => {
      const mockDate = new Date('2025-01-15T14:59:45+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(1, 600);

      expect(result.hour).toBe(15);
      expect(result.minute).toBe(0);
      expect(result.second).toBe(0);
    });
  });

  describe('5-minute intervals', () => {
    it('should return :05 when at :03', () => {
      const mockDate = new Date('2025-01-15T14:03:30+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, 600);

      expect(result.minute).toBe(5);
      expect(result.second).toBe(0);
    });

    it('should return :10 when at :05:01', () => {
      const mockDate = new Date('2025-01-15T14:05:01+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, 600);

      expect(result.minute).toBe(10);
    });

    it('should return :00 next hour when at :58', () => {
      const mockDate = new Date('2025-01-15T14:58:30+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, 600);

      expect(result.hour).toBe(15);
      expect(result.minute).toBe(0);
    });

    it('should return :00 next hour when at :59', () => {
      const mockDate = new Date('2025-01-15T14:59:59+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, 600);

      expect(result.hour).toBe(15);
      expect(result.minute).toBe(0);
    });
  });

  describe('15-minute intervals', () => {
    it('should return :15 when at :10', () => {
      const mockDate = new Date('2025-01-15T14:10:30+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(15, 600);

      expect(result.minute).toBe(15);
    });

    it('should return :30 when at :16', () => {
      const mockDate = new Date('2025-01-15T14:16:00+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(15, 600);

      expect(result.minute).toBe(30);
    });

    it('should return :45 when at :44:59', () => {
      const mockDate = new Date('2025-01-15T14:44:59+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(15, 600);

      expect(result.minute).toBe(45);
    });

    it('should roll over to next hour when at :46', () => {
      const mockDate = new Date('2025-01-15T14:46:00+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(15, 600);

      expect(result.hour).toBe(15);
      expect(result.minute).toBe(0);
    });
  });

  describe('30-minute intervals', () => {
    it('should return :30 when at :15', () => {
      const mockDate = new Date('2025-01-15T14:15:30+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(30, 600);

      expect(result.minute).toBe(30);
    });

    it('should return :00 next hour when at :31', () => {
      const mockDate = new Date('2025-01-15T14:31:00+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(30, 600);

      expect(result.hour).toBe(15);
      expect(result.minute).toBe(0);
    });
  });

  describe('60-minute intervals (hourly)', () => {
    it('should return next hour when at :00:01', () => {
      const mockDate = new Date('2025-01-15T14:00:01+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(60, 600);

      expect(result.hour).toBe(15);
      expect(result.minute).toBe(0);
      expect(result.second).toBe(0);
    });

    it('should return next hour when at :30:00', () => {
      const mockDate = new Date('2025-01-15T14:30:00+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(60, 600);

      expect(result.hour).toBe(15);
      expect(result.minute).toBe(0);
    });

    it('should handle day rollover at 23:30', () => {
      const mockDate = new Date('2025-01-15T23:30:00+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(60, 600);

      expect(result.hour).toBe(0);
      expect(result.minute).toBe(0);
      expect(result.day).toBe(16);
    });
  });

  describe('timezone offset handling', () => {
    it('should handle UTC (offset 0)', () => {
      const mockDate = new Date('2025-01-15T14:23:30+00:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, 0); // UTC

      expect(result.minute).toBe(25);
      expect(result.timeZone).toBe('Etc/UTC');
    });

    it('should handle UTC+10 (offset 600)', () => {
      const mockDate = new Date('2025-01-15T14:23:30+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, 600); // UTC+10

      expect(result.minute).toBe(25);
      expect(result.timeZone).toBe('Etc/GMT-10'); // IANA inverted sign
    });

    it('should handle UTC-5 (offset -300)', () => {
      const mockDate = new Date('2025-01-15T14:23:30-05:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, -300); // UTC-5

      expect(result.minute).toBe(25);
      expect(result.timeZone).toBe('Etc/GMT+5'); // IANA inverted sign
    });

    // Note: Fractional timezones like UTC+5:30 are not supported by Etc/GMT format
  });

  describe('edge cases', () => {
    it('should handle exactly on boundary for 5-minute interval', () => {
      const mockDate = new Date('2025-01-15T14:25:00.000+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, 600);

      // Should go to next boundary
      expect(result.minute).toBe(30);
    });

    it('should handle exactly on boundary for 1-minute interval', () => {
      const mockDate = new Date('2025-01-15T14:25:00.000+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(1, 600);

      // Should go to next minute
      expect(result.minute).toBe(26);
    });

    it('should handle midnight crossing', () => {
      const mockDate = new Date('2025-01-15T23:59:30+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(1, 600);

      expect(result.hour).toBe(0);
      expect(result.minute).toBe(0);
      expect(result.day).toBe(16); // Next day
    });

    it('should always clear seconds and milliseconds', () => {
      const mockDate = new Date('2025-01-15T14:23:45.678+10:00');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);

      const result = getNextMinuteBoundary(5, 600);

      expect(result.second).toBe(0);
      expect(result.millisecond).toBe(0);
    });
  });
});