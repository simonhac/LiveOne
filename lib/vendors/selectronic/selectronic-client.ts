import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { ERROR_MESSAGES } from "@/config";

/**
 * Internal type for Selectronic data from the API
 */
export interface SelectronicData {
  solarW: number | null; // Total solar (solarinverter_w + shunt_w) in Watts
  solarInverterW: number | null; // Remote solar generation in Watts
  shuntW: number | null; // Local solar generation in Watts
  // Every field below is nullable and `null` means "select.live did not send it" — NOT zero.
  // The adapter skips null readings (adapter.ts:111), so a missing field writes no point row at all.
  loadW: number | null; // Load in Watts
  batterySOC: number | null;
  batteryW: number | null; // Battery power in Watts (negative = charging)
  gridW: number | null; // Grid power in Watts
  faultCode: number | null;
  faultTimestamp: number | null; // Unix timestamp
  generatorStatus: number | null;
  // Energy totals (kWh despite the _wh_ in API names)
  solarKwhTotal: number | null;
  loadKwhTotal: number | null;
  batteryInKwhTotal: number | null;
  batteryOutKwhTotal: number | null;
  gridInKwhTotal: number | null;
  gridOutKwhTotal: number | null;
  // Daily energy (kWh despite the _wh_ in API names)
  solarKwhToday: number | null;
  loadKwhToday: number | null;
  batteryInKwhToday: number | null;
  batteryOutKwhToday: number | null;
  gridInKwhToday: number | null;
  gridOutKwhToday: number | null;
  timestamp: Date;
  raw?: Record<string, any>;
}

export interface ApiResponse<T> {
  success: boolean;
  errorCode?: string;
  errorKind?: string;
  data?: T;
  rawResponse?: any; // Raw response object from API
  error?: string;
  timestamp: Date;
}

// Select.Live API Configuration
/**
 * select.live is a web portal, not an API: `/login` is a form POST and the data endpoint is a
 * dashboard route. There is no token auth to move to — the session cookie IS the session.
 *
 * There was a `magicWindow` here (minutes 48-52, believed unavailable). Measured over 30 days on
 * prod it is no longer true: minutes 48, 49 and 51 had ZERO failures and 52 matched the all-hours
 * baseline. Only minute 50 shows anything (3.4%), and those are `Authentication failed` and
 * `socket hang up` — the portal declining to LOG YOU IN, not declining to serve data, which is
 * why reusing a session across polls matters more than any window handling.
 *
 * The window that does exist is daily, not hourly: 75% of all failures are HTTP 504 in the
 * 00:00-00:20 Sydney rollover, peaking at 00:15-00:17. It is not special-cased here — the client
 * reports what happened and the minutely poll re-attempts, which is all the old branch achieved.
 */
const SELECTLIVE_API = {
  baseUrl: "https://select.live",
  loginEndpoint: "/login",
  dataEndpoint: "/dashboard/hfdata",
} as const;

interface Credentials {
  email: string;
  password: string;
  systemNumber: string;
}

export interface DeviceInfo {
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

  /**
   * Milliseconds since this client last authenticated, or `null` if it never has.
   *
   * The caller decides how long a session may be reused (`SELECTRONIC_SESSION_TTL_MS`); the client
   * just reports its own age. Reading it here rather than tracking the time in the adapter keeps
   * the answer correct when the 401 handler below re-authenticates mid-poll — the adapter would
   * not see that, and would go on believing the session was as old as its last explicit login.
   */
  public sessionAgeMs(): number | null {
    return this.lastAuthTime ? Date.now() - this.lastAuthTime.getTime() : null;
  }
  private credentials: Credentials;

  constructor(credentials: Credentials) {
    // Per-device credentials come from Clerk (see lib/secure-credentials.ts).
    this.credentials = credentials;
  }

  /**
   * Check if we're in the magic window (48-52 minutes past hour)
   */

  /**
   * Parse cookies from Set-Cookie headers
   */
  private parseCookies(setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      const parts = header.split(";")[0].split("=");
      if (parts.length === 2) {
        this.cookies.set(parts[0].trim(), parts[1].trim());
      }
    }
  }

  /**
   * Get cookie string for requests
   */
  public getCookieString(): string {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  /**
   * Authenticate with select.live
   */
  public async authenticate(): Promise<boolean> {
    try {
      console.log("[Selectronic] Authenticating with select.live...");

      // Prepare form data - matching what SelectronicMQTT does
      const params = new URLSearchParams();
      params.append("email", this.credentials.email);
      params.append("pwd", this.credentials.password);

      console.log("[Selectronic] Sending login request...");

      const response = await fetch(
        `${SELECTLIVE_API.baseUrl}${SELECTLIVE_API.loginEndpoint}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "LiveOne/1.0",
            Accept: "*/*",
          },
          body: params.toString(),
          redirect: "manual", // Don't auto-follow to see the redirect
        },
      );

      console.log(`[Selectronic] Response status: ${response.status}`);

      // Handle cookies from response
      const setCookieHeaders = response.headers.raw()["set-cookie"];
      if (setCookieHeaders) {
        this.parseCookies(setCookieHeaders);
        console.log(`[Selectronic] Cookies received: ${this.cookies.size}`);
        console.log(
          "[Selectronic] Cookie names:",
          Array.from(this.cookies.keys()),
        );
      }

      // Check for redirect (which indicates successful login)
      if (response.status === 302 || response.status === 301) {
        const location = response.headers.get("location");
        console.log(`[Selectronic] Redirect to: ${location}`);

        if (
          location &&
          (location.includes("dashboard") || location.includes("systems"))
        ) {
          this.lastAuthTime = new Date();
          console.log(
            "[Selectronic] Login successful - redirected to systems/dashboard",
          );
          return true;
        }
      }

      // Check if we got a successful response (like SelectronicMQTT expects)
      if (response.status === 200) {
        // We got the login page back - check for error messages
        const text = await response.text();

        // Check for the exact error message
        if (text.includes("Bad email address or password")) {
          console.error(
            '[Auth] Login failed - "Bad email address or password"',
          );
          return false;
        }

        // Check if we have session cookies (unlikely with 200 response)
        if (this.cookies.size > 0) {
          this.lastAuthTime = new Date();
          console.log("[Selectronic] Login successful - got session cookies");
          return true;
        }

        console.log(
          "[Selectronic] Got login page without error message - unexpected state",
        );
        return false;
      }

      console.error("[Auth] Unexpected response status");
      return false;
    } catch (error) {
      console.error("[Auth] Authentication error:", error);
      return false;
    }
  }

  /**
   * Fetch device info from dashboard page
   */
  public async fetchDeviceInfo(): Promise<DeviceInfo | null> {
    try {
      // Ensure we have cookies
      if (this.cookies.size === 0) {
        console.log("[SystemInfo] No cookies, not authenticated");
        return null;
      }

      // Fetch dashboard page
      const url = `${SELECTLIVE_API.baseUrl}/dashboard/${this.credentials.systemNumber}`;
      console.log(`[SystemInfo] Fetching system info from ${url}`);

      const response = await fetch(url, {
        headers: {
          Cookie: this.getCookieString(),
          "User-Agent": "LiveOne/1.0",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (!response.ok) {
        console.error(
          `[SystemInfo] Failed to fetch dashboard: ${response.status}`,
        );
        return null;
      }

      const html = await response.text();

      // Parse HTML using cheerio for robust extraction
      const $ = cheerio.load(html);
      const deviceInfo: DeviceInfo = {};

      // Debug: Check if we got a valid dashboard page
      const pageTitle = $("title").text();
      console.log(`[SystemInfo] Page title: ${pageTitle}`);

      // Look for divs with table-cell display that contain device info
      // The structure is: <div class="table-row"><div>Label:</div><div>Value</div></div>
      $('div[style*="table-cell"]').each((_, element) => {
        const $el = $(element);
        const text = $el.text().trim();

        // Check for each field we're interested in
        if (text === "SP PRO Model:") {
          // Look for the next sibling with table-cell style
          const value = $el.next('div[style*="table-cell"]').text().trim();
          console.log(`[SystemInfo] Found model: ${value}`);
          if (value) deviceInfo.model = value;
        } else if (text === "SP PRO Serial:") {
          const value = $el.next('div[style*="table-cell"]').text().trim();
          if (value) deviceInfo.serial = value;
        } else if (text === "SP PRO Ratings:") {
          const value = $el.next('div[style*="table-cell"]').text().trim();
          if (value) deviceInfo.ratings = value;
        } else if (text === "Solar Size:") {
          const value = $el.next('div[style*="table-cell"]').text().trim();
          if (value) deviceInfo.solarSize = value;
        } else if (text === "Battery Size:") {
          const value = $el.next('div[style*="table-cell"]').text().trim();
          if (value) deviceInfo.batterySize = value;
        }
      });

      // Alternative approach: Look for elements by ID (if they have IDs)
      if (!deviceInfo.model) {
        const modelById = $("#sppro_model").text().trim();
        if (modelById) deviceInfo.model = modelById;
      }
      if (!deviceInfo.serial) {
        // Note: The HTML shows the serial has wrong ID "sppro_model" instead of expected "sppro_serial"
        // This is why we rely on the label-based extraction above
      }
      if (!deviceInfo.ratings) {
        const ratingsById = $("#sppro_rating").text().trim();
        if (ratingsById) deviceInfo.ratings = ratingsById;
      }
      if (!deviceInfo.solarSize) {
        const solarById = $("#solar_size").text().trim();
        if (solarById) deviceInfo.solarSize = solarById;
      }
      if (!deviceInfo.batterySize) {
        const batteryById = $("#battery_size").text().trim();
        if (batteryById) deviceInfo.batterySize = batteryById;
      }

      console.log(
        "[SystemInfo] Extracted info:",
        JSON.stringify(deviceInfo, null, 2),
      );
      return deviceInfo;
    } catch (error) {
      console.error("[SystemInfo] Error fetching system info:", error);
      return null;
    }
  }

  /**
   * Get list of available devices for the authenticated user
   */
  public async getDevicesList(): Promise<Array<{
    systemNumber: string;
    name?: string;
    model?: string;
    serialNumber?: string;
  }> | null> {
    try {
      // Ensure we're authenticated
      if (this.cookies.size === 0) {
        const authSuccess = await this.authenticate();
        if (!authSuccess) {
          return null;
        }
      }

      // Fetch the dashboard page to get device list
      const response = await fetch(`${SELECTLIVE_API.baseUrl}/dashboard`, {
        headers: {
          Cookie: this.getCookieString(),
          "User-Agent": "LiveOne/1.0",
        },
      });

      if (!response.ok) {
        console.error("[SystemsList] Failed to fetch dashboard");
        return null;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // Look for device selector or device information
      const devices: Array<{
        systemNumber: string;
        name?: string;
        model?: string;
        serialNumber?: string;
      }> = [];

      // Try to find device selector dropdown or similar
      $('select[name="system"], .system-selector option').each((_, el) => {
        const value = $(el).val() as string;
        const text = $(el).text().trim();
        if (value && value !== "") {
          devices.push({
            systemNumber: value,
            name: text,
          });
        }
      });

      // If no selector, look for single device info
      if (devices.length === 0) {
        // Try to extract from the current device being displayed
        const systemNumber =
          $("[data-system-id], .system-number").first().text().trim() ||
          this.credentials.systemNumber;

        if (systemNumber) {
          devices.push({
            systemNumber,
            name:
              $("[data-system-name], .system-name").first().text().trim() ||
              "System 1",
          });
        }
      }

      console.log("[SystemsList] Found systems:", devices);
      return devices.length > 0 ? devices : null;
    } catch (error) {
      console.error("[SystemsList] Error getting systems list:", error);
      return null;
    }
  }

  /**
   * Fetch data from select.live
   */
  public async fetchData(): Promise<ApiResponse<SelectronicData>> {
    try {
      // Ensure we have cookies
      if (this.cookies.size === 0) {
        console.log("[Selectronic] No cookies, authenticating...");
        const authSuccess = await this.authenticate();
        if (!authSuccess) {
          return {
            success: false,
            error: ERROR_MESSAGES.AUTH_FAILED,
            errorKind: "auth",
            timestamp: new Date(),
          };
        }
      }

      // Fetch data
      const url = `${SELECTLIVE_API.baseUrl}${SELECTLIVE_API.dataEndpoint}/${this.credentials.systemNumber}`;
      console.log(`[Selectronic] Fetching data from ${url}`);

      const response = await fetch(url, {
        headers: {
          Cookie: this.getCookieString(),
          "User-Agent": "LiveOne/1.0",
          Accept: "application/json",
        },
      });

      console.log(`[Selectronic] Response status: ${response.status}`);

      if (response.status === 401) {
        console.log("[Selectronic] Session expired, re-authenticating...");
        this.cookies.clear();

        const authSuccess = await this.authenticate();
        if (authSuccess) {
          return this.fetchData(); // Retry with fresh auth
        }

        return {
          success: false,
          error: ERROR_MESSAGES.AUTH_FAILED,
          errorKind: "auth",
          timestamp: new Date(),
        };
      }

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          errorCode: String(response.status),
          timestamp: new Date(),
        };
      }

      const responseText = await response.text();
      const data = JSON.parse(responseText);
      console.log("[Selectronic] Data received successfully");

      // Transform the data - only fields that actually exist in the API.
      //
      // A field select.live did not send must NEVER become a measurement. These helpers preserve a
      // genuine 0 but map absent/null/non-numeric to null, and the adapter SKIPS null readings
      // (adapter.ts:111) so no point row is written at all. The previous `|| 0` fabricated a zero
      // that is indistinguishable downstream from a real reading: a dropped `grid_w` would read as
      // "no grid/generator import" and a dropped `battery_soc` as a flat battery. (Same defect class
      // as the run-detector's inability to tell "no data" from "below threshold".)
      const transformed = transformSelectronicData(data);

      // Log the actual data timestamp vs current time
      if (data.items?.timestamp) {
        const dataTime = new Date(data.items.timestamp * 1000);
        const now = new Date();
        const delaySeconds = Math.floor(
          (now.getTime() - dataTime.getTime()) / 1000,
        );
        console.log(
          `[Selectronic] Data timestamp: ${dataTime.toLocaleTimeString()} (${delaySeconds}s delay from inverter)`,
        );
      }

      return {
        success: true,
        data: transformed,
        rawResponse: data, // Include the parsed JSON object
        timestamp: new Date(),
      };
    } catch (error) {
      console.error("[API] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        errorCode: (error as { code?: string })?.code,
        errorKind: error instanceof SyntaxError ? "parse" : undefined,
        timestamp: new Date(),
      };
    }
  }
}

/** The same pure decoder is used for production reads and scoped trial baseline exports. */
export function transformSelectronicData(
  data: Record<string, any>,
  fallbackTime = new Date(),
): SelectronicData {
  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const roundOrNull = (v: unknown): number | null => {
    const n = numOrNull(v);
    return n === null ? null : Math.round(n);
  };

  const solarInverterW = numOrNull(data.items?.solarinverter_w);
  const shuntW = numOrNull(data.items?.shunt_w);

  const transformed: SelectronicData = {
    solarW:
      solarInverterW !== null && shuntW !== null
        ? Math.round(solarInverterW + shuntW)
        : null, // Total solar = remote + local
    solarInverterW: solarInverterW !== null ? Math.round(solarInverterW) : null, // Remote solar
    shuntW: shuntW !== null ? Math.round(shuntW) : null, // Local solar
    loadW: roundOrNull(data.items?.load_w),
    batterySOC: numOrNull(data.items?.battery_soc),
    batteryW: roundOrNull(data.items?.battery_w),
    gridW: roundOrNull(data.items?.grid_w),
    faultCode: numOrNull(data.items?.fault_code),
    faultTimestamp: numOrNull(data.items?.fault_ts),
    generatorStatus: numOrNull(data.items?.gen_status),
    // Energy totals (API returns these as kWh despite _wh_ naming)
    solarKwhTotal: numOrNull(data.items?.solar_wh_total),
    loadKwhTotal: numOrNull(data.items?.load_wh_total),
    batteryInKwhTotal: numOrNull(data.items?.battery_in_wh_total),
    batteryOutKwhTotal: numOrNull(data.items?.battery_out_wh_total),
    gridInKwhTotal: numOrNull(data.items?.grid_in_wh_total),
    gridOutKwhTotal: numOrNull(data.items?.grid_out_wh_total),
    // Daily energy (API returns these as kWh despite _wh_ naming)
    solarKwhToday: numOrNull(data.items?.solar_wh_today),
    loadKwhToday: numOrNull(data.items?.load_wh_today),
    batteryInKwhToday: numOrNull(data.items?.battery_in_wh_today),
    batteryOutKwhToday: numOrNull(data.items?.battery_out_wh_today),
    gridInKwhToday: numOrNull(data.items?.grid_in_wh_today),
    gridOutKwhToday: numOrNull(data.items?.grid_out_wh_today),
    timestamp: data.items?.timestamp
      ? new Date(data.items.timestamp * 1000)
      : fallbackTime,
    raw: data,
  };

  return transformed;
}
