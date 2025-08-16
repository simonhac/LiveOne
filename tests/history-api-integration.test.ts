import { describe, it, expect, beforeAll } from '@jest/globals';

const API_URL = 'http://localhost:3000/api/history';
const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN || 'test-token'; // Set TEST_AUTH_TOKEN env var with actual token

describe('History API Integration Tests - 5m Interval Support', () => {
  
  beforeAll(() => {
    if (!process.env.TEST_AUTH_TOKEN) {
      console.warn('⚠️  TEST_AUTH_TOKEN not set. Tests will fail. Set it with: export TEST_AUTH_TOKEN=your-actual-token');
    }
  });

  const makeRequest = async (params: Record<string, string> = {}) => {
    const url = new URL(API_URL);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    
    return fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      },
    });
  };

  describe('Parameter Validation', () => {
    it('should accept startTime and endTime parameters in ISO 8601 format', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
      
      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar',
      });
      
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
        fields: 'solar',
      });
      
      expect(response.status).toBe(400);
      
      const data = await response.json();
      expect(data.error).toContain('Invalid date format');
    });

    it('should reject when startTime is after endTime', async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60 * 60 * 1000);
      
      const response = await makeRequest({
        interval: '5m',
        startTime: now.toISOString(),
        endTime: earlier.toISOString(),
        fields: 'solar',
      });
      
      expect(response.status).toBe(400);
      
      const data = await response.json();
      expect(data.error).toContain('startTime must be before endTime');
    });
  });

  describe('7.5 Day Limit Validation', () => {
    it('should accept 5m interval with time range up to 7.5 days', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 7.4 * 24 * 60 * 60 * 1000); // 7.4 days
      
      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar',
      });
      
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.data[0]?.history?.interval).toBe('5m');
    });

    it('should reject 5m interval with time range exceeding 7.5 days', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 8 * 24 * 60 * 60 * 1000); // 8 days
      
      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar',
      });
      
      expect(response.status).toBe(400);
      
      const data = await response.json();
      expect(data.error).toContain('Time range exceeds maximum of 7.5 days');
    });

    it('should not apply 7.5 day limit to 1m interval', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days
      
      const response = await makeRequest({
        interval: '1m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar',
      });
      
      // Should work unless there's a different limit for 1m
      // If it fails with 200, that's OK - we're testing that it doesn't fail with the 7.5 day error
      if (response.status === 400) {
        const data = await response.json();
        expect(data.error).not.toContain('7.5 days');
      } else {
        expect(response.status).toBe(200);
      }
    });
  });

  describe('5-Minute Data Aggregation', () => {
    it('should aggregate data to 5-minute boundaries', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000); // 1 hour
      
      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar',
      });
      
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.data[0]?.history?.interval).toBe('5m');
      
      // Should have approximately 13 data points for 1 hour at 5-minute intervals (0, 5, 10, ..., 60)
      const dataPoints = data.data[0]?.history?.data?.length || 0;
      expect(dataPoints).toBeGreaterThanOrEqual(12);
      expect(dataPoints).toBeLessThanOrEqual(13);
    });

    it('should handle null values for missing data points', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 3 * 60 * 60 * 1000); // 3 hours
      
      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar,load',
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

  describe('Interval Comparison', () => {
    it('should return fewer data points for 5m interval compared to 1m for same time range', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 2 * 60 * 60 * 1000); // 2 hours
      
      // Get 1m data
      const response1m = await makeRequest({
        interval: '1m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar',
      });
      
      // Get 5m data
      const response5m = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar',
      });
      
      expect(response1m.status).toBe(200);
      expect(response5m.status).toBe(200);
      
      const data1m = await response1m.json();
      const data5m = await response5m.json();
      
      const points1m = data1m.data[0]?.history?.data?.length || 0;
      const points5m = data5m.data[0]?.history?.data?.length || 0;
      
      // 5m should have approximately 1/5 the data points of 1m
      expect(points5m).toBeGreaterThan(0);
      expect(points1m).toBeGreaterThan(points5m);
      
      const ratio = points1m / points5m;
      expect(ratio).toBeGreaterThanOrEqual(3); // Allow for some variance due to missing data
      expect(ratio).toBeLessThanOrEqual(6);
    });
  });

  describe('Field Selection', () => {
    it('should return only requested fields', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 30 * 60 * 1000); // 30 minutes
      
      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar,battery',
      });
      
      expect(response.status).toBe(200);
      
      const data = await response.json();
      const dataIds = data.data.map((d: any) => d.id);
      
      // Should include solar and battery (power and SOC)
      expect(dataIds.some((id: string) => id.includes('solar'))).toBe(true);
      expect(dataIds.some((id: string) => id.includes('battery.power'))).toBe(true);
      expect(dataIds.some((id: string) => id.includes('battery.soc'))).toBe(true);
      
      // Should not include load or grid
      expect(dataIds.some((id: string) => id.includes('load'))).toBe(false);
      expect(dataIds.some((id: string) => id.includes('grid'))).toBe(false);
    });
  });

  describe('Default Behavior', () => {
    it('should use default time range when not specified for 5m interval', async () => {
      const response = await makeRequest({
        interval: '5m',
        fields: 'solar',
      });
      
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.data[0]?.history?.interval).toBe('5m');
      
      // Should have data for approximately 7 days
      const dataPoints = data.data[0]?.history?.data?.length || 0;
      // 7 days * 24 hours * 12 (5-min intervals per hour) = 2016
      // Allow for some missing data
      expect(dataPoints).toBeGreaterThan(1800);
      expect(dataPoints).toBeLessThanOrEqual(2017); // 7.5 days worth + 1
    });

    it('should default to all fields when fields parameter not specified', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 30 * 60 * 1000); // 30 minutes
      
      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });
      
      expect(response.status).toBe(200);
      
      const data = await response.json();
      const dataIds = data.data.map((d: any) => d.id);
      
      // Should include all default fields
      expect(dataIds.some((id: string) => id.includes('solar'))).toBe(true);
      expect(dataIds.some((id: string) => id.includes('load'))).toBe(true);
      expect(dataIds.some((id: string) => id.includes('battery'))).toBe(true);
      expect(dataIds.some((id: string) => id.includes('grid'))).toBe(true);
    });
  });

  describe('Response Format', () => {
    it('should return OpenNEM-compatible format', async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000); // 1 hour
      
      const response = await makeRequest({
        interval: '5m',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fields: 'solar',
      });
      
      expect(response.status).toBe(200);
      
      const data = await response.json();
      
      // Check OpenNEM format
      expect(data.type).toBe('energy');
      expect(data.version).toBe('v4');
      expect(data.network).toBe('liveone');
      expect(data.created_at).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
      
      // Check data series format
      const series = data.data[0];
      expect(series.id).toBeDefined();
      expect(series.type).toBe('power');
      expect(series.units).toBe('W');
      expect(series.history).toBeDefined();
      expect(series.history.start).toBeDefined();
      expect(series.history.last).toBeDefined();
      expect(series.history.interval).toBe('5m');
      expect(Array.isArray(series.history.data)).toBe(true);
    });
  });
});