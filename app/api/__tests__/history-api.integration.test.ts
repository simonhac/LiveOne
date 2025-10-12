import { describe, it, expect, beforeAll } from '@jest/globals';

// Load environment variables from .env.local for testing
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { getTestSession } from '@/lib/__tests__/test-auth-helper';

const API_URL = 'http://localhost:3000/api/history';

describe('History API Integration Tests - Multiple Interval Support', () => {
  let sessionToken: string | null = null;
  
  // Helper to align times to 5-minute boundaries
  const alignTo5Minutes = (date: Date): Date => {
    return new Date(Math.floor(date.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000));
  };

  // Helper to align times to 30-minute boundaries
  const alignTo30Minutes = (date: Date): Date => {
    return new Date(Math.floor(date.getTime() / (30 * 60 * 1000)) * (30 * 60 * 1000));
  };
  
  beforeAll(async () => {
    // Check if dev server is running
    try {
      const response = await fetch('http://localhost:3000/api/health');
      if (!response.ok) {
        throw new Error('Dev server not responding properly. Please run: npm run dev');
      }
    } catch (error) {
      throw new Error('Dev server is not running. Please start it with: npm run dev');
    }
    
    // Get test session token from Clerk
    sessionToken = await getTestSession();
    if (!sessionToken) {
      throw new Error('Failed to get test session token from Clerk. Ensure TEST_USER_ID is set in .env.local');
    }
  });

  const makeRequest = async (params: Record<string, string> = {}) => {
    const url = new URL(API_URL);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    
    // Add default test system ID if not provided
    // Use the database ID (1), not the vendor site ID (1586)
    if (!params.systemId) {
      url.searchParams.set('systemId', '1');
    }
    
    const headers: HeadersInit = {};
    if (sessionToken) {
      // Try Authorization header with Bearer token
      headers['Authorization'] = `Bearer ${sessionToken}`;
    }
    
    return fetch(url.toString(), { headers });
  };

  describe('Parameter Validation', () => {
    it('should accept startTime and endTime parameters in ISO 8601 format', async () => {
      const endTime = alignTo5Minutes(new Date());
      const startTime = alignTo5Minutes(new Date(endTime.getTime() - 2 * 60 * 60 * 1000)); // 2 hours ago

      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      if (response.status !== 200) {
        const errorData = await response.json();
        console.error('Response status:', response.status);
        console.error('Error:', errorData);
      }

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.type).toBe('energy');
      expect(data.data).toBeDefined();
    });

    it('should reject invalid date formats', async () => {
      const response = await makeRequest({
        interval: '5m',
        startTime: 'invalid-date',
        endTime: new Date().toISOString(),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('Invalid ISO 8601');
    });

    it('should reject when startTime is after endTime', async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60 * 60 * 1000);

      const response = await makeRequest({
        interval: '5m',
        startTime: now.toISOString(),
        endTime: earlier.toISOString(),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('startTime must be before endTime');
    });
  });

  describe('Interval-Specific Time Limits', () => {
    it('should accept 5m interval with time range up to 7.5 days', async () => {
      const endTime = alignTo5Minutes(new Date());
      const startTime = alignTo5Minutes(new Date(endTime.getTime() - 7.4 * 24 * 60 * 60 * 1000)); // 7.4 days

      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data[0]?.history?.interval).toBe('5m');
    });

    it('should reject 5m interval with time range exceeding 7.5 days', async () => {
      const endTime = alignTo5Minutes(new Date());
      const startTime = alignTo5Minutes(new Date(endTime.getTime() - 8 * 24 * 60 * 60 * 1000)); // 8 days

      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('Time range exceeds maximum of 7.5 days');
    });

    it('should accept 30m interval with time range up to 30 days', async () => {
      const endTime = alignTo30Minutes(new Date());
      const startTime = alignTo30Minutes(new Date(endTime.getTime() - 29 * 24 * 60 * 60 * 1000)); // 29 days

      const response = await makeRequest({
        interval: '30m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data[0]?.history?.interval).toBe('30m');
    });

    it('should reject 30m interval with time range exceeding 30 days', async () => {
      const endTime = alignTo30Minutes(new Date());
      const startTime = alignTo30Minutes(new Date(endTime.getTime() - 31 * 24 * 60 * 60 * 1000)); // 31 days

      const response = await makeRequest({
        interval: '30m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('Time range exceeds maximum of 30 days');
    });

    it('should accept 1d interval with time range up to 13 months (390 days)', async () => {
      // 390 days = 13 * 30 days
      const response = await makeRequest({
        interval: '1d',
        startTime: '2024-10-01',
        endTime: '2025-10-24',
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data[0]?.history?.interval).toBe('1d');
    });

    it('should reject unsupported 1m interval', async () => {
      const endTime = alignTo5Minutes(new Date());
      const startTime = alignTo5Minutes(new Date(endTime.getTime() - 1 * 60 * 60 * 1000)); // 1 hour

      const response = await makeRequest({
        interval: '1m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(501);

      const data = await response.json();
      expect(data.error).toContain('Only 5m, 30m, and 1d intervals are supported');
    });
  });

  describe('5-Minute Data Aggregation', () => {
    it('should aggregate data to 5-minute boundaries', async () => {
      const endTime = alignTo5Minutes(new Date());
      const startTime = alignTo5Minutes(new Date(endTime.getTime() - 60 * 60 * 1000)); // 1 hour

      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.data[0]?.history?.interval).toBe('5m');

      // Should have approximately 13 data points for 1 hour at 5-minute intervals (0, 5, 10, ..., 60)
      const dataPoints = data.data[0]?.history?.data?.length || 0;
      expect(dataPoints).toBeGreaterThanOrEqual(12);
      expect(dataPoints).toBeLessThanOrEqual(14); // Allow one extra for boundary conditions
    });

    it('should handle null values for missing data points', async () => {
      const endTime = alignTo5Minutes(new Date());
      const startTime = alignTo5Minutes(new Date(endTime.getTime() - 3 * 60 * 60 * 1000)); // 3 hours

      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();

      // Check that data arrays exist and may contain nulls
      const solarData = data.data.find((d: any) => d.id.includes('solar'))?.history?.data || [];
      const loadData = data.data.find((d: any) => d.id.includes('load'))?.history?.data || [];

      expect(Array.isArray(solarData)).toBe(true);
      expect(Array.isArray(loadData)).toBe(true);

      // Data should contain either numbers or nulls
      solarData.forEach((value: any) => {
        expect(value === null || typeof value === 'number').toBe(true);
      });

      loadData.forEach((value: any) => {
        expect(value === null || typeof value === 'number').toBe(true);
      });
    });
  });

  describe('Interval Support', () => {
    it('should support 5m, 30m, and 1d intervals', async () => {
      const endTime5m = alignTo5Minutes(new Date());
      const startTime5m = alignTo5Minutes(new Date(endTime5m.getTime() - 2 * 60 * 60 * 1000)); // 2 hours

      // Test that 5m works
      const response5m = await makeRequest({
        interval: '5m',
        startTime: startTime5m.toISOString(),
        endTime: endTime5m.toISOString(),
      });

      expect(response5m.status).toBe(200);

      // Test that 30m works (needs 30-minute alignment)
      const endTime30m = alignTo30Minutes(new Date());
      const startTime30m = alignTo30Minutes(new Date(endTime30m.getTime() - 2 * 60 * 60 * 1000)); // 2 hours

      const response30m = await makeRequest({
        interval: '30m',
        startTime: startTime30m.toISOString(),
        endTime: endTime30m.toISOString(),
      });

      expect(response30m.status).toBe(200);

      // Test that 1d works (390 days = 13 * 30 days)
      const response1d = await makeRequest({
        interval: '1d',
        startTime: '2024-10-01',
        endTime: '2025-10-24',
      });

      expect(response1d.status).toBe(200);

      // Test that 1m is rejected
      const response1m = await makeRequest({
        interval: '1m',
        startTime: startTime5m.toISOString(),
        endTime: endTime5m.toISOString(),
      });

      expect(response1m.status).toBe(501);

      const error1m = await response1m.json();
      expect(error1m.error).toContain('Only 5m, 30m, and 1d intervals are supported');
    });
  });

  describe('Default Behavior', () => {
    it('should return all available fields dynamically', async () => {
      const endTime = alignTo5Minutes(new Date());
      const startTime = alignTo5Minutes(new Date(endTime.getTime() - 30 * 60 * 1000)); // 30 minutes

      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      const dataIds = data.data.map((d: any) => d.id);

      // Should include all default fields (dynamically generated)
      expect(dataIds.some((id: string) => id.includes('solar'))).toBe(true);
      expect(dataIds.some((id: string) => id.includes('load'))).toBe(true);
      expect(dataIds.some((id: string) => id.includes('battery'))).toBe(true);
      expect(dataIds.some((id: string) => id.includes('grid'))).toBe(true);
    });
  });

  describe('Response Format', () => {
    it('should return OpenNEM-compatible format', async () => {
      const endTime = alignTo5Minutes(new Date());
      const startTime = alignTo5Minutes(new Date(endTime.getTime() - 60 * 60 * 1000)); // 1 hour

      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();

      // Check OpenNEM format
      expect(data.type).toBe('energy');
      expect(data.version).toBe('v4.1');
      expect(data.network).toBe('liveone');
      expect(data.created_at).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);

      // Check data series format (should have multiple series)
      expect(data.data.length).toBeGreaterThan(0);
      const series = data.data[0];
      expect(series.id).toBeDefined();
      expect(series.type).toBeDefined();
      expect(series.units).toBeDefined();
      expect(series.history).toBeDefined();
      expect(series.history.start).toBeDefined();
      expect(series.history.last).toBeDefined();
      expect(series.history.interval).toBe('5m');
      expect(Array.isArray(series.history.data)).toBe(true);
    });
  });
});