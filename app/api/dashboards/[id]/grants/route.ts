import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAuth } from "@/lib/api-auth";
import { isUserAdmin } from "@/lib/auth-utils";
import { getDashboard } from "@/lib/dashboard/dashboards";
import {
  createGrant,
  listGrantsForDashboard,
  revokeGrant,
  type DashboardGrantRole,
} from "@/lib/dashboard/grants";
import { getUserIdByEmail, getUserIdByUsername } from "@/lib/user-cache";

/**
 * Per-dashboard membership — "invite a specific person" (P4). Owner or admin only. A grantee reaches
 * the dashboard read-only at `/dashboard/id/{id}` (no token), scoped to exactly what it shows.
 *
 *   GET    /api/dashboards/[id]/grants                 → members [{ clerkUserId, role, email, name }]
 *   POST   /api/dashboards/[id]/grants                 → add ({ email | username, role? }) → { ok }
 *   DELETE /api/dashboards/[id]/grants?clerkUserId=…   → remove → { ok }
 *
 * Invites are role "viewer" (read-only) for now; "admin" (editable) is a later phase.
 */
async function ownDashboard(
  request: NextRequest,
  idStr: string,
): Promise<{ id: number; ownerClerkUserId: string } | { error: NextResponse }> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };
  const id = parseInt(idStr, 10);
  if (isNaN(id))
    return {
      error: NextResponse.json({ error: "Invalid id" }, { status: 400 }),
    };
  const dashboard = await getDashboard(id);
  if (!dashboard)
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  const canEdit =
    dashboard.ownerClerkUserId === auth.userId || (await isUserAdmin());
  if (!canEdit)
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  return { id, ownerClerkUserId: dashboard.ownerClerkUserId };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await ownDashboard(request, id);
  if ("error" in r) return r.error;

  const grants = await listGrantsForDashboard(r.id);
  if (grants.length === 0) return NextResponse.json({ members: [] });

  // Decorate each grant with the member's email/name for the manage-members UI.
  const clerk = await clerkClient();
  const members = await Promise.all(
    grants.map(async (g) => {
      let email: string | null = null;
      let name: string | null = null;
      try {
        const user = await clerk.users.getUser(g.clerkUserId);
        email = user.emailAddresses[0]?.emailAddress ?? null;
        name =
          user.username ??
          [user.firstName, user.lastName].filter(Boolean).join(" ") ??
          null;
      } catch {
        // Deleted Clerk user — surface the raw id rather than dropping the row.
      }
      return {
        clerkUserId: g.clerkUserId,
        role: g.role,
        email,
        name,
        createdAtMs: g.createdAtMs,
      };
    }),
  );
  return NextResponse.json({ members });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await ownDashboard(request, id);
  if ("error" in r) return r.error;

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const username =
    typeof body?.username === "string" ? body.username.trim() : "";
  const role: DashboardGrantRole = body?.role === "admin" ? "admin" : "viewer";

  if (!email && !username) {
    return NextResponse.json(
      { error: "email or username is required" },
      { status: 400 },
    );
  }

  const granteeId = email
    ? await getUserIdByEmail(email)
    : await getUserIdByUsername(username);
  if (!granteeId) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  if (granteeId === r.ownerClerkUserId) {
    return NextResponse.json(
      { error: "owner already has full access" },
      { status: 400 },
    );
  }

  await createGrant({ dashboardId: r.id, clerkUserId: granteeId, role });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await ownDashboard(request, id);
  if ("error" in r) return r.error;

  const clerkUserId = new URL(request.url).searchParams.get("clerkUserId");
  if (!clerkUserId)
    return NextResponse.json(
      { error: "clerkUserId is required" },
      { status: 400 },
    );
  const ok = await revokeGrant(r.id, clerkUserId);
  return NextResponse.json({ ok });
}
