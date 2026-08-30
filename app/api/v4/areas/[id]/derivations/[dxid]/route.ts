import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { loadAreaForOwner } from "@/lib/areas/http";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { derivations, points } from "@/lib/db/planetscale/schema";
import { derivationWire } from "@/lib/derivations/v4-shapes";
import { Derivation } from "@/lib/ids";

/**
 * One of an Area's derivations.
 *   PATCH { enabled?, name?, params? } → 200 { derivation }
 *
 * ## What is NOT patchable, and why
 *
 * 🛑 `area`, `kind` and `role` are the derivation's IDENTITY: `deriveDerivationId(area, kind, role)`
 * is a uuidv5 over exactly those three, so "changing" one does not edit this derivation — it names a
 * different one, while leaving this row's id (and therefore every `derived_intervals` row hanging
 * off it) attached to the old meaning. That is a silent corruption, so the fields are simply absent
 * from the patch surface; create the other derivation instead.
 *
 * `sourcePoints` is excluded for a softer but real reason: re-pointing a detector's signal changes
 * what its ALREADY-STORED intervals mean, and the stored rows carry the old signal's unit
 * (migration 0055's `signal_unit`) with no way to know they predate the change. Daylesford's
 * generator has been through exactly this — Grid-power proxy → DeepSea engine speed — and the
 * correct handling was a deliberate, scoped recompute, not a config edit that quietly leaves a
 * mixed-provenance table behind. When that becomes routine it needs its own endpoint that also
 * schedules the rebuild; until then it stays a considered manual operation.
 *
 * The ONE exception carved out of that is `boundaryPointUid`, which sets `sourcePoints.boundary` —
 * the control point whose edges cut runs apart (see `DetectConfig.boundaryEventsMs`). It is safe in
 * exactly the way re-pointing `signal` is not: it does not change what the stored numbers MEASURE
 * (no unit, no signal, no provenance moves), it only changes where two adjacent runs are divided.
 * A recompute rewrites the affected rows into the same units they already had. Sending `null`
 * clears it.
 *
 * `enabled` IS patchable and is the safe lever: a disabled derivation stops being recomputed and
 * stops advertising its capability, while its intervals stay exactly as they were.
 *
 * Owner or admin. 400 bad id · 403 not yours · 404 unknown area or derivation · 422 bad body.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dxid: string }> },
) {
  const { id, dxid } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;

  const uuid = Derivation.toUuidOrNull(dxid);
  if (!uuid)
    return NextResponse.json(
      { error: `Invalid derivation id: ${dxid}` },
      { status: 400 },
    );

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body)
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });

  const patch: {
    enabled?: boolean;
    name?: string;
    params?: unknown;
    sourcePoints?: unknown;
    updatedAt?: Date;
  } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean")
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 422 },
      );
    patch.enabled = body.enabled;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "")
      return NextResponse.json(
        { error: "name must be a non-empty string" },
        { status: 422 },
      );
    patch.name = body.name;
  }
  if (body.params !== undefined) {
    // Whole-object replace, not a merge: `params` is SPARSE by contract (absent ⇒ inherit the role
    // default), so a merge would make removing an override impossible — the only way to say "go back
    // to the default" is to send the object without that key.
    if (
      typeof body.params !== "object" ||
      body.params === null ||
      Array.isArray(body.params)
    )
      return NextResponse.json(
        { error: "params must be an object" },
        { status: 422 },
      );
    patch.params = body.params;
  }
  if (body.boundaryPointUid !== undefined) {
    // Narrow by construction: this reads the CURRENT sourcePoints and replaces one key, so it can
    // never re-point `signal` or `energy` no matter what the caller sends.
    const uid = body.boundaryPointUid;
    if (uid !== null && (typeof uid !== "string" || uid.trim() === ""))
      return NextResponse.json(
        { error: "boundaryPointUid must be a point uuid or null" },
        { status: 422 },
      );
    if (uid !== null) {
      const [pt] = await requirePlanetscaleDb()
        .select({ id: points.id })
        .from(points)
        .where(eq(points.id, uid))
        .limit(1);
      if (!pt)
        return NextResponse.json(
          { error: `Unknown boundary point: ${uid}` },
          { status: 422 },
        );
    }
    const [current] = await requirePlanetscaleDb()
      .select({ sourcePoints: derivations.sourcePoints })
      .from(derivations)
      .where(eq(derivations.id, uuid))
      .limit(1);
    if (!current)
      return NextResponse.json(
        { error: `Unknown derivation: ${dxid}` },
        { status: 404 },
      );
    patch.sourcePoints = {
      ...((current.sourcePoints as Record<string, unknown>) ?? {}),
      boundary: uid,
    };
  }
  for (const forbidden of [
    "kind",
    "role",
    "areaId",
    "sourcePoints",
    "output",
  ]) {
    if (body[forbidden] !== undefined)
      return NextResponse.json(
        {
          error: `${forbidden} is not patchable — see the note in this route on identity and re-pointing`,
        },
        { status: 422 },
      );
  }
  if (Object.keys(patch).length === 0)
    return NextResponse.json(
      {
        error: "Nothing to patch (enabled | name | params | boundaryPointUid)",
      },
      { status: 422 },
    );
  patch.updatedAt = new Date();

  // The area is in the WHERE, not merely checked: it is what makes the ownership check above cover
  // this row. Without it a caller who owns any area could patch any derivation by id.
  const [row] = await requirePlanetscaleDb()
    .update(derivations)
    .set(patch)
    .where(
      and(eq(derivations.id, uuid), eq(derivations.areaId, authed.area.id)),
    )
    .returning();
  if (!row)
    return NextResponse.json(
      { error: "Derivation not found on this area" },
      { status: 404 },
    );
  return NextResponse.json({ derivation: derivationWire(row) });
}
