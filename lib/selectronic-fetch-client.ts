import fetch, { Headers, Response } from 'node-fetch';
import * as cheerio from 'cheerio';
import {
  API_CONFIG,
  SELECTLIVE_CONFIG,
  SelectronicData,
  ApiResponse,
  POLLING_CONFIG,
  ERROR_MESSAGES,
} from '@/config';

interface Credentials {
  email: string;
  password: string;
  systemNumber: string;
}

export interface SystemInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

/**
 * SelectronicClient using node-fetch with manual cookie handling
 * Based on how SelectronicMQTT C# client works
 */
export class SelectronicFetchClient {
  private cookies: Map<string, string> = new Map();
  private lastAuthTime?: Date;
  private credentials: Credentials;

  constructor(credentials?: Credentials) {
    // Use provided credentials or fall back to config
    this.credentials = credentials || {
      email: SELECTLIVE_CONFIG.username,
      password: SELECTLIVE_CONFIG.password,
      systemNumber: SELECTLIVE_CONFIG.systemNumber,
    };
  }

  /**
   * Check if we're in the magic window (48-52 minutes past hour)
   */
  private isInMagicWindow(): boolean {
    const minute = new Date().getMinutes();
    return minute >= POLLING_CONFIG.magicWindowStart && 
           minute <= POLLING_CONFIG.magicWindowEnd;
  }

  /**
   * Parse cookies from Set-Cookie headers
   */
  private parseCookies(setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      const parts = header.split(';')[0].split('=');
      if (parts.length === 2) {
        this.cookies.set(parts[0].trim(), parts[1].trim());
      }
    }
  }

  /**
   * Get cookie string for requests
   */
  private getCookieString(): string {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  /**
   * Authenticate with select.live
   */
  public async authenticate(): Promise<boolean> {
    try {
      console.log('[Auth] Authenticating with select.live...');
      
      // Prepare form data - matching what SelectronicMQTT does
      const params = new URLSearchParams();
      params.append('email', this.credentials.email);
      params.append('pwd', this.credentials.password);

      console.log('[Auth] Sending login request...');
      
      const response = await fetch(`${API_CONFIG.baseUrl}${API_CONFIG.loginEndpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'LiveOne/1.0',
          'Accept': '*/*',
        },
        body: params.toString(),
        redirect: 'manual', // Don't auto-follow to see the redirect
      });

      console.log(`[Auth] Response status: ${response.status}`);
      console.log(`[Auth] Response headers:`, response.headers.raw());

      // Handle cookies from response
      const setCookieHeaders = response.headers.raw()['set-cookie'];
      if (setCookieHeaders) {
        this.parseCookies(setCookieHeaders);
        console.log(`[Auth] Cookies received: ${this.cookies.size}`);
        console.log('[Auth] Cookie names:', Array.from(this.cookies.keys()));
      }

      // Check for redirect (which indicates successful login)
      if (response.status === 302 || response.status === 301) {
        const location = response.headers.get('location');
        console.log(`[Auth] Redirect to: ${location}`);
        
        if (location && (location.includes('dashboard') || location.includes('systems'))) {
          this.lastAuthTime = new Date();
          console.log('[Auth] Login successful - redirected to systems/dashboard');
          return true;
        }
      }

      // Check if we got a successful response (like SelectronicMQTT expects)
      if (response.status === 200) {
        // We got the login page back - check for error messages
        const text = await response.text();
        
        // Check for the exact error message
        if (text.includes('Bad email address or password')) {
          console.error('[Auth] Login failed - "Bad email address or password"');
          return false;
        }
        
        // Check if we have session cookies (unlikely with 200 response)
        if (this.cookies.size > 0) {
          this.lastAuthTime = new Date();
          console.log('[Auth] Login successful - got session cookies');
          return true;
        }
        
        console.log('[Auth] Got login page without error message - unexpected state');
        return false;
      }

      console.error('[Auth] Unexpected response status');
      return false;

    } catch (error) {
      console.error('[Auth] Authentication error:', error);
      return false;
    }
  }

  /**
   * Fetch system info from dashboard page
   */
  public async fetchSystemInfo(): Promise<SystemInfo | null> {
    try {
      // Ensure we have cookies
      if (this.cookies.size === 0) {
        console.log('[SystemInfo] No cookies, not authenticated');
        return null;
      }

      // Fetch dashboard page
      const url = `${API_CONFIG.baseUrl}/dashboard/${this.credentials.systemNumber}`;
      console.log(`[SystemInfo] Fetching system info from ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'Cookie': this.getCookieString(),
          'User-Agent': 'LiveOne/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        console.error(`[SystemInfo] Failed to fetch dashboard: ${response.status}`);
        return null;
      }

      const html = await response.text();
      
      // Parse HTML using cheerio for robust extraction
      const $ = cheerio.load(html);
      const systemInfo: SystemInfo = {};
      
      // Look for divs with table-cell display that contain system info
      // The structure is: <div>Label:</div><div>Value</div>
      $('div').each((_, element) => {
        const $el = $(element);
        const text = $el.text().trim();
        
        // Check for each field we're interested in
        if (text === 'SP PRO Model:') {
          const value = $el.next('div').text().trim();
          if (value) systemInfo.model = value;
        } else if (text === 'SP PRO Serial:') {
          const value = $el.next('div').text().trim();
          if (value) systemInfo.serial = value;
        } else if (text === 'SP PRO Ratings:') {
          const value = $el.next('div').text().trim();
          if (value) systemInfo.ratings = value;
        } else if (text === 'Solar Size:') {
          const value = $el.next('div').text().trim();
          if (value) systemInfo.solarSize = value;
        } else if (text === 'Battery Size:') {
          const value = $el.next('div').text().trim();
          if (value) systemInfo.batterySize = value;
        }
      });
      
      // Alternative approach: Look for elements by ID (if they have IDs)
      if (!systemInfo.model) {
        const modelById = $('#sppro_model').text().trim();
        if (modelById) systemInfo.model = modelById;
      }
      if (!systemInfo.serial) {
        // Note: The HTML shows the serial has wrong ID "sppro_model" instead of expected "sppro_serial"
        // This is why we rely on the label-based extraction above
      }
      if (!systemInfo.ratings) {
        const ratingsById = $('#sppro_rating').text().trim();
        if (ratingsById) systemInfo.ratings = ratingsById;
      }
      if (!systemInfo.solarSize) {
        const solarById = $('#solar_size').text().trim();
        if (solarById) systemInfo.solarSize = solarById;
      }
      if (!systemInfo.batterySize) {
        const batteryById = $('#battery_size').text().trim();
        if (batteryById) systemInfo.batterySize = batteryById;
      }
      
      console.log('[SystemInfo] Extracted info:', systemInfo);
      return systemInfo;
      
    } catch (error) {
      console.error('[SystemInfo] Error fetching system info:', error);
      return null;
    }
  }

  /**
   * Fetch data from select.live
   */
  public async fetchData(): Promise<ApiResponse<SelectronicData>> {
    try {
      // Check if we're in magic window but don't warn unless it fails
      const inMagicWindow = this.isInMagicWindow();

      // Ensure we have cookies
      if (this.cookies.size === 0) {
        console.log('[API] No cookies, authenticating...');
        const authSuccess = await this.authenticate();
        if (!authSuccess) {
          return {
            success: false,
            error: ERROR_MESSAGES.AUTH_FAILED,
            timestamp: new Date(),
          };
        }
      }

      // Fetch data
      const url = `${API_CONFIG.baseUrl}${API_CONFIG.dataEndpoint}/${this.credentials.systemNumber}`;
      console.log(`[API] Fetching data from ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'Cookie': this.getCookieString(),
          'User-Agent': 'LiveOne/1.0',
          'Accept': 'application/json',
        },
      });

      console.log(`[API] Response status: ${response.status}`);

      if (response.status === 401) {
        console.log('[API] Session expired, re-authenticating...');
        this.cookies.clear();
        
        const authSuccess = await this.authenticate();
        if (authSuccess) {
          return this.fetchData(); // Retry with fresh auth
        }
        
        return {
          success: false,
          error: ERROR_MESSAGES.AUTH_FAILED,
          timestamp: new Date(),
        };
      }

      if (!response.ok) {
        // Check if it's a magic window error (usually 500 or 503)
        if (inMagicWindow && (response.status === 500 || response.status === 503)) {
          console.warn('[API] Request failed during magic window (48-52 min)');
          return {
            success: false,
            error: `${ERROR_MESSAGES.MAGIC_WINDOW} (HTTP ${response.status})`,
            timestamp: new Date(),
          };
        }
        
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          timestamp: new Date(),
        };
      }

      const data = await response.json();
      console.log('[API] Data received successfully');
      
      // Transform the data - only fields that actually exist in the API
      const solarInverterW = data.items?.solarinverter_w || 0;
      const shuntW = data.items?.shunt_w || 0;
      
      const transformed: SelectronicData = {
        solarPower: solarInverterW + shuntW,  // Total solar = remote + local
        solarInverterPower: solarInverterW,   // Remote solar
        shuntPower: shuntW,                   // Local solar
        loadPower: data.items?.load_w || 0,
        batterySOC: data.items?.battery_soc || 0,
        batteryPower: data.items?.battery_w || 0,
        gridPower: data.items?.grid_w || 0,
        faultCode: data.items?.fault_code || 0,
        faultTimestamp: data.items?.fault_ts || 0,
        generatorStatus: data.items?.gen_status || 0,
        // Energy totals (API returns these as kWh despite _wh_ naming)
        solarKwhTotal: data.items?.solar_wh_total || 0,
        loadKwhTotal: data.items?.load_wh_total || 0,
        batteryInKwhTotal: data.items?.battery_in_wh_total || 0,
        batteryOutKwhTotal: data.items?.battery_out_wh_total || 0,
        gridInKwhTotal: data.items?.grid_in_wh_total || 0,
        gridOutKwhTotal: data.items?.grid_out_wh_total || 0,
        // Daily energy (API returns these as kWh despite _wh_ naming)
        solarKwhToday: data.items?.solar_wh_today || 0,
        loadKwhToday: data.items?.load_wh_today || 0,
        batteryInKwhToday: data.items?.battery_in_wh_today || 0,
        batteryOutKwhToday: data.items?.battery_out_wh_today || 0,
        gridInKwhToday: data.items?.grid_in_wh_today || 0,
        gridOutKwhToday: data.items?.grid_out_wh_today || 0,
        timestamp: data.items?.timestamp ? new Date(data.items.timestamp * 1000) : new Date(),
        raw: data,
      };

      // Log the actual data timestamp vs current time
      if (data.items?.timestamp) {
        const dataTime = new Date(data.items.timestamp * 1000);
        const now = new Date();
        const delaySeconds = Math.floor((now.getTime() - dataTime.getTime()) / 1000);
        console.log(`[API] Data timestamp: ${dataTime.toLocaleTimeString()} (${delaySeconds}s delay from inverter)`);
      }

      return {
        success: true,
        data: transformed,
        timestamp: new Date(),
      };

    } catch (error) {
      console.error('[API] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }
}