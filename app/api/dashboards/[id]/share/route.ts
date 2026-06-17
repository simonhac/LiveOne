import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { isUserAdmin } from "@/lib/auth-utils";
import { getDashboard } from "@/lib/dashboard/dashboards";
import {
  createDashboardShareToken,
  listDashboardShareTokens,
  revokeDashboardShareToken,
  renameDashboardShareToken,
} from "@/lib/dashboard/sharing";

/**
 * Read-only share links for a composition dashboard (P4). Owner or admin only. A holder reaches the
 * dashboard at `?access=<token>`, scoped to exactly what it shows (lib/dashboard/access.ts).
 *
 *   GET    /api/dashboards/[id]/share              → this dashboard's tokens
 *   POST   /api/dashboards/[id]/share              → mint one ({ label?, expiresInDays? }) → { token }
 *   DELETE /api/dashboards/[id]/share?token=phrase → revoke
 *   PATCH  /api/dashboards/[id]/share              → rename ({ token, label })
 */
async function ownDashboard(
  request: NextRequest,
  idStr: string,
): Promise<{ id: number } | { error: NextResponse }> {
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
  return { id };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await ownDashboard(request, id);
  if ("error" in r) return r.error;
  const tokens = await listDashboardShareTokens(r.id);
  return NextResponse.json({ tokens });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await ownDashboard(request, id);
  if ("error" in r) return r.error;
  const body = await request.json().catch(() => null);
  const label =
    typeof body?.label === "string" && body.label.trim()
      ? body.label.trim()
      : "Shared link";
  const expiresInDays =
    typeof body?.expiresInDays === "number" && body.expiresInDays > 0
      ? body.expiresInDays
      : null;
  const { token, expiresAtMs } = await createDashboardShareToken({
    dashboardId: r.id,
    label,
    expiresInDays,
  });
  return NextResponse.json({ token, expiresAtMs });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await ownDashboard(request, id);
  if ("error" in r) return r.error;
  const token = new URL(request.url).searchParams.get("token");
  if (!token)
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  const ok = await revokeDashboardShareToken(token, r.id);
  return NextResponse.json({ ok });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await ownDashboard(request, id);
  if ("error" in r) return r.error;
  const body = await request.json().catch(() => null);
  if (typeof body?.token !== "string" || typeof body?.label !== "string") {
    return NextResponse.json(
      { error: "token and label are required" },
      { status: 400 },
    );
  }
  const ok = await renameDashboardShareToken(
    body.token,
    r.id,
    body.label.trim(),
  );
  return NextResponse.json({ ok });
}
