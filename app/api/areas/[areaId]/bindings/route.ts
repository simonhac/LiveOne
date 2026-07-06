import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { loadAreaForAuth } from "@/lib/areas/http";
import {
  getAreaBindingsForEditor,
  replaceBindings,
  refreshAreaServing,
  type BindingInput,
  AreaValidationError,
} from "@/lib/areas/create";

/**
 * The typed role→point bindings of an Area (the area builder's Bindings tab).
 *   GET → the current ordered bindings.
 *   PUT → replace ALL bindings with the given ordered list (ordinal = position).
 * Owner/admin only; a binding's point must belong to a current member device (enforced server-side).
 */

async function requireAreaOwner(request: NextRequest, areaId: string) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const area = await loadAreaForAuth(areaId);
  if (!area)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });
  if (!(auth.isAdmin || area.ownerClerkUserId === auth.userId))
    return NextResponse.json(
      { error: "Write access required" },
      { status: 403 },
    );
  return { area };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await requireAreaOwner(request, areaId);
  if (authed instanceof NextResponse) return authed;
  return NextResponse.json({
    bindings: await getAreaBindingsForEditor(areaId),
  });
}

/** Coerce one untyped binding entry, or null if it's structurally invalid. */
function toBinding(x: unknown): BindingInput | null {
  const b = x as Record<string, unknown>;
  if (
    typeof b?.role !== "string" ||
    typeof b?.metricType !== "string" ||
    !Number.isInteger(b?.pointSystemId) ||
    !Number.isInteger(b?.pointId)
  )
    return null;
  return {
    role: b.role,
    metricType: b.metricType,
    pointSystemId: b.pointSystemId as number,
    pointId: b.pointId as number,
    transform: typeof b.transform === "string" ? b.transform : null,
  };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await requireAreaOwner(request, areaId);
  if (authed instanceof NextResponse) return authed;

  const body = await request.json().catch(() => null);
  const raw = Array.isArray(body?.bindings) ? body.bindings : null;
  if (!raw)
    return NextResponse.json(
      { error: "bindings must be an array" },
      { status: 400 },
    );
  const bindings: BindingInput[] = [];
  for (const entry of raw) {
    const parsed = toBinding(entry);
    if (!parsed)
      return NextResponse.json(
        {
          error: "Each binding needs role, metricType, pointSystemId, pointId",
        },
        { status: 400 },
      );
    bindings.push(parsed);
  }

  try {
    await replaceBindings(areaId, bindings);
  } catch (err) {
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  await refreshAreaServing(areaId);
  return NextResponse.json({
    bindings: await getAreaBindingsForEditor(areaId),
  });
}
