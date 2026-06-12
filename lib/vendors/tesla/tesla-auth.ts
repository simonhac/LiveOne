/**
 * Centralized Tesla authentication handling
 *
 * This module handles token refresh logic in one place to avoid duplication
 * across all Tesla API calls.
 */

import {
  getSystemCredentials,
  storeSystemCredentials,
} from "@/lib/secure-credentials";
import { getTeslaClient } from "./tesla-client";
import type { TeslaCredentials, TeslaTokens } from "./types";

export interface TeslaAuthResult {
  accessToken: string;
  credentials: TeslaCredentials;
}

/**
 * Convert OAuth tokens to our credential format and store them.
 * @param fleetApiBaseUrl - region-specific Fleet host to persist (preserve across refreshes).
 */
export async function storeTeslaTokens(
  userId: string,
  tokens: TeslaTokens,
  systemId: number,
  vehicleId: string,
  fleetApiBaseUrl?: string,
) {
  const credentials: TeslaCredentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000),
    vehicle_id: vehicleId,
    ...(fleetApiBaseUrl ? { fleet_api_base_url: fleetApiBaseUrl } : {}),
  };

  return storeSystemCredentials(userId, systemId, "tesla", credentials);
}

/**
 * Get valid Tesla access token for a system, refreshing if needed
 *
 * This function:
 * 1. Retrieves stored credentials for the system
 * 2. Checks if the token is expiring soon (within 1 hour)
 * 3. Refreshes the token if needed and stores the new tokens
 * 4. Returns the valid access token and updated credentials
 *
 * @param userId - The user's Clerk ID
 * @param systemId - The system's database ID
 * @returns Valid access token and credentials
 * @throws Error if no credentials found or refresh fails
 */
export async function getValidTeslaToken(
  userId: string,
  systemId: number,
): Promise<TeslaAuthResult> {
  // Get stored credentials
  const credentials = await getSystemCredentials(userId, systemId);

  if (!credentials) {
    throw new Error(`No Tesla credentials found for system ${systemId}`);
  }

  // Type assertion for Tesla-specific fields
  const teslaCredentials = credentials as unknown as TeslaCredentials;

  // Check if token needs refresh (expires within 1 hour)
  const oneHourFromNow = new Date(Date.now() + 3600000);
  const expiresAt = new Date(teslaCredentials.expires_at);

  // If token is still valid for more than an hour, use it as-is
  if (expiresAt > oneHourFromNow) {
    return {
      accessToken: teslaCredentials.access_token,
      credentials: teslaCredentials,
    };
  }

  // Token is expiring soon, refresh it via the Fleet client.
  console.log(
    `[Tesla] Token expiring soon for system ${systemId}, refreshing...`,
  );

  try {
    const newTokens: TeslaTokens = await getTeslaClient().refreshTokens(
      teslaCredentials.refresh_token,
    );

    // Store the new tokens (preserving the persisted regional Fleet host)
    const storeResult = await storeTeslaTokens(
      userId,
      newTokens,
      systemId,
      teslaCredentials.vehicle_id,
      teslaCredentials.fleet_api_base_url,
    );
    if (!storeResult.success) {
      throw new Error(storeResult.error || "Failed to store refreshed tokens");
    }

    console.log(`[Tesla] Token refreshed successfully for system ${systemId}`);

    // Return the new access token and updated credentials
    return {
      accessToken: newTokens.access_token,
      credentials: {
        ...teslaCredentials,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expires_at: new Date(Date.now() + newTokens.expires_in * 1000),
        fleet_api_base_url: teslaCredentials.fleet_api_base_url,
      },
    };
  } catch (error) {
    console.error(
      `[Tesla] Failed to refresh token for system ${systemId}:`,
      error,
    );
    throw new Error(
      `Token refresh failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
