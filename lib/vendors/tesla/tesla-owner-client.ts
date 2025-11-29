/**
 * Tesla Owner API Client
 *
 * Replicates TeslaPy's approach to make Owner API calls work.
 * Uses the same headers as TeslaPy (X-Tesla-User-Agent, User-Agent).
 *
 * This client doesn't require Fleet API credentials - it only needs an access token
 * to make data calls.
 */

import type { TeslaVehicle, TeslaVehicleData } from "./types";

// Tesla API endpoint - use Owner API for TeslaPy tokens
const OWNER_API_BASE_URL = "https://owner-api.teslamotors.com";

// Headers that TeslaPy uses - these are required for Owner API to work
const TESLA_HEADERS = {
  "Content-Type": "application/json",
  "X-Tesla-User-Agent": "TeslaApp/4.10.0",
  "User-Agent": "TeslaPy/2.9.0",
};

export class TeslaOwnerClient {
  /**
   * Get list of user's vehicles
   */
  async getVehicles(accessToken: string): Promise<TeslaVehicle[]> {
    try {
      // Use /api/1/products endpoint (not /api/1/vehicles) - this is what TeslaPy uses
      const response = await fetch(`${OWNER_API_BASE_URL}/api/1/products`, {
        headers: {
          ...TESLA_HEADERS,
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          "TESLA OWNER: Failed to fetch products:",
          response.status,
          errorText,
        );
        throw new Error(`Failed to fetch vehicles: ${response.status}`);
      }

      const data = await response.json();
      // Filter to only include vehicles (items with a 'vin' field)
      const products = data.response || [];
      return products.filter((p: any) => p.vin);
    } catch (error) {
      console.error("TESLA OWNER: Error fetching vehicles:", error);
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
        `${OWNER_API_BASE_URL}/api/1/vehicles/${vehicleId}/wake_up`,
        {
          method: "POST",
          headers: {
            ...TESLA_HEADERS,
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!wakeResponse.ok) {
        console.error(
          "TESLA OWNER: Wake up command failed:",
          wakeResponse.status,
        );
        return false;
      }

      // Poll until vehicle is online or timeout
      while (Date.now() - startTime < maxWaitMs) {
        const vehicles = await this.getVehicles(accessToken);
        const vehicle = vehicles.find((v) => String(v.id) === vehicleId);

        if (vehicle?.state === "online") {
          console.log(
            `TESLA OWNER: Vehicle ${vehicleId} is now online (took ${Date.now() - startTime}ms)`,
          );
          return true;
        }

        // Wait 2 seconds before polling again
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      console.warn(
        `TESLA OWNER: Vehicle ${vehicleId} did not wake up within ${maxWaitMs}ms`,
      );
      return false;
    } catch (error) {
      console.error("TESLA OWNER: Error waking up vehicle:", error);
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
        `${OWNER_API_BASE_URL}/api/1/vehicles/${vehicleId}/vehicle_data`,
        {
          headers: {
            ...TESLA_HEADERS,
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          "TESLA OWNER: Failed to fetch vehicle data:",
          response.status,
        );
        console.error("TESLA OWNER: Response body:", errorText);
        throw new Error(`Failed to fetch vehicle data: ${response.status}`);
      }

      const data = await response.json();
      return data.response;
    } catch (error) {
      console.error("TESLA OWNER: Error fetching vehicle data:", error);
      throw error;
    }
  }
}

// Singleton instance
let ownerClient: TeslaOwnerClient | null = null;

export function getTeslaOwnerClient(): TeslaOwnerClient {
  if (!ownerClient) {
    ownerClient = new TeslaOwnerClient();
  }
  return ownerClient;
}
