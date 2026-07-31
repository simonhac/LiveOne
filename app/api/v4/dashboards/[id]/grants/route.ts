import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { loadOwnedDashboard } from "@/lib/dashboard/v4-routes";
import {
  listGrantsForDashboard,
  replaceDashboardGrants,
  type DashboardGrantInput,
  type DashboardGrantRole,
} from "@/lib/dashboard/grants";
import { getUserIdByEmail, getUserIdByUsername } from "@/lib/user-cache";

/**
 * config-v4 per-dashboard membership (§9.2 `/dashboards/{id}/grants`). Owner/admin only.
 *
 *   GET → 200 { members: [{ clerkUserId, role, email, name, createdAtMs }] }
 *   PUT { members: [{ clerkUserId | email | username, role? }] }
 *       → 200 { members: […the new state], changed: { added, updated, unchanged, removed } }
 *       · 422 { errors: [{ index?, code, … }] } — NOTHING applied
 *   any → 404 unknown dashboard · 403 not yours
 *
 * 🛑 **PUT is a full replace, not an add.** Clean-sheet §9.2: "PUT = declarative full-replace for
 * collections (server diffs, applies transactionally, returns the new state)". It supersedes the legacy
 * POST-one / DELETE-one pair, so `PUT {members: []}` removes EVERY member — that is the contract, and a
 * client that means "add one" must send the whole list. `changed` is returned so an under- or
 * over-applied replace is visible rather than silent; the diff itself is `replaceDashboardGrants`.
 *
 * 🛑 These are owner-side mutations. They stay Clerk-gated — nothing here goes in `shareableRoutes`
 * (`lib/route-matchers.ts`), where a share token could reach it. A grant, like a token, is read-scoped
 * live to the doc's §8.3 envelope refs (`lib/dashboard/access.ts`), never to general device access.
 *
 * Validation is ALL-OR-NOTHING and runs before the transaction: one unresolvable invitee fails the whole
 * PUT. A partially-applied membership replace is worse than a rejected one — the caller believes it
 * declared a state it did not.
 */

interface DecoratedMember {
  clerkUserId: string;
  role: string;
  email: string | null;
  name: string | null;
  createdAtMs: number;
}

/**
 * The grants of a dashboard, decorated with each member's Clerk email/name.
 *
 * Carried verbatim from the legacy twin, INCLUDING the failure behaviour: a Clerk lookup that throws
 * (a deleted user) leaves email/name null and keeps the row, so a tombstoned grantee is still visible
 * and therefore still removable. Dropping the row would make it un-revokable from the UI.
 */
async function listDecoratedMembers(
  dashboardId: string,
): Promise<DecoratedMember[]> {
  const grants = await listGrantsForDashboard(dashboardId);
  if (grants.length === 0) return [];
  const clerk = await clerkClient();
  return Promise.all(
    grants.map(async (g) => {
      let email: string | null = null;
      let name: string | null = null;
      try {
        const user = await clerk.users.getUser(g.userId);
        email = user.emailAddresses[0]?.emailAddress ?? null;
        name =
          user.username ??
          [user.firstName, user.lastName].filter(Boolean).join(" ") ??
          null;
      } catch {
        // Deleted Clerk user — surface the raw id rather than dropping the row.
      }
      return {
        clerkUserId: g.userId,
        role: g.role,
        email,
        name,
        createdAtMs: g.createdAt.getTime(),
      };
    }),
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;
  return NextResponse.json({
    members: await listDecoratedMembers(r.dashboard.id),
  });
}

interface MemberError {
  index?: number;
  code: string;
  detail?: string;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;

  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.members)) {
    return NextResponse.json(
      {
        errors: [
          {
            code: "members-required",
            detail:
              "PUT is a full replace: send the COMPLETE member list (`[]` removes everyone)",
          },
        ],
      },
      { status: 422 },
    );
  }

  const errors: MemberError[] = [];
  const resolved: DashboardGrantInput[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < body.members.length; index++) {
    const raw = body.members[index];
    if (typeof raw !== "object" || raw === null) {
      errors.push({ code: "member-must-be-an-object", index });
      continue;
    }
    const role: DashboardGrantRole = raw.role === "admin" ? "admin" : "viewer";
    if (
      raw.role !== undefined &&
      raw.role !== "admin" &&
      raw.role !== "viewer"
    ) {
      errors.push({ code: "unknown-role", index, detail: String(raw.role) });
      continue;
    }
    const clerkUserId =
      typeof raw.clerkUserId === "string" ? raw.clerkUserId.trim() : "";
    const email = typeof raw.email === "string" ? raw.email.trim() : "";
    const username =
      typeof raw.username === "string" ? raw.username.trim() : "";
    const given = [clerkUserId, email, username].filter(Boolean);
    if (given.length !== 1) {
      errors.push({
        code: "member-needs-exactly-one-identifier",
        index,
        detail: "one of clerkUserId | email | username",
      });
      continue;
    }

    // A raw `clerkUserId` is taken as-is (shape-checked only) so a read-modify-write round trip of
    // `GET → PUT` works even for a member whose Clerk user has since been deleted — exactly the row the
    // GET deliberately keeps. Granting to a non-existent id grants nothing: nobody can authenticate as it.
    let granteeId: string | null = clerkUserId || null;
    if (granteeId && !granteeId.startsWith("user_")) {
      errors.push({ code: "malformed-clerk-user-id", index });
      continue;
    }
    if (!granteeId) {
      granteeId = email
        ? await getUserIdByEmail(email)
        : await getUserIdByUsername(username);
    }
    if (!granteeId) {
      errors.push({
        code: "user-not-found",
        index,
        detail: email || username,
      });
      continue;
    }
    if (granteeId === r.dashboard.ownerClerkUserId) {
      // Not merely redundant: storing it would make the owner removable from their own dashboard by a
      // later replace, and the owner's access does not come from this table.
      errors.push({ code: "owner-already-has-full-access", index });
      continue;
    }
    if (seen.has(granteeId)) {
      errors.push({ code: "duplicate-member", index, detail: granteeId });
      continue;
    }
    seen.add(granteeId);
    resolved.push({ clerkUserId: granteeId, role });
  }

  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 422 });
  }

  const changed = await replaceDashboardGrants(r.dashboard.id, resolved);
  return NextResponse.json({
    members: await listDecoratedMembers(r.dashboard.id),
    changed,
  });
}
