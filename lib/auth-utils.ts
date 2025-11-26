import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "./db";
import { userSystems } from "./db/schema";
import { eq, or } from "drizzle-orm";

type AuthResult = Awaited<ReturnType<typeof auth>>;

/**
 * Check if user is a platform admin
 *
 * For best performance, pass the auth result from an existing auth() call:
 *   const authResult = await auth()
 *   const isAdmin = await isUserAdmin(authResult)
 *
 * If only userId is passed, will call auth() internally (slower).
 */
export async function isUserAdmin(
  authResultOrUserId?: AuthResult | string | null,
): Promise<boolean> {
  let authResult: AuthResult;
  let userId: string | null;

  // Determine if we received an auth result or just a userId
  if (
    authResultOrUserId &&
    typeof authResultOrUserId === "object" &&
    "userId" in authResultOrUserId
  ) {
    // Full auth result passed - use it directly (no redundant auth() call)
    authResult = authResultOrUserId;
    userId = authResult.userId;
  } else {
    // No auth result or just userId string - need to call auth()
    authResult = await auth();
    userId =
      typeof authResultOrUserId === "string"
        ? authResultOrUserId
        : authResult.userId;
  }

  if (!userId) {
    return false;
  }

  // First check session claims (if configured in Clerk Dashboard)
  // This avoids any network calls - best for performance
  if (
    authResult.sessionClaims &&
    "isPlatformAdmin" in authResult.sessionClaims
  ) {
    return authResult.sessionClaims.isPlatformAdmin === true;
  }

  try {
    // Fall back to checking Clerk public metadata via API
    // This makes a network call so it's slower (~100-150ms)
    const client = await clerkClient();
    const user = await client.users.getUser(userId);

    // Check public metadata for admin flag
    if (user.publicMetadata && typeof user.publicMetadata === "object") {
      const metadata = user.publicMetadata as any;
      if (metadata.isPlatformAdmin === true) {
        return true;
      }
    }
  } catch (error) {
    console.error("Error checking admin status:", error);
  }

  return false;
}

export async function getUserSystems(userId?: string | null) {
  // If userId is not provided, get it from auth
  if (!userId) {
    const authResult = await auth();
    userId = authResult.userId;
  }

  if (!userId) {
    return [];
  }

  return db
    .select()
    .from(userSystems)
    .where(eq(userSystems.clerkUserId, userId));
}
