import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { users } from "@/lib/db/planetscale/schema";
import { userDirectoryEntry } from "@/lib/users/directory";
import { Dashboard } from "@/lib/ids";

/**
 * `GET /api/v4/users/{id}` — one directory entry by Clerk `user_…` id, plus `defaultDashboardId`
 * (the `users` table's landing preference, as a `db_…` TypeID — null when unset OR when the user has
 * no `users` row at all, which are the same thing to a caller). The list deliberately omits this
 * field: it would cost a `users` read per row for a preference only the single-user view acts on.
 *
 * ADMIN-ONLY — same reasoning as the list route: this sits under the CLI-token edge bypass, so
 * `requireAdmin` here is the single enforcement point. Unknown user → 404 (Clerk cannot resolve the
 * id and no device ownership vouches for it — see `userDirectoryEntry`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const entry = await userDirectoryEntry(id);
  if (!entry)
    return NextResponse.json({ error: "User not found" }, { status: 404 });

  const [prefs] = await requirePlanetscaleDb()
    .select({ defaultDashboardId: users.defaultDashboardId })
    .from(users)
    .where(eq(users.clerkUserId, id))
    .limit(1);

  return NextResponse.json({
    ...entry,
    defaultDashboardId: prefs?.defaultDashboardId
      ? Dashboard.encode(prefs.defaultDashboardId)
      : null,
  });
}
