import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult, CredentialField } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import type { LatestReadingData } from '@/lib/types/readings';
import { db } from '@/lib/db';
import {
  pointInfo,
  pointReadings,
  pointSubGroups
} from '@/lib/db/schema-monitoring-points';
import { getNextMinuteBoundary } from '@/lib/date-utils';
import { eq, desc } from 'drizzle-orm';

interface MondoCredentials {
  email: string;
  password: string;
}

interface MondoAuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  id_token: string;
}

interface MondoMonitoringPoint {
  monitoringPointId: string;
  monitoringPointName: string;
  monitoringPointGroupName: string;
  loadType: string;
  energyNowW: number;
  totalEnergyWh: number;
  totalEnergyTodayWh?: number;
  totalEnergyYesterdayWh?: number;
}

export class MondoAdapter extends BaseVendorAdapter {
  readonly vendorType = 'mondo';
  readonly displayName = 'Mondo Power';
  readonly dataSource = 'poll' as const;
  readonly supportsAddSystem = true;

  /**
   * Override getLastReading - returns null for now
   * TODO: Implement reading from monitoring points tables
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    return null;
  }

  readonly credentialFields: CredentialField[] = [
    {
      name: 'email',
      label: 'Email',
      type: 'email',
      placeholder: 'your@email.com',
      required: true,
      helpText: 'Your Mondo Power account email'
    },
    {
      name: 'password',
      label: 'Password',
      type: 'password',
      placeholder: 'Enter your password',
      required: true,
      helpText: 'Your Mondo Power account password'
    }
  ];

  private baseUrl = 'https://api.mondopower.com.au';
  private authUrl = 'https://identity.mondopower.com.au';
  private cookies: string[] = [];

  private async authenticate(credentials: MondoCredentials): Promise<string> {
    try {
      // Step 1: Get login page and CSRF token
      const loginPageResponse = await fetch(`${this.authUrl}/Account/Login`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      // Store cookies
      const setCookies = loginPageResponse.headers.getSetCookie?.() || [];
      this.cookies = setCookies;

      const loginPageHtml = await loginPageResponse.text();
      const tokenMatch = loginPageHtml.match(/__RequestVerificationToken.*?value="([^"]+)"/);
      if (!tokenMatch) {
        throw new Error('Could not find CSRF token');
      }
      const csrfToken = tokenMatch[1];

      // Step 2: Submit login form
      const loginResponse = await fetch(`${this.authUrl}/Account/Login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this.cookies.join('; '),
          'User-Agent': 'Mozilla/5.0'
        },
        body: new URLSearchParams({
          'Email': credentials.email,
          'Password': credentials.password,
          'RememberMe': 'false',
          '__RequestVerificationToken': csrfToken
        }),
        redirect: 'manual'
      });

      // Update cookies
      const newCookies = loginResponse.headers.getSetCookie?.() || [];
      if (newCookies.length > 0) {
        this.cookies = [...this.cookies, ...newCookies];
      }

      // Step 3: Get authorization code using PKCE
      const clientId = 'platform.frontend';
      const redirectUri = 'https://platform.mondopower.com.au/signin-callback';
      const scope = 'openid profile mondoapi offline_access';
      const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

      const authUrl = `${this.authUrl}/connect/authorize?` +
        `client_id=${clientId}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `response_type=code&` +
        `scope=${encodeURIComponent(scope)}&` +
        `state=test123&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=S256&` +
        `response_mode=query`;

      const authResponse = await fetch(authUrl, {
        method: 'GET',
        headers: {
          'Cookie': this.cookies.join('; '),
          'User-Agent': 'Mozilla/5.0'
        },
        redirect: 'manual'
      });

      // Get redirect location with auth code
      const location = authResponse.headers.get('location');
      if (!location) {
        throw new Error('No redirect location from authorization');
      }

      const codeMatch = location.match(/code=([^&]+)/);
      if (!codeMatch) {
        throw new Error('Could not get authorization code');
      }
      const authCode = codeMatch[1];

      // Step 4: Exchange code for token
      const tokenResponse = await fetch(`${this.authUrl}/connect/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          'grant_type': 'authorization_code',
          'client_id': clientId,
          'code': authCode,
          'redirect_uri': redirectUri,
          'code_verifier': codeVerifier
        })
      });

      if (!tokenResponse.ok) {
        const text = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${text}`);
      }

      const tokenData: MondoAuthResponse = await tokenResponse.json();
      return tokenData.access_token;

    } catch (error) {
      console.error('[Mondo] Authentication error:', error);
      throw error;
    }
  }

  async poll(system: SystemForVendor, credentials: MondoCredentials): Promise<PollingResult> {
    try {
      console.log(`[Mondo] Starting poll for system ${system.id}`);

      // Use the system ID directly (previously was the same as pointGroup.id)
      const systemId = system.id;

      // Authenticate
      const accessToken = await this.authenticate(credentials);

      const sessionStartTime = Date.now();
      let apiCallCount = 0;
      let recordsProcessed = 0;

      try {
        // Get subcircuit details
        const subcircuitResponse = await fetch(
          `${this.baseUrl}/subcircuit/${system.vendorSiteId}`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Accept': 'application/json'
            }
          }
        );
        apiCallCount++;

        if (!subcircuitResponse.ok) {
          throw new Error(`Subcircuit API failed: ${subcircuitResponse.status}`);
        }

        const subcircuitData = await subcircuitResponse.json();
        const rows: MondoMonitoringPoint[] = subcircuitData.rows || [];

        // Get all points for this system
        const points = await db.select()
          .from(pointInfo)
          .where(eq(pointInfo.groupId, systemId));

        const pointMap = new Map(points.map(p => [p.vendorId, p]));
        const measurementTime = Date.now();
        const receivedTime = Date.now();

        // Process each monitoring point
        for (const row of rows) {
          const point = pointMap.get(row.monitoringPointId);

          if (!point) {
            console.warn(`[Mondo] Unknown monitoring point: ${row.monitoringPointId}`);
            continue;
          }

          // Insert reading
          await db.insert(pointReadings)
            .values({
              pointId: point.id,
              sessionId: null,  // No longer using measurement_sessions
              measurementTime,
              receivedTime,
              delayMs: receivedTime - measurementTime,
              powerW: row.energyNowW,
              energyWh: row.totalEnergyWh,
              energyTodayWh: row.totalEnergyTodayWh || null,
              energyYesterdayWh: row.totalEnergyYesterdayWh || null,
              deviceStatus: 'online',
              dataQuality: 'good',
              rawData: row
            })
            .onConflictDoUpdate({
              target: [pointReadings.pointId, pointReadings.measurementTime],
              set: {
                powerW: row.energyNowW,
                energyWh: row.totalEnergyWh,
                energyTodayWh: row.totalEnergyTodayWh || null,
                energyYesterdayWh: row.totalEnergyYesterdayWh || null,
                receivedTime,
                rawData: row
              }
            });

          // Update point's last seen time
          await db.update(pointInfo)
            .set({ lastSeenAt: receivedTime })
            .where(eq(pointInfo.id, point.id));

          recordsProcessed++;
        }

        console.log(`[Mondo] Poll complete: ${recordsProcessed} records processed`);

        // Calculate next poll time at the next 5-minute boundary
        const nextPollTime = getNextMinuteBoundary(5, system.timezoneOffsetMin); // 5-minute interval

        return this.polled(
          {} as CommonPollingData, // Not used for monitoring points
          recordsProcessed,
          nextPollTime
        );

      } catch (error) {
        throw error;
      }

    } catch (error) {
      console.error(`[Mondo] Poll error:`, error);
      return this.error(error instanceof Error ? error : new Error(String(error)));
    }
  }

/**
   * Fetch organizations from Mondo API
   */
  private async fetchOrganizations(accessToken: string): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/monitoring/organizations`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch organizations: ${response.status} ${response.statusText}`);
    }

    const organizations = await response.json();
    console.log(`[Mondo] Fetched ${organizations.length} organizations`);
    return organizations;
  }

  /**
   * Fetch monitoring point groups for a specific organization
   */
  private async fetchMonitoringPointGroups(orgId: string, accessToken: string): Promise<any[]> {
    const response = await fetch(
      `${this.baseUrl}/monitoring/organizations/${orgId}/points`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      }
    );

    if (!response.ok) {
      console.log(`[Mondo] Failed to fetch monitoring points for org ${orgId}: ${response.status}`);
      return [];
    }

    const points = await response.json();
    return Array.isArray(points) ? points : [];
  }


  /**
   * Test connection for an existing system with monitoring point group ID
   */
  private async testExistingSystem(
    system: SystemForVendor,
    accessToken: string
  ): Promise<TestConnectionResult> {
    console.log(`[Mondo] Testing existing system ${system.id} with monitoring point group ${system.vendorSiteId}`);

    try {
      // Fetch subcircuit/monitoring points data
      // The vendorSiteId is the widget/monitoring point group ID
      const dataUrl = `${this.baseUrl}/subcircuit/${system.vendorSiteId}`;
      console.log(`[Mondo] Fetching monitoring points from: ${dataUrl}`);

      const response = await fetch(dataUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        console.log(`[Mondo] Failed to fetch monitoring points: ${response.status}`);
        return {
          success: false,
          error: `Failed to fetch monitoring points: ${response.status} ${response.statusText}`,
          errorCode: response.status.toString()
        };
      }

      const rawData = await response.json();
      console.log(`[Mondo] Got monitoring points data from API for widget ${system.vendorSiteId}`);

      // Parse the monitoring points to calculate aggregated values
      let solarW: number | null = null;
      let loadW: number = 0; // Load is cumulative from all non-special points
      let batteryW: number | null = null;
      let gridW: number | null = null;
      let solarKwhTotal: number | null = null;
      let loadKwhTotal: number = 0;
      let batteryInKwhTotal: number | null = null;
      let batteryOutKwhTotal: number | null = null;
      let gridInKwhTotal: number | null = null;
      let gridOutKwhTotal: number | null = null;

      if (rawData.rows && Array.isArray(rawData.rows)) {
        console.log(`[Mondo] Processing ${rawData.rows.length} monitoring points`);

        for (const point of rawData.rows) {
          const currentPower = point.energyNowW || 0;
          const totalEnergy = (point.totalEnergyWh || 0) / 1000; // Convert to kWh

          // Categorize based on loadType
          switch (point.loadType) {
            case 'PvInverter':
            case 'HybridPv':
              if (solarW === null) solarW = 0;
              if (solarKwhTotal === null) solarKwhTotal = 0;
              solarW += Math.abs(currentPower);
              solarKwhTotal += totalEnergy;
              break;

            case 'HybridBattery':
              if (batteryW === null) batteryW = 0;
              batteryW += currentPower; // Positive = discharging, Negative = charging
              // For battery, we'd need separate in/out totals from historical data
              // The totalEnergyWh here might be total throughput
              if (batteryOutKwhTotal === null) batteryOutKwhTotal = 0;
              batteryOutKwhTotal += totalEnergy; // This is likely total energy throughput
              break;

            case 'Hybridinverter':
              if (batteryW === null) batteryW = 0;
              batteryW += currentPower;
              // Hybrid inverter might handle battery in/out
              if (batteryInKwhTotal === null) batteryInKwhTotal = 0;
              batteryInKwhTotal += totalEnergy;
              break;

            case 'GateMeter':
              gridW = currentPower; // Positive = importing, Negative = exporting
              // Gate meter total energy is likely total import
              // We'd need separate export data
              if (gridInKwhTotal === null) gridInKwhTotal = 0;
              gridInKwhTotal += totalEnergy;
              break;

            default:
              // Everything else is load
              loadW += Math.abs(currentPower);
              loadKwhTotal += totalEnergy;
              break;
          }

          console.log(`[Mondo] Point: ${point.monitoringPointName} (${point.loadType}) = ${currentPower}W, Total: ${totalEnergy}kWh`);
        }
      }

      // Round values only if they're not null
      if (solarW !== null) solarW = Math.round(solarW);
      if (batteryW !== null) batteryW = Math.round(batteryW);
      if (gridW !== null) gridW = Math.round(gridW);
      loadW = Math.round(loadW);

      if (solarKwhTotal !== null) solarKwhTotal = Math.round(solarKwhTotal * 1000) / 1000;
      loadKwhTotal = Math.round(loadKwhTotal * 1000) / 1000;
      if (batteryInKwhTotal !== null) batteryInKwhTotal = Math.round(batteryInKwhTotal * 1000) / 1000;
      if (batteryOutKwhTotal !== null) batteryOutKwhTotal = Math.round(batteryOutKwhTotal * 1000) / 1000;
      if (gridInKwhTotal !== null) gridInKwhTotal = Math.round(gridInKwhTotal * 1000) / 1000;
      if (gridOutKwhTotal !== null) gridOutKwhTotal = Math.round(gridOutKwhTotal * 1000) / 1000;

      // Create CommonPollingData from the aggregated monitoring points
      const latestData: CommonPollingData = {
        timestamp: new Date(),
        solarW,
        loadW,
        batteryW,
        gridW,
        batterySOC: null, // Not available from subcircuit endpoint
        solarKwhTotal,
        loadKwhTotal,
        batteryInKwhTotal,
        batteryOutKwhTotal,
        gridInKwhTotal,
        gridOutKwhTotal, // Grid export total not available from this endpoint
      };

      console.log(`[Mondo] Aggregated data - Solar: ${latestData.solarW}W, Load: ${latestData.loadW}W, Battery: ${latestData.batteryW}W, Grid: ${latestData.gridW}W`);

      return {
        success: true,
        systemInfo: {
          vendorSiteId: system.vendorSiteId,
          displayName: system.displayName || rawData.rows?.[0]?.monitoringPointGroupName || 'Mondo Power System',
          model: 'Mondo Power Monitor',
          serial: system.vendorSiteId
        },
        latestData,
        vendorResponse: rawData
      };

    } catch (error) {
      console.log('[Mondo] Error testing existing system:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test connection'
      };
    }
  }

  /**
   * Discover and test a new system
   */
  private async discoverNewSystem(accessToken: string): Promise<TestConnectionResult> {
    console.log(`[Mondo] Discovering monitoring point groups for new system`);

    const organizations = await this.fetchOrganizations(accessToken);

    if (!Array.isArray(organizations) || organizations.length === 0) {
      return {
        success: false,
        error: 'No monitoring organizations found for this Mondo Power account'
      };
    }

    // Find the first monitoring point group from any org
    for (const org of organizations) {
      const points = await this.fetchMonitoringPointGroups(org.id, accessToken);

      if (points.length > 0) {
        const firstPoint = points[0];
        console.log(`[Mondo] Found monitoring point group: ${firstPoint.id} in org ${org.name}`);

        return {
          success: true,
          systemInfo: {
            vendorSiteId: firstPoint.id,  // This should be saved as vendorSiteId
            displayName: `${firstPoint.name || 'Unnamed'} (${org.name})`,
            model: 'Mondo Power Monitor',
            serial: firstPoint.id
          },
          vendorResponse: {
            organizations,
            monitoringPointGroups: points,
            selectedOrg: org
          }
        };
      }
    }

    return {
      success: false,
      error: 'No monitoring point groups found in any organization'
    };
  }

  async testConnection(system: SystemForVendor, credentials: MondoCredentials): Promise<TestConnectionResult> {
    try {
      // Authenticate
      const accessToken = await this.authenticate(credentials);

      // Case 1: Testing existing system with monitoring point group ID
      if (system.id && system.id > 0 && system.vendorSiteId) {
        return await this.testExistingSystem(system, accessToken);
      }

      // Case 2: Discovering new system
      return await this.discoverNewSystem(accessToken);

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }
}