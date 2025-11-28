/**
 * Secure credential management using Clerk's private metadata
 *
 * This module handles storing and retrieving credentials for various
 * solar system vendors (Select.Live, Enphase, etc.) securely in
 * Clerk's private metadata, which is:
 * - Only accessible server-side
 * - Encrypted at rest
 * - Never exposed to the frontend
 */

import { clerkClient } from "@clerk/nextjs/server";
import { auth } from "@clerk/nextjs/server";

export type VendorType = "selectronic" | "enphase" | "mondo" | "fronius";

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
 * Store system credentials in Clerk private metadata
 */
export async function storeSystemCredentials(
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

    // Filter out existing credentials for this system
    const filteredCredentials = metadata.credentials.filter(
      (c) => c.systemId !== systemId,
    );

    // Add the new credentials
    const updatedMetadata: CredentialsMetadataV11 = {
      version: "1.1",
      credentials: [...filteredCredentials, credentialsWithMetadata],
    };

    await client.users.updateUser(userId, {
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
 * Get system credentials from Clerk private metadata
 */
export async function getSystemCredentials(
  userId: string,
  systemId: number,
): Promise<VendorCredentials | null> {
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
 * Remove system credentials from Clerk private metadata
 */
export async function removeSystemCredentials(
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

    // Filter out credentials for this system
    const filteredCredentials = metadata.credentials.filter(
      (c) => c.systemId !== systemId,
    );

    const updatedMetadata: CredentialsMetadataV11 = {
      version: "1.1",
      credentials: filteredCredentials,
    };

    await client.users.updateUser(userId, {
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
