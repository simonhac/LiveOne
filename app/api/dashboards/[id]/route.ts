import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { isUserAdmin } from "@/lib/auth-utils";
import { listReadableAreas } from "@/lib/areas/list";
import {
  getDashboard,
  updateDashboard,
  deleteDashboard,
  DashboardAliasTakenError,
  type CompositionDashboard,
} from "@/lib/dashboard/dashboards";
import { descriptorAreaIds } from "@/lib/dashboard/composition";
import type { DashboardDescriptor } from "@/lib/dashboard/descriptor";

/**
 * A single composition dashboard (Phase 2b-2). GET (owner/admin), PATCH (owner — rename/alias/edit
 * cards), DELETE (owner). A descriptor edit runs the no-escalation authoring check: every card's
 * Area must be one the owner can read.
 */
async function loadOwned(
  request: NextRequest,
  idStr: string,
): Promise<
  { dashboard: CompositionDashboard; userId: string } | { error: NextResponse }
> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    return {
      error: NextResponse.json({ error: "Invalid id" }, { status: 400 }),
    };
  }
  const dashboard = await getDashboard(id);
  if (!dashboard) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  const owns = dashboard.ownerClerkUserId === auth.userId;
  if (!owns && !(await isUserAdmin())) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { dashboard, userId: auth.userId };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwned(request, id);
  if ("error" in r) return r.error;
  return NextResponse.json({ dashboard: r.dashboard });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwned(request, id);
  if ("error" in r) return r.error;

  const body = await request.json().catch(() => null);
  const patch: {
    displayName?: string;
    alias?: string | null;
    descriptor?: DashboardDescriptor;
  } = {};

  if (typeof body?.displayName === "string") {
    const dn = body.displayName.trim();
    if (!dn) {
      return NextResponse.json(
        { error: "displayName cannot be empty" },
        { status: 400 },
      );
    }
    patch.displayName = dn;
  }
  if (body?.alias !== undefined) {
    patch.alias =
      typeof body.alias === "string" && body.alias.trim()
        ? body.alias.trim()
        : null;
  }
  if (body?.descriptor !== undefined) {
    const descriptor = body.descriptor as DashboardDescriptor;
    if (
      !descriptor ||
      descriptor.version !== 2 ||
      !Array.isArray(descriptor.cards)
    ) {
      return NextResponse.json(
        { error: "A version-2 descriptor is required" },
        { status: 400 },
      );
    }
    // No-escalation authoring check: every card's Area must be readable by the owner.
    const areaIds = descriptorAreaIds(descriptor);
    if (areaIds.length > 0) {
      const readable = new Set(
        (await listReadableAreas(r.dashboard.ownerClerkUserId)).map(
          (a) => a.id,
        ),
      );
      if (areaIds.some((aid) => !readable.has(aid))) {
        return NextResponse.json(
          { error: "A card references an area you cannot read" },
          { status: 403 },
        );
      }
    }
    patch.descriptor = descriptor;
  }

  try {
    await updateDashboard(r.dashboard.id, patch);
  } catch (err) {
    if (err instanceof DashboardAliasTakenError) {
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    }
    throw err;
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwned(request, id);
  if ("error" in r) return r.error;
  await deleteDashboard(r.dashboard.id);
  return NextResponse.json({ success: true });
}
