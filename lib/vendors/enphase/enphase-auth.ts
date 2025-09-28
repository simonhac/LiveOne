/**
 * Centralized Enphase authentication handling
 *
 * This module handles token refresh logic in one place to avoid duplication
 * across all Enphase API calls.
 */

import { getSystemCredentials, storeSystemCredentials } from '@/lib/secure-credentials';
import { getEnphaseClient } from './enphase-client';
import type { EnphaseCredentials } from '@/lib/types/enphase';
import type { EnphaseTokens } from './types';

export interface EnphaseAuthResult {
  accessToken: string;
  credentials: EnphaseCredentials;
}

/**
 * Convert OAuth tokens to our credential format and store them
 */
export async function storeEnphaseTokens(
  userId: string,
  tokens: EnphaseTokens,
  systemId: number  // Our database system ID
) {
  const credentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + (tokens.expires_in * 1000)),  // Convert to Date
    enphase_user_id: tokens.enl_uid || ''
  };

  return storeSystemCredentials(userId, systemId, 'enphase', credentials);
}

/**
 * Get valid Enphase access token for a system, refreshing if needed
 *
 * This function:
 * 1. Retrieves stored credentials for the system
 * 2. Checks if the token is expiring soon (within 1 hour)
 * 3. Refreshes the token if needed and stores the new tokens
 * 4. Returns the valid access token and updated credentials
 *
 * @param userId - The user's Clerk ID
 * @param systemId - The system's database ID
 * @param vendorSiteId - The Enphase system ID (for storing refreshed tokens)
 * @returns Valid access token and credentials
 * @throws Error if no credentials found or refresh fails
 */
export async function getValidEnphaseToken(
  userId: string,
  systemId: number,
  vendorSiteId: string
): Promise<EnphaseAuthResult> {
  // Get stored credentials
  const credentials = await getSystemCredentials(userId, systemId);

  if (!credentials) {
    throw new Error(`No Enphase credentials found for system ${systemId}`);
  }

  // Type assertion for Enphase-specific fields
  const enphaseCredentials = credentials as unknown as EnphaseCredentials;

  // Check if token needs refresh (expires within 1 hour)
  const oneHourFromNow = new Date(Date.now() + 3600000);
  const expiresAt = new Date(enphaseCredentials.expires_at);

  // If token is still valid for more than an hour, use it as-is
  if (expiresAt > oneHourFromNow) {
    return {
      accessToken: enphaseCredentials.access_token,
      credentials: enphaseCredentials
    };
  }

  // Token is expiring soon, refresh it
  console.log(`[Enphase] Token expiring soon for system ${systemId}, refreshing...`);

  try {
    const client = getEnphaseClient();
    const newTokens = await client.refreshTokens(enphaseCredentials.refresh_token);

    // Store the new tokens
    const storeResult = await storeEnphaseTokens(userId, newTokens, systemId);
    if (!storeResult.success) {
      throw new Error(storeResult.error || 'Failed to store refreshed tokens');
    }

    console.log(`[Enphase] Token refreshed successfully for system ${systemId}`);

    // Return the new access token and updated credentials
    return {
      accessToken: newTokens.access_token,
      credentials: {
        ...enphaseCredentials,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expires_at: new Date(Date.now() + (newTokens.expires_in * 1000))
      }
    };
  } catch (error) {
    console.error(`[Enphase] Failed to refresh token for system ${systemId}:`, error);
    throw new Error(`Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Make an authenticated request to the Enphase API
 *
 * This is a convenience wrapper that:
 * 1. In development, proxies through production's enphase-proxy endpoint
 * 2. In production, gets a valid access token (refreshing if needed)
 * 3. Makes the API request with proper authentication headers
 * 4. Returns the response
 *
 * @param system - System object with id, ownerClerkUserId, and vendorSiteId
 * @param url - The Enphase API URL to request
 * @returns The fetch Response object
 */
export async function fetchWithEnphaseAuth(
  system: { id: number; ownerClerkUserId: string; vendorSiteId: string },
  url: string
): Promise<Response> {
  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    // In development, proxy through production
    // Remove the base URL if present
    const apiPath = url.replace('https://api.enphaseenergy.com', '');

    const prodUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://liveone.vercel.app';
    const proxyUrl = `${prodUrl}/api/enphase-proxy?systemId=${system.id}&url=${encodeURIComponent(apiPath)}`;

    console.log(`[Enphase] Proxying through production: ${apiPath}`);

    const response = await fetch(proxyUrl);

    if (!response.ok) {
      // Return the response as-is to let caller handle it
      return response;
    }

    const proxyResponse = await response.json();

    // Create a Response object from the proxy response
    return new Response(JSON.stringify(proxyResponse.response.data), {
      status: proxyResponse.response.status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // In production, use direct API call with authentication
  // Get valid access token
  const { accessToken } = await getValidEnphaseToken(
    system.ownerClerkUserId,
    system.id,
    system.vendorSiteId
  );

  // Add auth headers to the request
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'key': process.env.ENPHASE_API_KEY || ''
  };

  return fetch(url, { headers });
}