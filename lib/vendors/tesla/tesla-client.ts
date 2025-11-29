/**
 * Tesla API Client
 *
 * Handles OAuth authentication and API calls to Tesla Fleet API.
 * Uses PKCE (Proof Key for Code Exchange) for secure OAuth flow.
 */

import crypto from "crypto";
import type { TeslaTokens, TeslaVehicle, TeslaVehicleData } from "./types";

// Tesla API endpoints
const AUTH_BASE_URL = "https://auth.tesla.com";
const FLEET_API_BASE_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";

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

  constructor() {
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
      const response = await fetch(`${FLEET_API_BASE_URL}/api/1/vehicles`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        console.error("TESLA: Failed to fetch vehicles:", response.status);
        throw new Error(`Failed to fetch vehicles: ${response.status}`);
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
        `${FLEET_API_BASE_URL}/api/1/vehicles/${vehicleId}/wake_up`,
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
        `${FLEET_API_BASE_URL}/api/1/vehicles/${vehicleId}/vehicle_data`,
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
}

/**
 * Factory function to get the Tesla client
 */
export function getTeslaClient(): ITeslaClient {
  return new TeslaClient();
}
