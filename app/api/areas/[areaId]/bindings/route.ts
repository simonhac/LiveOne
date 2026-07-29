import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import {
  getAreaBindingsForEditor,
  replaceBindings,
  refreshAreaServing,
  type BindingInput,
  AreaValidationError,
} from "@/lib/areas/create";
import { Point } from "@/lib/ids";

/**
 * The typed role→point bindings of an Area (the area builder's Bindings tab), addressed by its opaque
 * `ar_` TypeID (decoded to the raw uuid at the seam, `loadAreaForOwner`).
 *   GET → the current ordered bindings.
 *   PUT → replace ALL bindings with the given ordered list (ordinal = position).
 * Owner/admin only; a binding's point must belong to a current member device (enforced server-side).
 */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await loadAreaForOwner(request, areaId);
  if ("error" in authed) return authed.error;
  return NextResponse.json({
    bindings: await getAreaBindingsForEditor(authed.area.id),
  });
}

/**
 * Coerce one untyped binding entry, or null if it's structurally invalid. `pointId` is a `pt_` TypeID
 * (slice E PR 2b): `Point.parse` rejects a wrong prefix / bad base32 / non-uuid payload, so a malformed
 * id is a 400 here rather than a "not found" from `replaceBindings`.
 */
function toBinding(x: unknown): BindingInput | null {
  const b = x as Record<string, unknown>;
  if (typeof b?.role !== "string" || typeof b?.metricType !== "string")
    return null;
  if (typeof b?.pointId !== "string") return null;
  const parsed = Point.parse(b.pointId);
  if (!parsed.ok) return null;
  return {
    role: b.role,
    metricType: b.metricType,
    pointId: parsed.id,
    transform: typeof b.transform === "string" ? b.transform : null,
  };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const authed = await loadAreaForOwner(request, areaId);
  if ("error" in authed) return authed.error;
  const uuid = authed.area.id;

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
          error: "Each binding needs role, metricType and a pt_ pointId",
        },
        { status: 400 },
      );
    bindings.push(parsed);
  }

  try {
    await replaceBindings(uuid, bindings);
  } catch (err) {
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  await refreshAreaServing(uuid);
  return NextResponse.json({
    bindings: await getAreaBindingsForEditor(uuid),
  });
}
