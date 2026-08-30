/**
 * Secure credential management using Clerk's private metadata
 *
 * This module handles storing and retrieving credentials for various
 * solar device vendors (Select.Live, Enphase, etc.) securely in
 * Clerk's private metadata, which is:
 * - Only accessible server-side
 * - Encrypted at rest
 * - Never exposed to the frontend
 *
 * 🛑 WRITE WITH `updateUserMetadata`, NEVER `updateUser`. They hit different Clerk endpoints:
 * `updateUserMetadata` is PATCH /users/{id}/metadata, which MERGES top-level keys, while
 * `updateUser` is PATCH /users/{id}, which REPLACES `privateMetadata` wholesale. This module builds
 * `{version, credentials}` from scratch, so writing it with `updateUser` silently deleted every
 * OTHER top-level key — in particular `cliTokens` (lib/cli-auth/store.ts), whose records are the
 * operator CLI's credential. A Tesla/Enphase token refresh would therefore log the CLI out a few
 * times a day, reported as "expired" because the presented token no longer matched any record.
 * Verified against a live Clerk instance: after `updateUser({privateMetadata:{version,credentials}})`
 * the stored keys are exactly `[version, credentials]` and `cliTokens` is gone.
 */

import { clerkClient } from "@clerk/nextjs/server";
import { auth } from "@clerk/nextjs/server";

// Note: "fronius" kept temporarily for backward compatibility with existing Clerk credentials
export type VendorType =
  | "selectronic"
  | "enphase"
  | "mondo"
  | "fusher"
  | "fronius"
  | "tesla"
  | "sigenergy"
  | "deepsea";

// Generic credentials interface - vendors define their own specific shapes
export interface VendorCredentials {
  systemId: number;
  vendorType: VendorType;
  created_at: string; // ISO8601 timestamp when credentials were stored
  [key: string]: any; // Allow vendor-specific fields
}

// v1.1 metadata structure
export interface CredentialsMetadataV11 {
  version: string; // "1.1"
  credentials: Array<VendorCredentials>;
}

/**
 * Store device credentials in Clerk private metadata
 */
export async function storeDeviceCredentials(
  userId: string,
  systemId: number,
  vendor: VendorType,
  credentials: Omit<
    VendorCredentials,
    "systemId" | "vendorType" | "created_at"
  >,
) {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const userIdentifier =
      user.username || user.emailAddresses[0]?.emailAddress || "unknown";

    let metadata = user.privateMetadata as unknown as CredentialsMetadataV11;

    // Initialize v1.1 format if needed
    if (!metadata?.version || !metadata?.credentials) {
      metadata = { version: "1.1", credentials: [] };
    }

    // Add systemId, vendorType and created_at to credentials
    const credentialsWithMetadata: VendorCredentials = {
      systemId,
      vendorType: vendor,
      created_at: new Date().toISOString(),
      ...credentials,
    };

    // Filter out existing credentials for this device
    const filteredCredentials = metadata.credentials.filter(
      (c) => c.systemId !== systemId,
    );

    // Add the new credentials
    const updatedMetadata: CredentialsMetadataV11 = {
      version: "1.1",
      credentials: [...filteredCredentials, credentialsWithMetadata],
    };

    await client.users.updateUserMetadata(userId, {
      privateMetadata: updatedMetadata as unknown as Record<string, unknown>,
    });

    // Credentials stored successfully
    return { success: true };
  } catch (error) {
    console.error(
      `[${vendor}] Failed to store credentials for system ${systemId}:`,
      error,
    );
    return {
      success: false,
      error: `Failed to store credentials for system ${systemId}`,
    };
  }
}

/**
 * Get device credentials from Clerk private metadata
 */
export async function getDeviceCredentials(
  userId: string,
  systemId: number,
): Promise<VendorCredentials | null> {
  // Ownerless devices (e.g. openelectricity) authenticate with an app-wide env
  // key and have no Clerk user — short-circuit before getUser() throws
  // "A valid resource ID is required." The minutely cron already rejects
  // per-user vendors with no owner upstream, so reaching here ownerless is a
  // legitimate app-credential vendor that returns null and polls anyway.
  if (!userId) return null;

  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const userIdentifier =
      user.username || user.emailAddresses[0]?.emailAddress || "unknown";

    const metadata = user.privateMetadata as unknown as CredentialsMetadataV11;

    if (!metadata?.version || !metadata?.credentials) {
      return null;
    }

    // Find credential by systemId
    const credential = metadata.credentials.find(
      (c) => c.systemId === systemId,
    );

    return credential || null;
  } catch (error) {
    console.error(
      `Failed to retrieve credentials for system ${systemId}:`,
      error,
    );
    return null;
  }
}

/**
 * Remove device credentials from Clerk private metadata
 */
export async function removeDeviceCredentials(
  userId: string,
  systemId: number,
) {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const metadata = user.privateMetadata as unknown as CredentialsMetadataV11;

    if (!metadata?.version || !metadata?.credentials) {
      return { success: true }; // Nothing to remove
    }

    // Filter out credentials for this device
    const filteredCredentials = metadata.credentials.filter(
      (c) => c.systemId !== systemId,
    );

    const updatedMetadata: CredentialsMetadataV11 = {
      version: "1.1",
      credentials: filteredCredentials,
    };

    await client.users.updateUserMetadata(userId, {
      privateMetadata: updatedMetadata as unknown as Record<string, unknown>,
    });

    return { success: true };
  } catch (error) {
    console.error(
      `Failed to remove credentials for system ${systemId}:`,
      error,
    );
    return {
      success: false,
      error: `Failed to remove credentials for system ${systemId}`,
    };
  }
}

/**
 * Get all credentials for a user
 */
export async function getAllUserCredentials(
  userId: string,
): Promise<VendorCredentials[]> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const metadata = user.privateMetadata as unknown as CredentialsMetadataV11;

    if (!metadata?.version || !metadata?.credentials) {
      return [];
    }

    return metadata.credentials;
  } catch (error) {
    console.error("Failed to retrieve all credentials:", error);
    return [];
  }
}
