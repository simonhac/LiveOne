import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import {
  replaceBindings,
  refreshAreaServing,
  type BindingInput,
  AreaValidationError,
} from "@/lib/areas/create";
import { loadAreaBindings } from "@/lib/areas/v4-load";
import { areaBindingsWire } from "@/lib/areas/v4-shapes";
import { Point } from "@/lib/ids";

/**
 * An Area's typed role→point bindings, as ONE declarative collection (§9.2).
 *   PUT { bindings: [{ role, metricType, pointId: pt_…, priority?, transform? }] }
 *     → 200 { bindings: [{ id: bn_…, role, metricType, pointId: pt_…, priority, transform }] }
 *
 * Full replace, ordinal = array index — the shape the legacy `PUT /api/areas/{areaId}/bindings` already
 * had (§9.2 keeps it: "already the most tool-friendly shape"). Two things change, both widenings:
 * `priority` is accepted on the way in and stated on the way out (it is the (role, metric) slot's
 * selection order and it survives cutover, where `ordinal` does not), and each binding's own `bn_`
 * identity comes back, so a client can address one without positional arithmetic. The response is the
 * same `bindings` list `GET /api/v4/areas/{id}` carries, from the same loader.
 *
 * Server-side invariants (`replaceBindings`, unchanged): the role must be known, each point's owning
 * device must be a CURRENT MEMBER of the area, the point's metric must match the slot, and no
 * (role, metricType, pointId) or (role, metricType, priority) may repeat. The owning device is read from
 * `points ⋈ devices` and never from the wire, so a caller cannot claim a point belongs to a device it
 * does not.
 *
 * Owner or admin. 403 not yours · 404 unknown area · 422 bad body / failed invariant.
 */

/**
 * Coerce one untyped entry. `pointId` is a `pt_` TypeID: `Point.parse` rejects a wrong prefix, bad
 * base32 or a non-uuid payload, so a malformed id is a 422 here rather than a "not found" surfacing
 * from `replaceBindings` — a different status for what is really a body error.
 */
function toBinding(x: unknown): BindingInput | null {
  const b = x as Record<string, unknown>;
  if (typeof b?.role !== "string" || typeof b?.metricType !== "string")
    return null;
  if (typeof b?.pointId !== "string") return null;
  const parsed = Point.parse(b.pointId);
  if (!parsed.ok) return null;
  if (
    b.priority !== undefined &&
    (typeof b.priority !== "number" ||
      !Number.isInteger(b.priority) ||
      b.priority < 0)
  )
    return null;
  return {
    role: b.role,
    metricType: b.metricType,
    pointId: parsed.id,
    ...(typeof b.priority === "number" ? { priority: b.priority } : {}),
    transform: typeof b.transform === "string" ? b.transform : null,
  };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  const uuid = authed.area.id;

  const body = await request.json().catch(() => null);
  // An EMPTY array is legal and meaningful — it is how an area returns to union-default resolution
  // (every member's own points). Only a non-array is a body error.
  const raw = Array.isArray(body?.bindings) ? body.bindings : null;
  if (!raw)
    return NextResponse.json(
      { error: "bindings must be an array" },
      { status: 422 },
    );
  const bindings: BindingInput[] = [];
  for (const entry of raw) {
    const parsed = toBinding(entry);
    if (!parsed)
      return NextResponse.json(
        {
          error:
            "Each binding needs role, metricType, a pt_ pointId, and an optional non-negative integer priority",
        },
        { status: 422 },
      );
    bindings.push(parsed);
  }

  try {
    await replaceBindings(uuid, bindings);
  } catch (err) {
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
  // 🛑 The KV subscription registry is derived from `area_bindings` — skipping this would leave the
  // area's latest values fanning out to the points it was bound to BEFORE this call.
  await refreshAreaServing(uuid);
  return NextResponse.json({
    bindings: areaBindingsWire(await loadAreaBindings(uuid)),
  });
}
