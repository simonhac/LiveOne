import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import {
  getSavedDescriptor,
  saveDescriptor,
  deleteDescriptor,
} from "@/lib/dashboard/store";
import { getAreaForSystem } from "@/lib/areas/resolve";
import { listReadableAreas } from "@/lib/areas/list";

/**
 * Per-user dashboard descriptor (P2). A descriptor is the user's personal customization of a system
 * they can view, so read access (canRead) is sufficient for all verbs — the row is keyed by the
 * caller's own userId.
 */

async function authorize(request: NextRequest, systemIdStr: string) {
  const systemId = parseInt(systemIdStr, 10);
  if (isNaN(systemId)) {
    return {
      error: NextResponse.json({ error: "Invalid system id" }, { status: 400 }),
    };
  }
  const auth = await requireSystemAccess(request, systemId);
  if (auth instanceof NextResponse) return { error: auth };
  return { systemId, userId: auth.userId };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const a = await authorize(request, s);
  if ("error" in a) return a.error;
  const descriptor = await getSavedDescriptor(a.userId, a.systemId);
  return NextResponse.json({ descriptor });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const a = await authorize(request, s);
  if ("error" in a) return a.error;

  const body = await request.json().catch(() => null);
  const descriptor = body?.descriptor;
  if (
    !descriptor ||
    descriptor.version !== 2 ||
    !Array.isArray(descriptor.cards) ||
    typeof descriptor.layout !== "string"
  ) {
    return NextResponse.json(
      { error: "A version-2 dashboard descriptor is required" },
      { status: 400 },
    );
  }

  // No-escalation authoring check (Phase 2b): every card that binds another Area (`areaId`) must
  // reference an Area the caller can already read. Stops an owner composing a card from — and thus
  // sharing read access to — an Area they don't have. Only runs when off-area cards are present.
  const cardAreaIds = [
    ...new Set(
      (descriptor.cards as Array<{ areaId?: unknown }>)
        .map((c) => c.areaId)
        .filter((x): x is string => typeof x === "string"),
    ),
  ];
  if (cardAreaIds.length > 0) {
    const readable = new Set(
      (await listReadableAreas(a.userId)).map((ar) => ar.id),
    );
    const forbidden = cardAreaIds.filter((id) => !readable.has(id));
    if (forbidden.length > 0) {
      return NextResponse.json(
        { error: "A card references an area you cannot read" },
        { status: 403 },
      );
    }
  }

  // Link the persisted dashboard to its Area (system's identity Area, or a composite Area).
  // Resolved server-side and 1:1 with the system today, so this changes no behaviour; null when
  // no Area has been backfilled for the system yet. See docs/architecture/areas-and-dashboards.md (P3).
  const area = await getAreaForSystem(a.systemId);
  await saveDescriptor(a.userId, a.systemId, descriptor, area?.id ?? null);
  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const a = await authorize(request, s);
  if ("error" in a) return a.error;
  await deleteDescriptor(a.userId, a.systemId);
  return NextResponse.json({ success: true });
}
