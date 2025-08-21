/**
 * Integration tests for the History API
 * 
 * These tests run against a real database and test the full API stack.
 * They use data that is at least 48 hours old to ensure consistency
 * across different environments.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';

const API_BASE_URL = process.env.TEST_API_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.AUTH_PASSWORD || 'password';
const SYSTEM_ID = '1';

// Helper function to make authenticated API requests
async function fetchHistory(params: Record<string, string>): Promise<any> {
  const queryString = new URLSearchParams(params).toString();
  const response = await fetch(`${API_BASE_URL}/api/history?${queryString}`, {
    headers: {
      'Cookie': `auth-token=${AUTH_TOKEN}`
    }
  });
  
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

// Helper to get a date string N days ago
function getDaysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

describe('History API Integration Tests', () => {
  // Check data freshness before running tests
  beforeAll(async () => {
    console.log(`Running tests against: ${API_BASE_URL}`);
    
    // Get latest data to check freshness
    const response = await fetchHistory({
      interval: '5m',
      last: '1h',
      fields: 'solar',
      systemId: SYSTEM_ID
    });
    
    if (!response.data || response.data.length === 0) {
      throw new Error('No data available in the system');
    }
    
    // Check if we have recent enough data
    const solarData = response.data.find((d: any) => d.id.includes('solar.power'));
    if (!solarData || !solarData.history.data || solarData.history.data.length === 0) {
      throw new Error('No solar data available');
    }
    
    // Parse the start time and check age
    const startTime = new Date(solarData.history.start);
    const dataAge = Date.now() - startTime.getTime();
    const hoursOld = dataAge / (1000 * 60 * 60);
    
    if (hoursOld > 48) {
      throw new Error(`Data is too old (${hoursOld.toFixed(1)} hours). Please sync the database.`);
    }
    
    console.log(`Data freshness check passed. Latest data is ${hoursOld.toFixed(1)} hours old.`);
  });

  describe('Time Range Tests', () => {
    test('should return 5-minute interval data for 3 days ago', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '24h',
        from: getDaysAgo(4).toISOString(),
        fields: 'solar,load',
        systemId: SYSTEM_ID
      });
      
      expect(response).toHaveProperty('data');
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data.length).toBeGreaterThan(0);
      
      // Check that we have both solar and load data
      const solarData = response.data.find((d: any) => d.id.includes('solar.power'));
      const loadData = response.data.find((d: any) => d.id.includes('load.power'));
      
      expect(solarData).toBeDefined();
      expect(loadData).toBeDefined();
      
      // Verify interval
      expect(solarData.history.interval).toBe('5m');
      
      // Verify we have data points (288 = 24 hours / 5 minutes)
      expect(solarData.history.data.length).toBeLessThanOrEqual(288);
      expect(solarData.history.data.length).toBeGreaterThan(0);
    });
    
    test('should return 30-minute interval data for 7 days', async () => {
      const response = await fetchHistory({
        interval: '30m',
        last: '7d',
        fields: 'solar,load,battery',
        systemId: SYSTEM_ID
      });
      
      expect(response).toHaveProperty('data');
      expect(response.data.length).toBe(4); // solar, load, battery power, battery SOC
      
      const solarData = response.data.find((d: any) => d.id.includes('solar.power'));
      expect(solarData.history.interval).toBe('30m');
      
      // 7 days * 24 hours * 2 (30-minute intervals) = 336 max data points
      expect(solarData.history.data.length).toBeLessThanOrEqual(336);
      expect(solarData.history.data.length).toBeGreaterThan(0);
    });
    
    test('should return daily interval data for 30 days', async () => {
      const response = await fetchHistory({
        interval: '1d',
        last: '30d',
        fields: 'solar,load',
        systemId: SYSTEM_ID
      });
      
      expect(response).toHaveProperty('data');
      
      const solarData = response.data.find((d: any) => d.id.includes('solar.power'));
      expect(solarData.history.interval).toBe('1d');
      
      // Should have up to 30 data points
      expect(solarData.history.data.length).toBeLessThanOrEqual(30);
      expect(solarData.history.data.length).toBeGreaterThan(0);
    });
  });

  describe('Field Selection Tests', () => {
    test('should return only solar data when requested', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '1h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      expect(response.data.length).toBe(1);
      expect(response.data[0].id).toContain('solar.power');
    });
    
    test('should return solar and load data when requested', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '1h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar,load',
        systemId: SYSTEM_ID
      });
      
      expect(response.data.length).toBe(2);
      const ids = response.data.map((d: any) => d.id);
      expect(ids.some((id: string) => id.includes('solar.power'))).toBe(true);
      expect(ids.some((id: string) => id.includes('load.power'))).toBe(true);
    });
    
    test('should return battery power and SOC when battery field requested', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '1h',
        from: getDaysAgo(3).toISOString(),
        fields: 'battery',
        systemId: SYSTEM_ID
      });
      
      expect(response.data.length).toBe(2);
      const ids = response.data.map((d: any) => d.id);
      expect(ids.some((id: string) => id.includes('battery.power'))).toBe(true);
      expect(ids.some((id: string) => id.includes('battery.soc'))).toBe(true);
    });
    
    test('should return all fields when requested', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '1h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar,load,battery,grid',
        systemId: SYSTEM_ID
      });
      
      expect(response.data.length).toBe(5); // solar, load, battery power, battery SOC, grid
      const ids = response.data.map((d: any) => d.id);
      expect(ids.some((id: string) => id.includes('solar.power'))).toBe(true);
      expect(ids.some((id: string) => id.includes('load.power'))).toBe(true);
      expect(ids.some((id: string) => id.includes('battery.power'))).toBe(true);
      expect(ids.some((id: string) => id.includes('battery.soc'))).toBe(true);
      expect(ids.some((id: string) => id.includes('grid.power'))).toBe(true);
    });
  });

  describe('Data Format Tests', () => {
    test('should return OpenNEM-compatible format', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '1h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      const solarData = response.data[0];
      
      // Check OpenNEM structure
      expect(solarData).toHaveProperty('id');
      expect(solarData).toHaveProperty('type');
      expect(solarData).toHaveProperty('units');
      expect(solarData).toHaveProperty('history');
      
      // Check history structure
      expect(solarData.history).toHaveProperty('start');
      expect(solarData.history).toHaveProperty('interval');
      expect(solarData.history).toHaveProperty('data');
      
      // Verify units
      expect(solarData.units).toBe('W');
      expect(solarData.type).toBe('power');
      
      // Verify data is an array of numbers (or nulls)
      expect(Array.isArray(solarData.history.data)).toBe(true);
      solarData.history.data.forEach((value: any) => {
        expect(value === null || typeof value === 'number').toBe(true);
      });
    });
    
    test('should format timestamps in ISO 8601 with timezone', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '1h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      const solarData = response.data[0];
      const startTime = solarData.history.start;
      
      // Check ISO 8601 format with timezone offset
      expect(startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
      
      // Verify it parses correctly
      const date = new Date(startTime);
      expect(date.toString()).not.toBe('Invalid Date');
    });
    
    test('should use appropriate data precision based on value magnitude', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '1h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar,battery',
        systemId: SYSTEM_ID
      });
      
      const solarData = response.data.find((d: any) => d.id.includes('solar.power'));
      const socData = response.data.find((d: any) => d.id.includes('battery.soc'));
      
      // Check power values are integers or have appropriate precision
      solarData.history.data.forEach((value: any) => {
        if (value !== null) {
          // Power values should be integers or have minimal decimal places
          const decimalPlaces = (value.toString().split('.')[1] || '').length;
          expect(decimalPlaces).toBeLessThanOrEqual(3);
        }
      });
      
      // Check SOC values have appropriate precision (1 decimal place)
      socData.history.data.forEach((value: any) => {
        if (value !== null) {
          const decimalPlaces = (value.toString().split('.')[1] || '').length;
          expect(decimalPlaces).toBeLessThanOrEqual(1);
        }
      });
    });
  });

  describe('Error Handling Tests', () => {
    test('should return error for invalid interval', async () => {
      await expect(fetchHistory({
        interval: 'invalid',
        last: '1h',
        fields: 'solar',
        systemId: SYSTEM_ID
      })).rejects.toThrow();
    });
    
    test('should return error for missing systemId', async () => {
      await expect(fetchHistory({
        interval: '5m',
        last: '1h',
        fields: 'solar'
      })).rejects.toThrow();
    });
    
    test('should return error for invalid time range', async () => {
      await expect(fetchHistory({
        interval: '5m',
        last: 'invalid',
        fields: 'solar',
        systemId: SYSTEM_ID
      })).rejects.toThrow();
    });
    
    test('should handle request for future dates gracefully', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7); // 7 days in the future
      
      const response = await fetchHistory({
        interval: '5m',
        startTime: futureDate.toISOString(),
        endTime: new Date(futureDate.getTime() + 3600000).toISOString(), // 1 hour window
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      // Should return a valid response structure
      expect(response).toBeDefined();
      expect(response).toHaveProperty('data');
      
      // For future dates, the API returns an empty data array
      expect(response.data).toEqual([]);
    });
  });

  describe('Performance Tests', () => {
    test('should return 24 hours of 5-minute data within 2 seconds', async () => {
      const startTime = Date.now();
      
      await fetchHistory({
        interval: '5m',
        last: '24h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar,load,battery',
        systemId: SYSTEM_ID
      });
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(2000);
    });
    
    test('should return 30 days of daily data within 1 second', async () => {
      const startTime = Date.now();
      
      await fetchHistory({
        interval: '1d',
        last: '30d',
        fields: 'solar,load,battery',
        systemId: SYSTEM_ID
      });
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Data Consistency Tests', () => {
    test('should return consistent data for overlapping time ranges', async () => {
      // Get data for 3 days ago
      const date3DaysAgo = getDaysAgo(3);
      const date2DaysAgo = getDaysAgo(2);
      
      // Request 1: Specific time range (24 hours)
      const response1 = await fetchHistory({
        interval: '5m',
        startTime: date3DaysAgo.toISOString(),
        endTime: date2DaysAgo.toISOString(),
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      // Request 2: Same start, shorter duration (12 hours)
      const response2 = await fetchHistory({
        interval: '5m',
        startTime: date3DaysAgo.toISOString(),
        endTime: new Date(date3DaysAgo.getTime() + 12 * 3600000).toISOString(), // 12 hours
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      // Both should have the same start time
      expect(response1.data[0].history.start).toBe(response2.data[0].history.start);
      
      // Response 1 should have more data points (24 hours vs 12 hours)
      expect(response1.data[0].history.data.length).toBeGreaterThan(response2.data[0].history.data.length);
      
      // The first half of response1 should match response2 data
      const halfLength = response2.data[0].history.data.length;
      const firstHalf1 = response1.data[0].history.data.slice(0, halfLength);
      const data2 = response2.data[0].history.data;
      
      // Compare the overlapping data
      for (let i = 0; i < Math.min(10, halfLength); i++) {
        if (firstHalf1[i] !== null && data2[i] !== null) {
          expect(firstHalf1[i]).toBe(data2[i]);
        }
      }
    });
    
    test('should return null values for missing data points', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '24h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      const solarData = response.data[0];
      
      // Check that data array can contain nulls for missing points
      const hasNulls = solarData.history.data.some((v: any) => v === null);
      const hasNumbers = solarData.history.data.some((v: any) => typeof v === 'number');
      
      // We should have at least some real data
      expect(hasNumbers).toBe(true);
      
      // Nulls are acceptable for missing data
      if (hasNulls) {
        expect(solarData.history.data.every((v: any) => v === null || typeof v === 'number')).toBe(true);
      }
    });
    
    test('should align data points across different fields', async () => {
      const response = await fetchHistory({
        interval: '5m',
        last: '1h',
        from: getDaysAgo(3).toISOString(),
        fields: 'solar,load',
        systemId: SYSTEM_ID
      });
      
      const solarData = response.data.find((d: any) => d.id.includes('solar.power'));
      const loadData = response.data.find((d: any) => d.id.includes('load.power'));
      
      // All fields should have the same start time
      expect(solarData.history.start).toBe(loadData.history.start);
      
      // All fields should have the same number of data points
      expect(solarData.history.data.length).toBe(loadData.history.data.length);
      
      // All fields should have the same interval
      expect(solarData.history.interval).toBe(loadData.history.interval);
    });
  });

  describe('Aggregation Tests', () => {
    test('daily aggregation should provide sensible averages', async () => {
      const response = await fetchHistory({
        interval: '1d',
        last: '7d',
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      const solarData = response.data[0];
      
      // Daily solar averages should be reasonable (0-10000W for residential)
      solarData.history.data.forEach((value: any) => {
        if (value !== null) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(10000);
        }
      });
    });
    
    test('30-minute aggregation should smooth out 5-minute variations', async () => {
      // Get both 5-minute and 30-minute data for the same period
      const from = getDaysAgo(3).toISOString();
      
      const response5m = await fetchHistory({
        interval: '5m',
        from,
        last: '2h',
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      const response30m = await fetchHistory({
        interval: '30m',
        from,
        last: '2h',
        fields: 'solar',
        systemId: SYSTEM_ID
      });
      
      const data5m = response5m.data[0].history.data;
      const data30m = response30m.data[0].history.data;
      
      // 30-minute data should have 1/6 the number of points
      expect(data30m.length).toBeLessThanOrEqual(Math.ceil(data5m.length / 6));
      
      // 30-minute values should be within the range of corresponding 5-minute values
      // (This is a basic sanity check)
      const firstSixValues5m = data5m.slice(0, 6).filter((v: any) => v !== null);
      if (firstSixValues5m.length > 0 && data30m[0] !== null) {
        const min5m = Math.min(...firstSixValues5m);
        const max5m = Math.max(...firstSixValues5m);
        
        // 30-minute average should be between min and max of 5-minute values
        expect(data30m[0]).toBeGreaterThanOrEqual(min5m);
        expect(data30m[0]).toBeLessThanOrEqual(max5m);
      }
    });
  });
});