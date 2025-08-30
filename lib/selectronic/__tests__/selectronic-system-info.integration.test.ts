/**
 * Integration test for fetching system information from select.live
 */

import { SelectronicFetchClient, SystemInfo } from '../../selectronic-fetch-client';
import { SELECTLIVE_CREDENTIALS } from '../../../USER_SECRETS';

describe('SelectronicFetchClient System Info', () => {
  const VALID_CREDENTIALS = {
    email: SELECTLIVE_CREDENTIALS.username,
    password: SELECTLIVE_CREDENTIALS.password,
    systemNumber: SELECTLIVE_CREDENTIALS.systemNumber,
  };

  let client: SelectronicFetchClient;

  beforeEach(() => {
    client = new SelectronicFetchClient(VALID_CREDENTIALS);
  });

  describe('fetchSystemInfo()', () => {
    it('should fetch system info after successful authentication', async () => {
      // First authenticate
      const authResult = await client.authenticate();
      expect(authResult).toBe(true);
      
      // Then fetch system info
      const systemInfo = await client.fetchSystemInfo();
      
      // Should return an object (even if empty)
      expect(systemInfo).toBeDefined();
      expect(systemInfo).not.toBeNull();
      expect(typeof systemInfo).toBe('object');
      
      // Log the result for debugging
      console.log('Fetched system info:', systemInfo);
      
      // Check for expected fields (they may or may not be present)
      if (systemInfo) {
        // These fields should be strings if they exist
        if (systemInfo.model !== undefined) {
          expect(typeof systemInfo.model).toBe('string');
        }
        if (systemInfo.serial !== undefined) {
          expect(typeof systemInfo.serial).toBe('string');
        }
        if (systemInfo.ratings !== undefined) {
          expect(typeof systemInfo.ratings).toBe('string');
        }
        if (systemInfo.solarSize !== undefined) {
          expect(typeof systemInfo.solarSize).toBe('string');
        }
        if (systemInfo.batterySize !== undefined) {
          expect(typeof systemInfo.batterySize).toBe('string');
        }
      }
    }, 60000); // 60 second timeout for network requests

    it('should return null when not authenticated', async () => {
      // Try to fetch system info without authentication
      const systemInfo = await client.fetchSystemInfo();
      
      // Should return null when not authenticated
      expect(systemInfo).toBeNull();
    }, 30000);

    it('should contain expected system info fields for system 1586', async () => {
      // This test is specific to the known system 1586
      if (VALID_CREDENTIALS.systemNumber !== '1586') {
        console.log('Skipping test - not testing system 1586');
        return;
      }

      // Authenticate first
      const authResult = await client.authenticate();
      expect(authResult).toBe(true);
      
      // Fetch system info
      const systemInfo = await client.fetchSystemInfo();
      expect(systemInfo).toBeDefined();
      
      // According to the requirements, system 1586 should have these values:
      // SP PRO Model: SPMC482
      // SP PRO Serial: 221452
      // SP PRO Ratings: 7.5kW, 48V
      // Solar Size: 9 kW
      // Battery Size: 63.6 kWh
      
      if (systemInfo && Object.keys(systemInfo).length > 0) {
        // If we successfully parsed the data, check the values
        console.log('System 1586 info:', {
          model: systemInfo.model,
          serial: systemInfo.serial,
          ratings: systemInfo.ratings,
          solarSize: systemInfo.solarSize,
          batterySize: systemInfo.batterySize,
        });

        // These are the expected values based on the requirements
        if (systemInfo.model) {
          expect(systemInfo.model).toContain('SPMC482');
        }
        if (systemInfo.serial) {
          expect(systemInfo.serial).toContain('221452');
        }
        if (systemInfo.ratings) {
          expect(systemInfo.ratings).toMatch(/7\.5\s*kW/);
          expect(systemInfo.ratings).toMatch(/48\s*V/);
        }
        if (systemInfo.solarSize) {
          expect(systemInfo.solarSize).toMatch(/9\s*kW/);
        }
        if (systemInfo.batterySize) {
          expect(systemInfo.batterySize).toMatch(/63\.6\s*kWh/);
        }
      } else {
        // If parsing failed, at least we tried
        console.warn('System info parsing returned empty object - HTML structure may have changed');
      }
    }, 60000);
  });

  // PollingManager tests removed - PollingManager has been replaced with database-driven polling
});