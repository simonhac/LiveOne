/**
 * User cache for username → Clerk ID lookups
 */

import { kv, kvKey } from "./kv";
import { clerkClient } from "@clerk/nextjs/server";

/**
 * Username cache entry
 */
export interface UsernameCacheEntry {
  clerkId: string; // Clerk user ID
  lastUpdatedTimeMs: number; // Unix timestamp in milliseconds when cache was last updated
}

/**
 * Get Clerk user ID by username.
 *
 * The cache is only a lookup hint: Clerk usernames can change outside this app, so a cached entry is
 * verified against the live Clerk user before it is returned. If it is stale, remove it and resolve
 * the requested username again from Clerk.
 *
 * @param username - Username to lookup
 * @returns Clerk user ID or null if not found
 */
export async function getUserIdByUsername(
  username: string,
): Promise<string | null> {
  let client: Awaited<ReturnType<typeof clerkClient>>;
  try {
    client = await clerkClient();
  } catch (error) {
    console.error("Failed to create Clerk client for username lookup:", error);
    return null;
  }

  // Try cache first, but verify it before trusting it.
  const cached = await kv.get<UsernameCacheEntry>(
    kvKey(`username:${username}`),
  );
  if (cached) {
    try {
      const user = await client.users.getUser(cached.clerkId);
      if (user.username === username) {
        return cached.clerkId;
      }
    } catch (error) {
      console.error("Failed to verify cached username from Clerk:", error);
    }

    await invalidateUsernameCache(username);
  }

  // Cache miss or stale entry - query Clerk API by the requested username.
  try {
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
 * Get Clerk user ID by email address (no cache — invites are infrequent).
 *
 * @param email - Email address to look up
 * @returns Clerk user ID or null if no user has that email
 */
export async function getUserIdByEmail(email: string): Promise<string | null> {
  try {
    const client = await clerkClient();
    const users = await client.users.getUserList({
      emailAddress: [email],
    });
    return users.data[0]?.id ?? null;
  } catch (error) {
    console.error("Failed to lookup email from Clerk:", error);
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
  const entry: UsernameCacheEntry = {
    clerkId,
    lastUpdatedTimeMs: Date.now(),
  };
  await kv.set(kvKey(`username:${username}`), entry);
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
