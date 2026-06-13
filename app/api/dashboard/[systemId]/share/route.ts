import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import {
  getOrCreateDefaultDashboardId,
  getDashboardIdForUserSystem,
} from "@/lib/dashboard/store";
import {
  DASHBOARD_SHARING,
  createDashboardShareToken,
  listDashboardShareTokens,
  revokeDashboardShareToken,
} from "@/lib/dashboard/sharing";

/**
 * Owner management of per-dashboard share tokens (P4). Minting/listing/revoking a read-only public
 * link for the caller's dashboard of `systemId`. Owner/admin only (write access). Gated by
 * DASHBOARD_SHARING — 404 when off. Consumption is the separate public `GET /api/dashboard-share/[token]`.
 */

async function authorizeOwner(request: NextRequest, systemIdStr: string) {
  if (!DASHBOARD_SHARING) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  const systemId = parseInt(systemIdStr, 10);
  if (isNaN(systemId)) {
    return {
      error: NextResponse.json({ error: "Invalid system id" }, { status: 400 }),
    };
  }
  // Minting/managing a public link is an owner action → require write access.
  const auth = await requireSystemAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return { error: auth };
  return {
    systemId,
    userId: auth.userId,
    vendorType: auth.system.vendorType,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const a = await authorizeOwner(request, s);
  if ("error" in a) return a.error;

  const body = await request.json().catch(() => ({}));
  const dashboardId = await getOrCreateDefaultDashboardId(
    a.userId,
    a.systemId,
    a.vendorType,
  );
  const { token, expiresAtMs } = await createDashboardShareToken({
    dashboardId,
    label: body?.label ?? null,
    expiresInDays: body?.expiresInDays ?? null,
  });
  return NextResponse.json({ token, expiresAtMs });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const a = await authorizeOwner(request, s);
  if ("error" in a) return a.error;

  const dashboardId = await getDashboardIdForUserSystem(a.userId, a.systemId);
  const tokens = dashboardId ? await listDashboardShareTokens(dashboardId) : [];
  return NextResponse.json({ tokens });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const a = await authorizeOwner(request, s);
  if ("error" in a) return a.error;

  const body = await request.json().catch(() => null);
  const token = body?.token;
  if (typeof token !== "string") {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }
  const dashboardId = await getDashboardIdForUserSystem(a.userId, a.systemId);
  const revoked = dashboardId
    ? await revokeDashboardShareToken(token, dashboardId)
    : false;
  return NextResponse.json({ revoked });
}
