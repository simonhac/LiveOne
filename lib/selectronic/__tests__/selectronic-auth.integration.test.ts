/**
 * Integration tests for Selectronic authentication
 * 
 * Requires:
 * - CLERK_SECRET_KEY environment variable
 * - TEST_USER_ID environment variable (Clerk user ID with Select.Live credentials)
 */

// Load environment variables from .env.local for testing
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { SelectronicFetchClient } from '../selectronic-client';
import { getVendorCredentials } from '../../secure-credentials';

describe('SelectronicFetchClient Authentication', () => {
  let VALID_CREDENTIALS: { email: string; password: string; systemNumber: string };
  
  beforeAll(async () => {
    // Get test user ID from environment or use default
    const testUserId = process.env.TEST_USER_ID || 'user_31xcrIbiSrjjTIKlXShEPilRow7';
    const testSystemNumber = process.env.TEST_SYSTEM_NUMBER || '1586'; // Default to Simon's system
    
    // Fetch credentials from Clerk
    const creds = await getVendorCredentials(testUserId, 'select.live');
    
    if (creds && 'email' in creds && 'password' in creds) {
      VALID_CREDENTIALS = {
        email: creds.email,
        password: creds.password,
        systemNumber: testSystemNumber, // System number comes from env or default
      };
    } else {
      throw new Error(
        `No Select.Live credentials found in Clerk for test user: ${testUserId}. ` +
        `Please ensure CLERK_SECRET_KEY is set and the user has Select.Live credentials configured.`
      );
    }
  });

  const INVALID_CREDENTIALS = {
    email: 'invalid@example.com',
    password: 'wrongpassword',
    systemNumber: '9999',
  };

  describe('authenticate()', () => {
    it('should return false for invalid credentials', async () => {
      const client = new SelectronicFetchClient(INVALID_CREDENTIALS);
      const result = await client.authenticate();
      
      expect(result).toBe(false);
    }, 30000); // 30 second timeout for network request

    it('should return true for valid credentials', async () => {
      const client = new SelectronicFetchClient(VALID_CREDENTIALS);
      const result = await client.authenticate();
      
      expect(result).toBe(true);
    }, 30000);

    it('should differentiate between valid and invalid credentials', async () => {
      // Test invalid
      const invalidClient = new SelectronicFetchClient(INVALID_CREDENTIALS);
      const invalidResult = await invalidClient.authenticate();
      
      // Test valid
      const validClient = new SelectronicFetchClient(VALID_CREDENTIALS);
      const validResult = await validClient.authenticate();
      
      // Assert they are different
      expect(invalidResult).toBe(false);
      expect(validResult).toBe(true);
      expect(invalidResult).not.toBe(validResult);
    }, 60000); // 60 second timeout for two requests
  });

  describe('fetchData()', () => {
    it('should fetch data successfully after valid authentication (or fail in magic window)', async () => {
      const client = new SelectronicFetchClient(VALID_CREDENTIALS);
      
      // First authenticate
      const authResult = await client.authenticate();
      expect(authResult).toBe(true);
      
      // Then fetch data
      const dataResult = await client.fetchData();
      
      // Check if we're in the magic window (48-52 minutes past hour)
      const minute = new Date().getMinutes();
      const isInMagicWindow = minute >= 48 && minute <= 52;
      
      if (isInMagicWindow) {
        // In magic window, should fail (but we still try the request)
        expect(dataResult.success).toBe(false);
        expect(dataResult.error).toBeDefined();
        // Error might be magic window or HTTP 500/503
      } else {
        // Outside magic window, should succeed
        expect(dataResult.success).toBe(true);
        expect(dataResult.data).toBeDefined();
        expect(dataResult.error).toBeUndefined();
        
        // Check data structure
        if (dataResult.data) {
          expect(typeof dataResult.data.solarW).toBe('number');
          expect(typeof dataResult.data.loadW).toBe('number');
          expect(typeof dataResult.data.batterySOC).toBe('number');
          expect(dataResult.data.batterySOC).toBeGreaterThanOrEqual(0);
          expect(dataResult.data.batterySOC).toBeLessThanOrEqual(100);
        }
      }
    }, 60000);

    it('should fail to fetch data without authentication', async () => {
      const client = new SelectronicFetchClient(INVALID_CREDENTIALS);
      
      // Try to fetch without valid auth
      const dataResult = await client.fetchData();
      
      expect(dataResult.success).toBe(false);
      expect(dataResult.error).toBeDefined();
      expect(dataResult.data).toBeUndefined();
    }, 60000);
  });
});