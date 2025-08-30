import { describe, test, expect } from '@jest/globals';
import { formatValue, formatValuePair } from '../energy-formatting';

describe('formatValue', () => {
  test('returns em-dash for null/undefined', () => {
    expect(formatValue(null, 'W')).toEqual({ value: '—', unit: '' });
    expect(formatValue(undefined, 'kWh')).toEqual({ value: '—', unit: '' });
  });

  test('formats base unit W correctly', () => {
    expect(formatValue(500, 'W')).toEqual({ value: '0.5', unit: 'kW' });
    expect(formatValue(1500, 'W')).toEqual({ value: '1.5', unit: 'kW' });
    expect(formatValue(1500000, 'W')).toEqual({ value: '1.5', unit: 'MW' });
    expect(formatValue(1500000000, 'W')).toEqual({ value: '1.5', unit: 'GW' });
  });

  test('formats base unit Wh correctly', () => {
    expect(formatValue(500, 'Wh')).toEqual({ value: '0.5', unit: 'kWh' });
    expect(formatValue(1500, 'Wh')).toEqual({ value: '1.5', unit: 'kWh' });
    expect(formatValue(1500000, 'Wh')).toEqual({ value: '1.5', unit: 'MWh' });
    expect(formatValue(1500000000, 'Wh')).toEqual({ value: '1.5', unit: 'GWh' });
  });

  test('formats kW input correctly', () => {
    expect(formatValue(0.5, 'kW')).toEqual({ value: '0.5', unit: 'kW' });
    expect(formatValue(500, 'kW')).toEqual({ value: '500.0', unit: 'kW' });
    expect(formatValue(1500, 'kW')).toEqual({ value: '1.5', unit: 'MW' });
    expect(formatValue(1500000, 'kW')).toEqual({ value: '1.5', unit: 'GW' });
  });

  test('formats kWh input correctly', () => {
    expect(formatValue(0.5, 'kWh')).toEqual({ value: '0.5', unit: 'kWh' });
    expect(formatValue(500, 'kWh')).toEqual({ value: '500.0', unit: 'kWh' });
    expect(formatValue(1500, 'kWh')).toEqual({ value: '1.5', unit: 'MWh' });
    expect(formatValue(1500000, 'kWh')).toEqual({ value: '1.5', unit: 'GWh' });
  });

  test('formats MW input correctly', () => {
    expect(formatValue(0.5, 'MW')).toEqual({ value: '500.0', unit: 'kW' });
    expect(formatValue(1, 'MW')).toEqual({ value: '1.0', unit: 'MW' });
    expect(formatValue(1500, 'MW')).toEqual({ value: '1.5', unit: 'GW' });
  });

  test('formats MWh input correctly', () => {
    expect(formatValue(0.5, 'MWh')).toEqual({ value: '500.0', unit: 'kWh' });
    expect(formatValue(1, 'MWh')).toEqual({ value: '1.0', unit: 'MWh' });
    expect(formatValue(1500, 'MWh')).toEqual({ value: '1.5', unit: 'GWh' });
  });

  test('formats GW input correctly', () => {
    expect(formatValue(0.001, 'GW')).toEqual({ value: '1.0', unit: 'MW' });
    expect(formatValue(1, 'GW')).toEqual({ value: '1.0', unit: 'GW' });
  });

  test('formats GWh input correctly', () => {
    expect(formatValue(0.001, 'GWh')).toEqual({ value: '1.0', unit: 'MWh' });
    expect(formatValue(1, 'GWh')).toEqual({ value: '1.0', unit: 'GWh' });
  });

  test('handles zero correctly', () => {
    expect(formatValue(0, 'W')).toEqual({ value: '0.0', unit: 'kW' });
    expect(formatValue(0, 'kWh')).toEqual({ value: '0.0', unit: 'kWh' });
  });

  test('handles negative values correctly', () => {
    expect(formatValue(-1500, 'W')).toEqual({ value: '-1.5', unit: 'kW' });
    expect(formatValue(-1500, 'kW')).toEqual({ value: '-1.5', unit: 'MW' });
    expect(formatValue(-1500000, 'W')).toEqual({ value: '-1.5', unit: 'MW' });
  });
});

describe('formatValuePair', () => {
  test('handles both values null/undefined', () => {
    expect(formatValuePair(null, null, 'W')).toEqual({ value: '—/—', unit: '' });
    expect(formatValuePair(undefined, undefined, 'kWh')).toEqual({ value: '—/—', unit: '' });
    expect(formatValuePair(null, undefined, 'W')).toEqual({ value: '—/—', unit: '' });
  });

  test('handles in value null, out value valid', () => {
    expect(formatValuePair(null, 1500000, 'W')).toEqual({ value: '—/1.5', unit: 'MW' });
    expect(formatValuePair(undefined, 750, 'kWh')).toEqual({ value: '—/750.0', unit: 'kWh' });
  });

  test('handles in value valid, out value null', () => {
    expect(formatValuePair(1200000, null, 'W')).toEqual({ value: '1.2/—', unit: 'MW' });
    expect(formatValuePair(800, undefined, 'kWh')).toEqual({ value: '800.0/—', unit: 'kWh' });
  });

  test('handles both values valid with same SI prefix', () => {
    expect(formatValuePair(1200000, 1800000, 'W')).toEqual({ value: '1.2/1.8', unit: 'MW' });
    expect(formatValuePair(500, 750, 'kWh')).toEqual({ value: '500.0/750.0', unit: 'kWh' });
  });

  test('handles both values valid requiring different SI prefixes (uses max)', () => {
    expect(formatValuePair(500000, 1500000000, 'W')).toEqual({ value: '0.0/1.5', unit: 'GW' });
    expect(formatValuePair(2000000, 800, 'kWh')).toEqual({ value: '2.0/0.0', unit: 'GWh' });
  });

  test('handles negative values correctly', () => {
    expect(formatValuePair(-1200000, 1800000, 'W')).toEqual({ value: '-1.2/1.8', unit: 'MW' });
    expect(formatValuePair(-2500, -1200, 'kWh')).toEqual({ value: '-2.5/-1.2', unit: 'MWh' });
  });

  test('handles zero values correctly', () => {
    expect(formatValuePair(0, 1500000, 'W')).toEqual({ value: '0.0/1.5', unit: 'MW' });
    expect(formatValuePair(0, 0, 'kWh')).toEqual({ value: '0.0/0.0', unit: 'kWh' });
  });

  test('works with W metric', () => {
    expect(formatValuePair(1500000, 2500000, 'W')).toEqual({ value: '1.5/2.5', unit: 'MW' });
  });

  test('works with Wh metric', () => {
    expect(formatValuePair(1500, 2500, 'kWh')).toEqual({ value: '1.5/2.5', unit: 'MWh' });
  });

  test('handles values with different magnitudes correctly (original bug case)', () => {
    // 1625 W and 107 W should both use kW units
    expect(formatValuePair(1625, 107, 'W')).toEqual({ value: '1.6/0.1', unit: 'kW' });
  });

  test('handles values with very different magnitudes correctly', () => {
    // 2000 W and 50 W should both use kW units
    expect(formatValuePair(2000, 50, 'W')).toEqual({ value: '2.0/0.1', unit: 'kW' });
  });

  test('handles MW scale with smaller value correctly', () => {
    // 1500000 W and 50000 W should both use MW units
    expect(formatValuePair(1500000, 50000, 'W')).toEqual({ value: '1.5/0.1', unit: 'MW' });
  });

  test('handles kW input with mixed values', () => {
    expect(formatValuePair(1200, 1800, 'kW')).toEqual({ value: '1.2/1.8', unit: 'MW' });
    expect(formatValuePair(500, 750, 'kW')).toEqual({ value: '500.0/750.0', unit: 'kW' });
    expect(formatValuePair(1.625, 0.107, 'kW')).toEqual({ value: '1.6/0.1', unit: 'kW' });
  });
});