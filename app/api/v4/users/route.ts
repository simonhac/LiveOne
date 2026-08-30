import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { listUserDirectory } from "@/lib/users/directory";

/**
 * `GET /api/v4/users` — the user directory for the operator CLI: the same entries the admin users
 * table renders (lib/users/directory.ts — Clerk profile + owned devices), without the admin route's
 * `{ success, totalUsers, timestamp }` envelope, matching the bare-collection house style of the
 * other v4 lists.
 *
 * ADMIN-ONLY, and that is the whole authorization story: this route is under the CLI-token edge
 * bypass (lib/route-matchers.ts), so `requireAdmin` here is the single enforcement point — a
 * non-admin CLI token gets past the edge and 403s right here.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ users: await listUserDirectory() });
}
