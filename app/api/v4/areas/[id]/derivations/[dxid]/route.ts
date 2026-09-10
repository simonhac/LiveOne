import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { loadAreaForOwner } from "@/lib/areas/http";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  derivations,
  derivationSources,
  points,
} from "@/lib/db/planetscale/schema";
import { derivationWire } from "@/lib/derivations/v4-shapes";
import { writeDerivationSources } from "@/lib/derivations/sources";
import { RUN_DETECTOR_KIND } from "@/lib/derivations/resolve";
import { Derivation } from "@/lib/ids";

/**
 * One of an Area's derivations.
 *   PATCH { enabled?, name?, params? } → 200 { derivation }
 *
 * ## What is NOT patchable, and why
 *
 * 🛑 `kind` and `role` are the derivation's IDENTITY: `deriveDerivationId` is a uuidv5 over the
 * source point plus exactly those two (the AREA was the anchor until migration 0063), so "changing"
 * one does not edit this derivation — it names a different one, while leaving this row's id (and
 * therefore every `derived_intervals` row hanging off it) attached to the old meaning. That is a
 * silent corruption, so the fields are simply absent from the patch surface; create the other
 * derivation instead. `area` stays unpatchable for a different reason now: it is a vestige, so
 * moving it would edit nothing but the row's own listing address.
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

  // Set (to a uuid or to null) only when the body asked to move the boundary — `undefined` means
  // "not in this patch", which is why it cannot just be read off `patch.sourcePoints`.
  let boundaryPointUid: string | null | undefined;
  const patch: {
    enabled?: boolean;
    name?: string;
    params?: unknown;
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
      .select({ kind: derivations.kind })
      .from(derivations)
      .where(eq(derivations.id, uuid))
      .limit(1);
    if (!current)
      return NextResponse.json(
        { error: `Unknown derivation: ${dxid}` },
        { status: 404 },
      );
    // 🛑 Refuse before ANYTHING is written. `boundary` is a run-detector slot; an `hws-model` has
    // only `power`, so accepting this on one would delete its sole source row and write nothing back
    // — the model would vanish from `listEnabledHwsModels` with a 200 and no warning.
    if (current.kind !== RUN_DETECTOR_KIND)
      return NextResponse.json(
        {
          error: `boundaryPointUid applies only to ${RUN_DETECTOR_KIND} derivations (this one is '${current.kind}')`,
        },
        { status: 422 },
      );
    boundaryPointUid = uid;
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
  // `boundaryPointUid` no longer contributes to `patch` (it is applied from `derivation_sources`
  // inside the transaction below), so it has to be counted separately or a boundary-only patch would
  // be refused as empty.
  if (Object.keys(patch).length === 0 && boundaryPointUid === undefined)
    return NextResponse.json(
      {
        error: "Nothing to patch (enabled | name | params | boundaryPointUid)",
      },
      { status: 422 },
    );
  patch.updatedAt = new Date();

  // The area is in the WHERE, not merely checked: it is what makes the ownership check above cover
  // this row. Without it a caller who owns any area could patch any derivation by id.
  //
  // 🛑 ONE TRANSACTION, because a boundary patch is a dual-write: the jsonb column the wire still
  // shows and the `derivation_sources` rows the resolver actually acts on. Split across two commits,
  // a failure between them leaves detection cutting runs at a boundary the API denies having — or,
  // worse, leaves the delete committed and the insert not.
  const row = await requirePlanetscaleDb().transaction(async (tx) => {
    // Read the CURRENT slots from `derivation_sources`, not from the jsonb. Both are written, but
    // only the table is enforced, so it is the one to build the next state from — reconstructing
    // signal/energy out of the vestige would let a stale column overwrite correct wiring.
    const existing =
      boundaryPointUid === undefined
        ? []
        : await tx
            .select({
              slot: derivationSources.slot,
              pointId: derivationSources.pointId,
            })
            .from(derivationSources)
            .where(eq(derivationSources.derivationId, uuid));

    const [updated] = await tx
      .update(derivations)
      .set(patch)
      .where(
        and(eq(derivations.id, uuid), eq(derivations.areaId, authed.area.id)),
      )
      .returning();
    if (!updated) return null;

    if (boundaryPointUid !== undefined) {
      const slots = new Map(existing.map((e) => [e.slot, e.pointId]));
      const next: Record<string, string | null> = {
        signal: slots.get("signal") ?? null,
        energy: slots.get("energy") ?? null,
        boundary: boundaryPointUid,
      };
      await writeDerivationSources(tx, {
        derivationId: updated.id,
        kind: updated.kind,
        role: updated.role,
        slots: next,
      });
      // The jsonb vestige, derived from the same source of truth so the two cannot disagree.
      const [rewritten] = await tx
        .update(derivations)
        .set({ sourcePoints: next })
        .where(eq(derivations.id, updated.id))
        .returning();
      return rewritten ?? updated;
    }
    return updated;
  });
  if (!row)
    return NextResponse.json(
      { error: "Derivation not found on this area" },
      { status: 404 },
    );
  return NextResponse.json({ derivation: derivationWire(row) });
}
