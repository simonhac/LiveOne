/**
 * Tesla API Client
 *
 * Uses the Tesla Owner API to fetch vehicle data.
 * Tokens should be obtained externally (e.g., via teslapy or a Tesla auth app).
 */

import type {
  TeslaCredentials,
  TeslaVehicle,
  TeslaVehicleData,
  TeslaTokenResponse,
} from "./types";

// Tesla API endpoints
const OWNER_API_BASE = "https://owner-api.teslamotors.com";
const AUTH_API_BASE = "https://auth.tesla.com";

// Tesla OAuth client ID (public, used by all third-party apps)
const TESLA_CLIENT_ID = "ownerapi";

export class TeslaApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: any,
  ) {
    super(message);
    this.name = "TeslaApiError";
  }
}

export class TeslaClient {
  private accessToken: string;
  private refreshToken: string;
  private vehicleId?: string;

  constructor(credentials: TeslaCredentials) {
    this.accessToken = credentials.accessToken;
    this.refreshToken = credentials.refreshToken;
    this.vehicleId = credentials.vehicleId;
  }

  /**
   * Make an authenticated request to Tesla API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${OWNER_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (response.status === 401) {
      // Token expired, try to refresh
      await this.refreshAccessToken();

      // Retry the request with new token
      const retryResponse = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!retryResponse.ok) {
        throw new TeslaApiError(
          `Tesla API error after token refresh: ${retryResponse.status}`,
          retryResponse.status,
          await retryResponse.text(),
        );
      }

      return retryResponse.json();
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new TeslaApiError(
        `Tesla API error: ${response.status} - ${errorText}`,
        response.status,
        errorText,
      );
    }

    return response.json();
  }

  /**
   * Refresh the access token using the refresh token
   */
  private async refreshAccessToken(): Promise<void> {
    console.log("[Tesla] Refreshing access token...");

    const response = await fetch(`${AUTH_API_BASE}/oauth2/v3/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: TESLA_CLIENT_ID,
        refresh_token: this.refreshToken,
      }),
    });

    if (!response.ok) {
      throw new TeslaApiError(
        "Failed to refresh Tesla token",
        response.status,
        await response.text(),
      );
    }

    const data: TeslaTokenResponse = await response.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;

    console.log("[Tesla] Access token refreshed successfully");
  }

  /**
   * Get list of vehicles on the account
   */
  async getVehicles(): Promise<TeslaVehicle[]> {
    const response = await this.request<{ response: TeslaVehicle[] }>(
      "/api/1/vehicles",
    );
    return response.response;
  }

  /**
   * Get the selected vehicle (first one if not specified)
   */
  async getVehicle(): Promise<TeslaVehicle> {
    const vehicles = await this.getVehicles();

    if (vehicles.length === 0) {
      throw new TeslaApiError("No vehicles found on this Tesla account");
    }

    if (this.vehicleId) {
      const vehicle = vehicles.find((v) => v.id === this.vehicleId);
      if (!vehicle) {
        throw new TeslaApiError(`Vehicle ${this.vehicleId} not found`);
      }
      return vehicle;
    }

    return vehicles[0];
  }

  /**
   * Wake up the vehicle
   * Returns true if vehicle is now online, false if still waking
   */
  async wakeUp(vehicleId: string): Promise<boolean> {
    console.log(`[Tesla] Waking up vehicle ${vehicleId}...`);

    const response = await this.request<{ response: { state: string } }>(
      `/api/1/vehicles/${vehicleId}/wake_up`,
      { method: "POST" },
    );

    const isOnline = response.response.state === "online";
    console.log(`[Tesla] Vehicle state after wake: ${response.response.state}`);

    return isOnline;
  }

  /**
   * Wait for vehicle to wake up with retries
   */
  async ensureAwake(vehicleId: string, maxRetries = 5): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      const isOnline = await this.wakeUp(vehicleId);
      if (isOnline) {
        return;
      }

      // Wait before retrying
      const waitMs = 2000 * (i + 1);
      console.log(
        `[Tesla] Vehicle not yet online, waiting ${waitMs}ms (attempt ${i + 1}/${maxRetries})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    throw new TeslaApiError(
      `Vehicle ${vehicleId} did not wake up after ${maxRetries} attempts`,
    );
  }

  /**
   * Get complete vehicle data (all states)
   * Will wake the vehicle if needed
   */
  async getVehicleData(vehicleId?: string): Promise<TeslaVehicleData> {
    const id = vehicleId || (await this.getVehicle()).id;

    try {
      const response = await this.request<{ response: TeslaVehicleData }>(
        `/api/1/vehicles/${id}/vehicle_data`,
      );
      return response.response;
    } catch (error) {
      if (
        error instanceof TeslaApiError &&
        error.statusCode === 408 // Request timeout - vehicle asleep
      ) {
        // Wake the vehicle and retry
        await this.ensureAwake(id);
        const response = await this.request<{ response: TeslaVehicleData }>(
          `/api/1/vehicles/${id}/vehicle_data`,
        );
        return response.response;
      }
      throw error;
    }
  }

  /**
   * Check if vehicle is currently charging
   */
  isCharging(data: TeslaVehicleData): boolean {
    return data.charge_state.charging_state === "Charging";
  }

  /**
   * Check if vehicle is plugged in
   */
  isPluggedIn(data: TeslaVehicleData): boolean {
    return (
      data.charge_state.charge_port_latch === "Engaged" ||
      data.charge_state.charging_state !== "Disconnected"
    );
  }

  /**
   * Get the current tokens (useful after refresh)
   */
  getTokens(): { accessToken: string; refreshToken: string } {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
    };
  }
}

/**
 * Create a Tesla client from credentials
 */
export function createTeslaClient(credentials: TeslaCredentials): TeslaClient {
  return new TeslaClient(credentials);
}
