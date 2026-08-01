import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadAreaForOwner } from "@/lib/areas/http";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { derivations } from "@/lib/db/planetscale/schema";
import {
  ensureRunDetector,
  HWS_MODEL_KIND,
  RUN_DETECTOR_KIND,
  type RunDetectorParams,
} from "@/lib/derivations/resolve";
import { derivationWire, pointUuidFromWire } from "@/lib/derivations/v4-shapes";
import {
  ensureHwsDerivation,
  ensureHwsTemperaturePoint,
} from "@/lib/hws/register";
import { TRACKABLE_ROLE_IDS, type RoleId } from "@/lib/roles/registry";

/**
 * An Area's derivations — config that computes a new signal from existing points (clean-sheet §4.4).
 *   GET  → 200 { derivations: [{ id: dx_…, kind, role, name, enabled, output, outputPointId, params, sourcePoints }] }
 *   POST { kind, … } → 201 { derivation, status }
 *
 * This is the generic resource, not a run-detector one. `derivations` has always been a generic
 * table — `kind` plus two kind-specific jsonb columns, with `deriveDerivationId(area, kind, role)`
 * minting deterministically for any kind — but until now neither of its two kinds (`run-detector`,
 * `hws-model`) was reachable except from a seed script, which is why a detector could exist on dev
 * and not on prod with nothing to notice the difference.
 *
 * Sibling of `bindings`/`members`, and owner-or-admin like them. 400 bad area id · 403 not yours ·
 * 404 unknown area · 422 bad body or a refused create.
 *
 * ## Deliberately NOT a declarative full-replace collection
 *
 * 🛑 `bindings` is a `PUT` that replaces the whole list, and copying that here would be dangerous:
 * `derived_intervals.derivation_id` is `ON DELETE CASCADE` (migration 0040), so a replace that
 * merely *omitted* a derivation would silently destroy every interval it had ever produced — a
 * year of run periods, with a 200 and no warning. Bindings are cheap to rebuild; a derivation's
 * output is not. So: create is `POST`, edit is `PATCH` on the member, and there is no `DELETE` at
 * all yet — deleting one needs an explicit-confirmation design nothing here requires.
 *
 * ## Per-kind dispatch
 *
 * The route is a thin dispatcher over the existing writers rather than one uniform insert, because
 * the two kinds genuinely differ: a run detector is declared entirely by the body, whereas an HWS
 * model MINTS its own output point first (`ensureHwsTemperaturePoint`) and then discovers both
 * source and output from the device's `load.hws` stem. Flattening that into one shape would mean
 * inventing a body for `hws-model` whose fields the writer then ignores.
 */

/** Map a writer's refusal status onto an HTTP response. */
function refusal(status: string, detail?: string): NextResponse {
  return NextResponse.json(
    { error: `Refused: ${status}`, status, ...(detail ? { detail } : {}) },
    { status: 422 },
  );
}

/**
 * Coerce the sparse `params` of a run detector.
 *
 * Sparse is the contract, not laziness: an absent key inherits `detectorDefaultsForRole` as those
 * defaults evolve, so writing a key you did not mean to pin is worse than omitting it. Only keys
 * actually present in the body are carried through.
 */
function toRunDetectorParams(raw: unknown): RunDetectorParams | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (p.signalKind !== undefined && p.signalKind !== "power-threshold")
    return null;
  const out: RunDetectorParams = { signalKind: "power-threshold" };
  const nums = [
    "lowerW",
    "upperW",
    "hysteresisW",
    "delayOnSeconds",
    "delayOffSeconds",
  ] as const;
  for (const key of nums) {
    const v = p[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[key] = v;
  }
  return out;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;

  const rows = await requirePlanetscaleDb()
    .select()
    .from(derivations)
    .where(eq(derivations.areaId, authed.area.id));
  return NextResponse.json({ derivations: rows.map(derivationWire) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  const areaId = authed.area.id;

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const kind = typeof body?.kind === "string" ? body.kind : null;
  if (!kind)
    return NextResponse.json(
      {
        error: `kind is required (one of: ${RUN_DETECTOR_KIND}, ${HWS_MODEL_KIND})`,
      },
      { status: 422 },
    );

  if (kind === RUN_DETECTOR_KIND) {
    const role = typeof body?.role === "string" ? body.role : null;
    if (!role || !(TRACKABLE_ROLE_IDS as readonly string[]).includes(role))
      return NextResponse.json(
        {
          error: `role must be one of: ${TRACKABLE_ROLE_IDS.join(", ")}`,
        },
        { status: 422 },
      );
    const name = typeof body?.name === "string" ? body.name : `${role} runs`;

    const src = (body?.sourcePoints ?? {}) as Record<string, unknown>;
    const signalPointUid = pointUuidFromWire(src.signal);
    if (!signalPointUid)
      return NextResponse.json(
        { error: "sourcePoints.signal must be a pt_ point id" },
        { status: 422 },
      );
    // Absent is legal (a detector with no kWh); present-but-garbled is a body error, not a
    // silently-dropped energy binding.
    const energyGiven = src.energy !== undefined && src.energy !== null;
    const energyPointUid = energyGiven ? pointUuidFromWire(src.energy) : null;
    if (energyGiven && !energyPointUid)
      return NextResponse.json(
        { error: "sourcePoints.energy must be a pt_ point id or null" },
        { status: 422 },
      );

    const detectorParams = toRunDetectorParams(body?.params);
    if (!detectorParams)
      return NextResponse.json(
        {
          error:
            "params must be { signalKind?: 'power-threshold', lowerW?, upperW?, hysteresisW?, delayOnSeconds?, delayOffSeconds? } with numeric values",
        },
        { status: 422 },
      );

    const result = await ensureRunDetector({
      areaId,
      role: role as RoleId,
      name,
      signalPointUid,
      energyPointUid,
      params: detectorParams,
      apply: true,
    });
    if (result.status === "area-not-probed")
      return refusal(
        result.status,
        // Name the members it COULD go on. Getting this wrong is the documented failure of the whole
        // feature (a detector on a composite is invisible to the capability probe that lights its
        // card up), and "wrong area" without "here are the right ones" leaves the caller guessing.
        `This area's own handle names no device, so \`capabilitiesForDevice\` never probes it — a ` +
          `run detector here would be invisible. Put it on the area-of-one of one of its members ` +
          `(handles: ${result.memberHandles?.join(", ") || "none"}), and pin the dashboard card ` +
          `to that device.`,
      );
    if (result.status !== "created" && result.status !== "exists")
      return refusal(result.status);

    return NextResponse.json(
      {
        status: result.status,
        derivation: await readOne(result.derivationId!),
      },
      { status: result.status === "created" ? 201 : 200 },
    );
  }

  if (kind === HWS_MODEL_KIND) {
    // The HWS model is declared by the DEVICE it models, not by explicit points: it mints its own
    // `load.hws/temperature` output point and finds its `load.hws/power` source. So the only input
    // is which device — and on an area-of-one that is the area's own handle.
    const handle = authed.area.legacySystemId;
    if (handle == null)
      return refusal(
        "no-handle",
        "This area has no legacy handle, so its device's load.hws points cannot be resolved.",
      );
    const point = await ensureHwsTemperaturePoint(handle, true);
    if (point.status === "no-power-point")
      return refusal(
        point.status,
        "The device has no load.hws/power point to model from.",
      );
    const result = await ensureHwsDerivation(handle, true);
    if (result.status !== "created" && result.status !== "exists")
      return refusal(result.status);
    return NextResponse.json(
      {
        status: result.status,
        derivation: await readOne(result.derivationId!),
      },
      { status: result.status === "created" ? 201 : 200 },
    );
  }

  return NextResponse.json(
    {
      error: `Unknown kind '${kind}' (one of: ${RUN_DETECTOR_KIND}, ${HWS_MODEL_KIND})`,
    },
    { status: 422 },
  );
}

/** Re-read the written row so the response is what the DB holds, not what the request asked for. */
async function readOne(derivationId: string) {
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(derivations)
    .where(eq(derivations.id, derivationId))
    .limit(1);
  return row ? derivationWire(row) : null;
}
