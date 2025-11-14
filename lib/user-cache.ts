/**
 * User cache for fast username → Clerk ID lookups
 */

import { kv, kvKey } from "./kv";
import { clerkClient } from "@clerk/nextjs/server";

/**
 * Get Clerk user ID by username
 * Checks cache first, falls back to Clerk API if not found
 *
 * @param username - Username to lookup
 * @returns Clerk user ID or null if not found
 */
export async function getUserIdByUsername(
  username: string,
): Promise<string | null> {
  // Try cache first (fast path)
  const cached = await kv.get<string>(kvKey(`username:${username}`));
  if (cached) {
    return cached;
  }

  // Cache miss - query Clerk API
  try {
    const client = await clerkClient();
    const users = await client.users.getUserList({
      username: [username],
    });

    if (users.data.length === 0) {
      return null;
    }

    const user = users.data[0];

    // Populate cache for next time
    await cacheUsernameMapping(username, user.id);

    return user.id;
  } catch (error) {
    console.error("Failed to lookup username from Clerk:", error);
    return null;
  }
}

/**
 * Cache a username → Clerk ID mapping
 *
 * @param username - Username
 * @param clerkId - Clerk user ID
 */
export async function cacheUsernameMapping(
  username: string,
  clerkId: string,
): Promise<void> {
  await kv.set(kvKey(`username:${username}`), clerkId);
}

/**
 * Invalidate username cache entry
 * Call this when a user changes their username
 *
 * @param username - Old username to invalidate
 */
export async function invalidateUsernameCache(username: string): Promise<void> {
  await kv.del(kvKey(`username:${username}`));
}

/**
 * Update username cache when username changes
 * Invalidates old username and caches new one
 *
 * @param oldUsername - Previous username (to invalidate)
 * @param newUsername - New username (to cache)
 * @param clerkId - Clerk user ID
 */
export async function updateUsernameCache(
  oldUsername: string | null,
  newUsername: string,
  clerkId: string,
): Promise<void> {
  if (oldUsername) {
    await invalidateUsernameCache(oldUsername);
  }
  await cacheUsernameMapping(newUsername, clerkId);
}
