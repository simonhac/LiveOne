import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { findUsersInClerk, listUserDirectory } from "@/lib/users/directory";

/**
 * `GET /api/v4/users` — the user directory for the operator CLI: the same entries the admin users
 * table renders (lib/users/directory.ts — Clerk profile + owned devices), without the admin route's
 * `{ success, totalUsers, timestamp }` envelope, matching the bare-collection house style of the
 * other v4 lists.
 *
 * `?q=` switches to a CLERK SEARCH instead of the ownership enumeration. 🛑 The default list is
 * derived from device ownership, so a user who owns nothing does not appear in it — which is
 * precisely the person a transfer is about to hand something to. Without this leg their `user_…` id
 * has to be copied out of the Clerk dashboard by hand, and the CLI cannot name them at all.
 *
 * ADMIN-ONLY, and that is the whole authorization story: this route is under the CLI-token edge
 * bypass (lib/route-matchers.ts), so `requireAdmin` here is the single enforcement point — a
 * non-admin CLI token gets past the edge and 403s right here. That matters more for `?q=`: it is a
 * directory search over every user in the Clerk instance, not just the fleet's owners.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const q = request.nextUrl.searchParams.get("q");
  if (q !== null)
    return NextResponse.json({ users: await findUsersInClerk(q), query: q });

  return NextResponse.json({ users: await listUserDirectory() });
}
