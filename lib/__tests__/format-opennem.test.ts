import { describe, test, expect } from '@jest/globals';
import { roundToThree, formatDataArray, formatOpenNEMResponse } from '@/lib/history/format-opennem';

describe('roundToThree', () => {
  test('rounds positive numbers to 3 decimal places', () => {
    expect(roundToThree(1.2345)).toBe(1.235);
    expect(roundToThree(1.2344)).toBe(1.234);
    expect(roundToThree(1.9999)).toBe(2);
    expect(roundToThree(0.0001)).toBe(0);
    expect(roundToThree(0.0005)).toBe(0.001);
  });

  test('rounds negative numbers to 3 decimal places', () => {
    expect(roundToThree(-1.2345)).toBe(-1.234);  // Rounds toward zero
    expect(roundToThree(-1.2344)).toBe(-1.234);
    expect(roundToThree(-1.9999)).toBe(-2);
    expect(roundToThree(-0.0001)).toBe(0);  // Should return 0, not -0
    expect(roundToThree(-0.0005)).toBe(0);  // Should return 0, not -0
  });

  test('never returns negative zero', () => {
    // Test various values that might round to -0
    expect(Object.is(roundToThree(-0.0001), -0)).toBe(false);
    expect(Object.is(roundToThree(-0.0004), -0)).toBe(false);
    expect(Object.is(roundToThree(-0.00001), -0)).toBe(false);
    expect(roundToThree(-0.0001)).toBe(0);
    expect(roundToThree(-0.0004)).toBe(0);
    expect(roundToThree(-0.00001)).toBe(0);
  });

  test('handles integers', () => {
    expect(roundToThree(5)).toBe(5);
    expect(roundToThree(-5)).toBe(-5);
    expect(roundToThree(0)).toBe(0);
    expect(roundToThree(1000)).toBe(1000);
  });

  test('handles large numbers', () => {
    expect(roundToThree(12345.6789)).toBe(12345.679);
    expect(roundToThree(999999.9999)).toBe(1000000);
    expect(roundToThree(-12345.6789)).toBe(-12345.679);
  });

  test('handles small numbers', () => {
    expect(roundToThree(0.001234)).toBe(0.001);
    expect(roundToThree(0.000999)).toBe(0.001);
    expect(roundToThree(0.0004999)).toBe(0);
  });

  test('returns null for null input', () => {
    expect(roundToThree(null)).toBe(null);
  });

  test('returns null for undefined input', () => {
    expect(roundToThree(undefined)).toBe(null);
  });

  test('handles edge cases', () => {
    expect(roundToThree(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(roundToThree(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
    expect(roundToThree(Number.EPSILON)).toBe(0);
  });

  test('handles special values', () => {
    expect(roundToThree(Infinity)).toBe(Infinity);
    expect(roundToThree(-Infinity)).toBe(-Infinity);
    expect(roundToThree(NaN)).toBe(NaN);
  });
});

describe('formatDataArray', () => {
  test('formats array of numbers according to OpenNEM standards', () => {
    const input = [1234.5678, 12.3456, 1.2345, 0.1234, null, 0];
    const result = formatDataArray(input);
    
    // Check that results follow OpenNEM formatting rules
    expect(result[0]).toBe(1235);  // Large numbers rounded to integers
    expect(result[1]).toBe(12.35); // Two decimals for 10-99 range
    expect(result[2]).toBe(1.235); // Three decimals for 1-9 range
    expect(result[3]).toBe(0.1234); // Four decimals for 0.1-0.999 range
    expect(result[4]).toBe(null);
    expect(result[5]).toBe(0);
  });

  test('handles empty array', () => {
    expect(formatDataArray([])).toEqual([]);
  });

  test('preserves null values', () => {
    const input = [null, 1, null, 2, null];
    const result = formatDataArray(input);
    expect(result[0]).toBe(null);
    expect(result[2]).toBe(null);
    expect(result[4]).toBe(null);
  });
});

describe('formatOpenNEMResponse', () => {
  test('compacts data arrays to single line', () => {
    const response = {
      type: 'energy',
      data: [
        {
          id: 'test',
          history: {
            data: [1, 2, 3, 4, 5]
          }
        }
      ]
    };
    
    const formatted = formatOpenNEMResponse(response);
    
    // Check that the inner data array (within history) is on a single line
    expect(formatted).toContain('"data": [1,2,3,4,5]');
    // The outer data array might still have line breaks, which is fine
  });

  test('preserves proper JSON structure', () => {
    const response = {
      type: 'test',
      value: 123,
      nested: {
        array: [1, 2, 3]
      }
    };
    
    const formatted = formatOpenNEMResponse(response);
    const parsed = JSON.parse(formatted);
    
    expect(parsed).toEqual(response);
  });

  test('handles null values in data arrays', () => {
    const response = {
      data: [
        {
          history: {
            data: [1, null, 3, null, 5]
          }
        }
      ]
    };
    
    const formatted = formatOpenNEMResponse(response);
    expect(formatted).toContain('"data": [1,null,3,null,5]');
  });
});