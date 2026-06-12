/**
 * Tesla API Client
 *
 * Handles OAuth authentication and API calls to Tesla Fleet API.
 * Uses PKCE (Proof Key for Code Exchange) for secure OAuth flow.
 */

import crypto from "crypto";
import type {
  TeslaCommandResult,
  TeslaRegion,
  TeslaTokens,
  TeslaVehicle,
  TeslaVehicleData,
} from "./types";
import { directCommandSigner, type TeslaCommandSigner } from "./command-signer";

// Tesla API endpoints
const AUTH_BASE_URL = "https://auth.tesla.com";
// Default regional Fleet host. AU accounts are served by the Asia-Pacific region,
// which is the `na` host; we still confirm per-user via GET /api/1/users/region and
// persist the result, so this is only the bootstrap/fallback value.
export const DEFAULT_FLEET_API_BASE_URL =
  "https://fleet-api.prd.na.vn.cloud.tesla.com";

// OAuth scopes needed for vehicle data
const OAUTH_SCOPES = [
  "openid",
  "offline_access",
  "vehicle_device_data",
  "vehicle_location",
  "vehicle_charging_cmds",
].join(" ");

/**
 * Generate PKCE code verifier and challenge
 */
export function generatePKCE(): {
  codeVerifier: string;
  codeChallenge: string;
} {
  // Generate random code verifier (43-128 characters)
  const codeVerifier = crypto.randomBytes(32).toString("base64url");

  // Generate code challenge using SHA256
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeVerifier, codeChallenge };
}

export interface ITeslaClient {
  getAuthorizationUrl(state: string, codeChallenge: string): string;
  exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<TeslaTokens>;
  refreshTokens(refreshToken: string): Promise<TeslaTokens>;
  getVehicles(accessToken: string): Promise<TeslaVehicle[]>;
  wakeUp(accessToken: string, vehicleId: string): Promise<boolean>;
  getVehicleData(
    accessToken: string,
    vehicleId: string,
  ): Promise<TeslaVehicleData>;
}

export class TeslaClient implements ITeslaClient {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private fleetBaseUrl: string;
  private signer: TeslaCommandSigner;

  constructor(options?: { baseUrl?: string; signer?: TeslaCommandSigner }) {
    const clientId = process.env.TESLA_CLIENT_ID;
    const clientSecret = process.env.TESLA_CLIENT_SECRET;
    const redirectUri = process.env.TESLA_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      const missing = [];
      if (!clientId) missing.push("TESLA_CLIENT_ID");
      if (!clientSecret) missing.push("TESLA_CLIENT_SECRET");
      if (!redirectUri) missing.push("TESLA_REDIRECT_URI");

      console.error(
        "TESLA: Missing required environment variables:",
        missing.join(", "),
      );
      throw new Error(
        `Tesla configuration incomplete: Missing ${missing.join(", ")}`,
      );
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.fleetBaseUrl = options?.baseUrl || DEFAULT_FLEET_API_BASE_URL;
    this.signer = options?.signer || directCommandSigner;
  }

  /**
   * Generate OAuth authorization URL with PKCE
   */
  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: OAUTH_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return `${AUTH_BASE_URL}/oauth2/v3/authorize?${params}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<TeslaTokens> {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
    });

    try {
      const response = await fetch(`${AUTH_BASE_URL}/oauth2/v3/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("TESLA: Token exchange failed");
        console.error("TESLA: Response status:", response.status);
        console.error("TESLA: Response body:", errorText);

        let errorDetail = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail =
            errorJson.error_description || errorJson.error || errorText;
        } catch {
          // Not JSON, use as is
        }

        throw new Error(
          `Token exchange failed: ${response.status} - ${errorDetail}`,
        );
      }

      const tokens = await response.json();
      return tokens;
    } catch (error) {
      console.error("TESLA: Error exchanging code for tokens:", error);
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshTokens(refreshToken: string): Promise<TeslaTokens> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: refreshToken,
    });

    try {
      const response = await fetch(`${AUTH_BASE_URL}/oauth2/v3/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("TESLA: Token refresh failed");
        console.error("TESLA: Response status:", response.status);
        console.error("TESLA: Response body:", errorText);

        let errorDetail = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail =
            errorJson.error_description || errorJson.error || errorText;
        } catch {
          // Not JSON, use as is
        }

        throw new Error(
          `Token refresh failed: ${response.status} - ${errorDetail}`,
        );
      }

      const tokens = await response.json();
      return tokens;
    } catch (error) {
      console.error("TESLA: Error refreshing tokens:", error);
      throw error;
    }
  }

  /**
   * Get list of user's vehicles
   */
  async getVehicles(accessToken: string): Promise<TeslaVehicle[]> {
    try {
      const response = await fetch(`${this.fleetBaseUrl}/api/1/vehicles`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(
          "TESLA: Failed to fetch vehicles:",
          response.status,
          body,
        );
        throw new Error(`Failed to fetch vehicles: ${response.status} ${body}`);
      }

      const data = await response.json();
      return data.response || [];
    } catch (error) {
      console.error("TESLA: Error fetching vehicles:", error);
      throw error;
    }
  }

  /**
   * Wake up a vehicle
   * @returns true if vehicle is awake, false if failed to wake
   */
  async wakeUp(
    accessToken: string,
    vehicleId: string,
    maxWaitMs: number = 30000,
  ): Promise<boolean> {
    const startTime = Date.now();

    try {
      // Send wake_up command
      const wakeResponse = await fetch(
        `${this.fleetBaseUrl}/api/1/vehicles/${vehicleId}/wake_up`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!wakeResponse.ok) {
        console.error("TESLA: Wake up command failed:", wakeResponse.status);
        return false;
      }

      // Poll until vehicle is online or timeout
      while (Date.now() - startTime < maxWaitMs) {
        const vehicles = await this.getVehicles(accessToken);
        const vehicle = vehicles.find((v) => String(v.id) === vehicleId);

        if (vehicle?.state === "online") {
          console.log(
            `TESLA: Vehicle ${vehicleId} is now online (took ${Date.now() - startTime}ms)`,
          );
          return true;
        }

        // Wait 2 seconds before polling again
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      console.warn(
        `TESLA: Vehicle ${vehicleId} did not wake up within ${maxWaitMs}ms`,
      );
      return false;
    } catch (error) {
      console.error("TESLA: Error waking up vehicle:", error);
      return false;
    }
  }

  /**
   * Get vehicle data including charge_state, drive_state, vehicle_state
   */
  async getVehicleData(
    accessToken: string,
    vehicleId: string,
  ): Promise<TeslaVehicleData> {
    try {
      const response = await fetch(
        `${this.fleetBaseUrl}/api/1/vehicles/${vehicleId}/vehicle_data`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error("TESLA: Failed to fetch vehicle data:", response.status);
        console.error("TESLA: Response body:", errorText);
        throw new Error(`Failed to fetch vehicle data: ${response.status}`);
      }

      const data = await response.json();
      return data.response;
    } catch (error) {
      console.error("TESLA: Error fetching vehicle data:", error);
      throw error;
    }
  }

  /**
   * Resolve the user's regional Fleet API base URL.
   * Called once after OAuth so we persist the right host instead of assuming NA.
   */
  async getUserRegion(accessToken: string): Promise<TeslaRegion> {
    const response = await fetch(`${this.fleetBaseUrl}/api/1/users/region`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("TESLA: Failed to fetch user region:", response.status);
      throw new Error(
        `Failed to fetch user region: ${response.status} ${errorText}`,
      );
    }

    const data = await response.json();
    const region = data.response;
    return {
      region: region?.region ?? "",
      fleet_api_base_url: region?.fleet_api_base_url || this.fleetBaseUrl,
    };
  }

  // ==========================================================================
  // Charge-control commands (Fleet API). Routed through the pluggable signer so
  // signing-exempt cars (our 2018 Model X) use direct REST and 2021+ cars can later
  // use a proxy/SDK signer without changing these methods. See command-signer.ts.
  // ==========================================================================

  /** Start charging. */
  async chargeStart(
    accessToken: string,
    vehicleId: string,
  ): Promise<TeslaCommandResult> {
    return this.sendCommand(accessToken, vehicleId, "charge_start");
  }

  /** Stop charging. */
  async chargeStop(
    accessToken: string,
    vehicleId: string,
  ): Promise<TeslaCommandResult> {
    return this.sendCommand(accessToken, vehicleId, "charge_stop");
  }

  /** Set the target charge limit (SoC %). Tesla accepts 50–100. */
  async setChargeLimit(
    accessToken: string,
    vehicleId: string,
    percent: number,
  ): Promise<TeslaCommandResult> {
    const clamped = Math.round(Math.min(100, Math.max(50, percent)));
    return this.sendCommand(accessToken, vehicleId, "set_charge_limit", {
      percent: clamped,
    });
  }

  /** Set the charging current limit (amps). Caller should bound by the vehicle max. */
  async setChargingAmps(
    accessToken: string,
    vehicleId: string,
    amps: number,
  ): Promise<TeslaCommandResult> {
    const clamped = Math.round(Math.max(0, amps));
    return this.sendCommand(accessToken, vehicleId, "set_charging_amps", {
      charging_amps: clamped,
    });
  }

  private async sendCommand(
    accessToken: string,
    vehicleId: string,
    command: string,
    body?: Record<string, unknown>,
  ): Promise<TeslaCommandResult> {
    return this.signer.send({
      baseUrl: this.fleetBaseUrl,
      accessToken,
      vehicleId,
      command,
      body,
    });
  }
}

/**
 * Factory function to get the Tesla Fleet client.
 * @param baseUrl - the system's persisted regional Fleet host (falls back to NA).
 */
export function getTeslaClient(baseUrl?: string): TeslaClient {
  return new TeslaClient({ baseUrl });
}

// Scopes requested for the app-level (client_credentials) partner token.
const PARTNER_SCOPES =
  "openid vehicle_device_data vehicle_location vehicle_charging_cmds";

/**
 * One-time Fleet API partner registration. Mints an app-level `client_credentials`
 * token (no user involved) and registers our domain via POST /api/1/partner_accounts.
 * Required before any user OAuth works — even read-only — and depends on the public key
 * being served at /.well-known/appspecific/com.tesla.3p.public-key.pem.
 */
export async function registerTeslaPartner(options: {
  domain: string;
  baseUrl?: string;
}): Promise<{ status: number; body: unknown }> {
  const clientId = process.env.TESLA_CLIENT_ID;
  const clientSecret = process.env.TESLA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing TESLA_CLIENT_ID / TESLA_CLIENT_SECRET");
  }
  const baseUrl = options.baseUrl || DEFAULT_FLEET_API_BASE_URL;

  // 1. App-level partner token (audience = regional Fleet host).
  const tokenResponse = await fetch(`${AUTH_BASE_URL}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: PARTNER_SCOPES,
      audience: baseUrl,
    }),
  });
  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(
      `Partner token request failed: ${tokenResponse.status} ${text}`,
    );
  }
  const { access_token: partnerToken } = await tokenResponse.json();

  // 2. Register the domain.
  const registerResponse = await fetch(`${baseUrl}/api/1/partner_accounts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${partnerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ domain: options.domain }),
  });
  const body = await registerResponse.json().catch(() => null);
  return { status: registerResponse.status, body };
}
