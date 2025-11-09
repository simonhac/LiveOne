import { NextRequest } from "next/server";
import { isUserAdmin } from "@/lib/auth-utils";

/**
 * Verify the request is from Vercel Cron or an admin user
 * @param request - The Next.js request object
 * @returns true if the request is authorized, false otherwise
 */
export async function validateCronRequest(
  request: NextRequest,
): Promise<boolean> {
  // In development, allow all requests
  if (process.env.NODE_ENV === "development") {
    return true;
  }

  const authHeader = request.headers.get("authorization");

  // Check if it's a valid cron request (if CRON_SECRET is configured)
  if (
    process.env.CRON_SECRET &&
    authHeader === `Bearer ${process.env.CRON_SECRET}`
  ) {
    return true;
  }

  // Check if it's an admin user
  const isAdmin = await isUserAdmin();
  if (isAdmin) {
    console.log("[Cron] Admin user authorized to run cron job");
    return true;
  }

  return false;
}
