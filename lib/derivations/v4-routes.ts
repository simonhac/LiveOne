/**
 * The `/api/v4/derivations` handlers, as functions — the implementation both route trees share.
 *
 * Two trees serve this resource: the new identity-addressed one (`/api/v4/derivations/{dx_}`) and
 * the area-scoped one it replaces (`/api/v4/areas/{ar_}/derivations/{dx_}`), which is now a set of
 * thin shims so the CLI and any bookmarked URL keep working until PR 4 moves them. The logic lives
 * HERE rather than in either route module so that neither is the other's subordinate: a shim that
 * imported a route handler would inherit its `params` shape, and a route that imported a shim would
 * invert the dependency the plan is trying to establish.
 *
 * 🛑 **Authorization is `lib/derivations/scope.ts`'s job on every path**, and the area in a shim's
 * URL contributes NOTHING to it. That is the point of the change: an area is a narrowing filter for
 * a listing and a default for the HWS create's device, never a grant.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  derivations,
  derivationSources,
  derivedIntervals,
  devices,
  points,
} from "@/lib/db/planetscale/schema";
import { Area, Derivation, Device } from "@/lib/ids";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { refuseIfReliedUpon } from "@/lib/integrity/http";
import { getNowFormattedAEST } from "@/lib/date-utils";
import { parseRecomputeRange } from "@/lib/run-tracking/range";
import { deleteRange, recomputeRange } from "@/lib/run-tracking/recompute";
import { TRACKABLE_ROLE_IDS, type RoleId } from "@/lib/roles/registry";
import {
  ensureHwsDerivation,
  ensureHwsTemperaturePoint,
} from "@/lib/hws/register";
import {
  ensureRunDetector,
  HWS_MODEL_KIND,
  RUN_DETECTOR_KIND,
  type RunDetectorParams,
} from "./resolve";
import { writeDerivationSources } from "./sources";
import {
  authorizeRecord,
  listReadableDerivations,
  loadDerivation,
  readRecord,
  requireWriteOnDevices,
  type DerivationQuery,
} from "./scope";
import { derivationWire, pointUuidFromWire } from "./v4-shapes";

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

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** The member devices of an area, as raw `devices.id` uuids — the `?area=` narrowing leg. */
async function areaDeviceUuids(areaUuid: string): Promise<string[]> {
  const ids = await getAreaMemberDeviceIds(areaUuid);
  return ids.map((id) => Device.toUuid(id));
}

/**
 * GET the collection — every derivation the caller may read, narrowed by the query string.
 *
 * `?device=dv_… &area=ar_… &kind= &role= &enabled=true|false`. Because the collection returns
 * everything readable rather than everything under one area, a `dx_` becomes GLOBALLY resolvable —
 * which is what retires "there is no fleet-wide listing" and lets the CLI drop `<area>` from every
 * verb (PR 4).
 *
 * 🛑 The filters NARROW; they never widen. An `?area=` or `?device=` naming something the caller
 * cannot see returns an empty list rather than a 403: "no derivation you may read touches that" is
 * both true and free of information about what exists elsewhere.
 */
export async function handleList(
  request: NextRequest,
  scope?: { deviceUuids: string[] },
): Promise<NextResponse> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const query: DerivationQuery = {};
  const kind = sp.get("kind");
  if (kind) query.kind = kind;
  const role = sp.get("role");
  if (role) query.role = role;
  const enabled = sp.get("enabled");
  if (enabled === "true" || enabled === "false")
    query.enabled = enabled === "true";

  const device = sp.get("device");
  if (device) {
    const uuid = Device.toUuidOrNull(device);
    if (!uuid)
      return NextResponse.json(
        { error: `Invalid device id: ${device}` },
        { status: 400 },
      );
    query.deviceUuid = uuid;
  }

  // An explicit `?area=` and a shim's path-supplied area compose by INTERSECTION rather than one
  // overriding the other — two narrowings both apply, which is the only reading of "and" that
  // cannot accidentally widen.
  const areaUuids: string[][] = [];
  if (scope) areaUuids.push(scope.deviceUuids);
  const area = sp.get("area");
  if (area) {
    const uuid = Area.toUuidOrNull(area);
    if (!uuid)
      return NextResponse.json(
        { error: `Invalid area id: ${area}` },
        { status: 400 },
      );
    areaUuids.push(await areaDeviceUuids(uuid));
  }
  if (areaUuids.length > 0)
    query.anyDeviceUuids = areaUuids.reduce((a, b) =>
      a.filter((u) => b.includes(u)),
    );

  const records = await listReadableDerivations(
    auth.userId,
    auth.isAdmin,
    query,
  );
  return NextResponse.json({ derivations: records.map(derivationWire) });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * POST the collection — create a derivation, per-kind.
 *
 * The route is a dispatcher over the existing writers rather than one uniform insert, because the
 * two kinds genuinely differ: a run detector is declared entirely by the body, whereas an HWS model
 * MINTS its own output point first (`ensureHwsTemperaturePoint`) and then discovers both source and
 * output from the device's `load.hws` stem. Flattening that into one shape would mean inventing a
 * body for `hws-model` whose fields the writer then ignores.
 *
 * 🛑 **Nothing about placement is asked or answered.** There is no area in the body, and the
 * `derivations.area_id` vestige is written NULL (0064 drops it): the derivation's site is its owner
 * device, computed from the wiring. `hwsFallbackHandle` exists only so the area-scoped shim can keep
 * serving a body with no `device` in it, which is what the CLI still sends.
 */
export async function handleCreate(
  request: NextRequest,
  opts: { hwsFallbackHandle?: number | null } = {},
): Promise<NextResponse> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

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
        { error: `role must be one of: ${TRACKABLE_ROLE_IDS.join(", ")}` },
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

    // 🛑 Authorize the devices the detector WOULD touch, BEFORE writing anything. The create path
    // cannot use `loadDerivation` (there is no row yet), so the same every-device write rule is
    // applied to the prospective set — signal's device and, when given, energy's. Daylesford's
    // generator spans two devices (signal on 14, energy on 1) and is exactly the case this must get
    // right: both, or neither.
    const wanted = [
      signalPointUid,
      ...(energyPointUid ? [energyPointUid] : []),
    ];
    const owners = new Map(
      (
        await requirePlanetscaleDb()
          .select({ id: points.id, deviceId: points.deviceId })
          .from(points)
          .where(inArray(points.id, wanted))
      ).map((p) => [p.id, p.deviceId]),
    );
    // Reported as a body error (which slot is wrong) rather than collapsed into the 403 below.
    // `ensureRunDetector` would refuse it anyway; saying so before the authorization keeps the two
    // failures distinguishable to the operator who owns the points — a typo in your own `pt_` id is
    // the common case, and "403" would be an actively misleading answer to it.
    //
    // ⚠️ The cost, stated: this is a weak existence oracle over `pt_` ids for an AUTHENTICATED
    // caller — "does this point exist" is answerable without owning it. It is the pre-existing
    // behaviour of this create path (which `resolveMemberDeviceRefs` deliberately does NOT share,
    // collapsing unknown-and-unreadable into one 403), and it is accepted here because a point id
    // is a uuidv5 over the point's own uid rather than something enumerable, and because nothing
    // beyond existence crosses. Collapse it if `pt_` ids ever become guessable.
    if (!owners.has(signalPointUid)) return refusal("no-signal-point");
    if (energyPointUid && !owners.has(energyPointUid))
      return refusal("no-energy-point");
    const denied = await requireWriteOnDevices(
      [...owners.values()],
      auth.userId,
      auth.isAdmin,
    );
    if (denied) return denied;

    const result = await ensureRunDetector({
      role: role as RoleId,
      name,
      signalPointUid,
      energyPointUid,
      params: detectorParams,
      apply: true,
    });
    if (result.status === "owner-role-taken")
      return refusal(
        result.status,
        // 🛑 ENCODED. `ensureRunDetector` deals in raw uuids and this is the HTTP layer, so the id
        // that crosses has to be the `dx_` the caller can actually use — a refusal that names a raw
        // uuid tells an operator to "edit that one" in a vocabulary the API does not accept.
        // The one placement rule there is, and it is about the OWNER DEVICE rather than the area:
        // two detectors for the same role resolving to the same owner would fight over one
        // `<stem>/running` point. `derivation_sources_signal_role_unique` cannot express it (their
        // signals may sit on different devices), so it is checked in code — see `ensureRunDetector`.
        `A ${role} run detector already owns this device: ` +
          `${result.conflictingDerivationId ? Derivation.encode(result.conflictingDerivationId) : "unknown"}. ` +
          `Edit that one, or point this detector at a different device's energy/signal points.`,
      );
    if (result.status !== "created" && result.status !== "exists")
      return refusal(result.status);

    return respondWithRow(
      result.derivationId!,
      result.status,
      auth.userId,
      auth.isAdmin,
    );
  }

  if (kind === HWS_MODEL_KIND) {
    // The HWS model is declared by the DEVICE it models, not by explicit points: it mints its own
    // `load.hws/temperature` output point and finds its `load.hws/power` source. So the only input
    // is which device.
    const ref = typeof body?.device === "string" ? body.device : null;
    let deviceUuid: string | null = ref ? Device.toUuidOrNull(ref) : null;
    if (ref && !deviceUuid)
      return NextResponse.json(
        { error: `Invalid device id: ${ref}` },
        { status: 422 },
      );
    let handle: number | null = null;
    if (deviceUuid) {
      const [dv] = await requirePlanetscaleDb()
        .select({ rid: devices.rid })
        .from(devices)
        .where(eq(devices.id, deviceUuid))
        .limit(1);
      if (!dv)
        return NextResponse.json(
          { error: `Unknown device: ${ref}` },
          { status: 422 },
        );
      handle = dv.rid;
    } else if (opts.hwsFallbackHandle != null) {
      // The shim's back-compat leg: an area-of-one's own handle stands in for `device`.
      handle = opts.hwsFallbackHandle;
      const [dv] = await requirePlanetscaleDb()
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.rid, handle))
        .limit(1);
      deviceUuid = dv?.id ?? null;
    }
    if (handle == null || !deviceUuid)
      return NextResponse.json(
        { error: "device is required (a dv_ device id)" },
        { status: 422 },
      );

    const denied = await requireWriteOnDevices(
      [deviceUuid],
      auth.userId,
      auth.isAdmin,
    );
    if (denied) return denied;

    const point = await ensureHwsTemperaturePoint(handle, true);
    if (point.status === "no-power-point")
      return refusal(
        point.status,
        "The device has no load.hws/power point to model from.",
      );
    const result = await ensureHwsDerivation(handle, true);
    if (result.status !== "created" && result.status !== "exists")
      return refusal(result.status);
    return respondWithRow(
      result.derivationId!,
      result.status,
      auth.userId,
      auth.isAdmin,
    );
  }

  return NextResponse.json(
    {
      error: `Unknown kind '${kind}' (one of: ${RUN_DETECTOR_KIND}, ${HWS_MODEL_KIND})`,
    },
    { status: 422 },
  );
}

/**
 * Re-read the written row so the response is what the DB holds, not what the request asked for —
 * and authorize it before handing it back.
 *
 * 🛑 The second half is not belt-and-braces, it closes a real disclosure. The create path authorizes
 * the PROSPECTIVE device set (the points in the body), but `ensureRunDetector` is idempotent by
 * natural key, so `exists` can name a row whose set is WIDER than what was authorized: a detector
 * whose signal is on your device and whose energy is on someone else's. Without this, POSTing your
 * own point's id would return that row's full wiring — its `dx_`, the foreign `pt_`, the foreign
 * `dv_` — while GET on the same id correctly 404s. `created` always passes (its set is exactly the
 * set just authorized), so this only ever bites the case it exists for.
 */
async function respondWithRow(
  derivationId: string,
  status: "created" | "exists",
  userId: string,
  isAdmin: boolean,
): Promise<NextResponse> {
  const record = await readRecord(derivationId);
  if (!record)
    return NextResponse.json({ status, derivation: null }, { status: 200 });
  const refusal = authorizeRecord(record, userId, isAdmin, "write");
  if (refusal) return refusal;
  return NextResponse.json(
    { status, derivation: derivationWire(record) },
    { status: status === "created" ? 201 : 200 },
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

/** GET one derivation, with its sources and the device set it was authorized against. */
export async function handleGet(
  request: NextRequest,
  dxid: string,
): Promise<NextResponse> {
  const loaded = await loadDerivation(request, dxid, "read");
  if ("error" in loaded) return loaded.error;
  return NextResponse.json({ derivation: derivationWire(loaded.record) });
}

/**
 * PATCH one derivation: `{ enabled?, name?, params?, boundaryPointUid? }`.
 *
 * ## What is NOT patchable, and why
 *
 * 🛑 `kind` and `role` are the derivation's IDENTITY: `deriveDerivationId` is a uuidv5 over the
 * source point plus exactly those two, so "changing" one does not edit this derivation — it names a
 * different one, while leaving this row's id (and therefore every `derived_intervals` row hanging
 * off it) attached to the old meaning. That is a silent corruption, so the fields are simply absent
 * from the patch surface; create the other derivation instead.
 *
 * `sourcePoints` is excluded for a softer but real reason: re-pointing a detector's signal changes
 * what its ALREADY-STORED intervals mean, and the stored rows carry the old signal's unit
 * (migration 0055's `signal_unit`) with no way to know they predate the change. Daylesford's
 * generator has been through exactly this — Grid-power proxy → DeepSea engine speed — and the
 * correct handling was a deliberate, scoped recompute, not a config edit that quietly leaves a
 * mixed-provenance table behind.
 *
 * The ONE exception carved out of that is `boundaryPointUid`, which sets the `boundary` slot — the
 * control point whose edges cut runs apart. It is safe in exactly the way re-pointing `signal` is
 * not: it does not change what the stored numbers MEASURE (no unit, no signal, no provenance moves),
 * only where two adjacent runs are divided. Sending `null` clears it.
 *
 * `enabled` IS patchable and is the safe lever: a disabled derivation stops being recomputed and
 * stops advertising its capability, while its intervals stay exactly as they were.
 */
export async function handlePatch(
  request: NextRequest,
  dxid: string,
): Promise<NextResponse> {
  const loaded = await loadDerivation(request, dxid, "write");
  if ("error" in loaded) return loaded.error;
  const current = loaded.record.row;

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
    const uid = body.boundaryPointUid;
    if (uid !== null && (typeof uid !== "string" || uid.trim() === ""))
      return NextResponse.json(
        { error: "boundaryPointUid must be a point uuid or null" },
        { status: 422 },
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
    if (uid !== null) {
      const [pt] = await requirePlanetscaleDb()
        .select({ id: points.id, deviceId: points.deviceId })
        .from(points)
        .where(eq(points.id, uid))
        .limit(1);
      if (!pt)
        return NextResponse.json(
          { error: `Unknown boundary point: ${uid}` },
          { status: 422 },
        );
      // 🛑 A boundary point WIDENS the device set, so it needs the same write check the load did —
      // otherwise the one re-pointable slot is the way to attach your detector to my device.
      const denied = await requireWriteOnDevices(
        [pt.deviceId],
        loaded.userId,
        loaded.isAdmin,
      );
      if (denied) return denied;
    }
    boundaryPointUid = uid;
  }
  for (const forbidden of [
    "kind",
    "role",
    "areaId",
    "area",
    "sourcePoints",
    "output",
  ]) {
    if (body[forbidden] !== undefined)
      return NextResponse.json(
        {
          error: `${forbidden} is not patchable — see the note in lib/derivations/v4-routes.ts on identity and re-pointing`,
        },
        { status: 422 },
      );
  }
  // `boundaryPointUid` does not contribute to `patch` (it is applied from `derivation_sources`
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

  // 🛑 ONE TRANSACTION, because a boundary patch is a dual-write: the `derivation_sources` rows the
  // resolver acts on and the jsonb vestige 0064 has not dropped yet. Split across two commits, a
  // failure between them leaves detection cutting runs at a boundary the rows deny having — or,
  // worse, leaves the delete committed and the insert not.
  const updatedId = await requirePlanetscaleDb().transaction(async (tx) => {
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
            .where(eq(derivationSources.derivationId, current.id));

    const [updated] = await tx
      .update(derivations)
      .set(patch)
      .where(eq(derivations.id, current.id))
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
      await tx
        .update(derivations)
        .set({ sourcePoints: next })
        .where(eq(derivations.id, updated.id));
    }
    return updated.id;
  });
  if (!updatedId)
    // Deleted between the load and the update. Same answer the load would have given.
    return NextResponse.json(
      { error: "Derivation not found" },
      { status: 404 },
    );

  const record = await readRecord(updatedId);
  return NextResponse.json({
    derivation: record ? derivationWire(record) : null,
  });
}

/**
 * DELETE one derivation, behind two interlocks.
 *
 * 1. 🛑 **It must already be disabled** → 409 `derivation-enabled`, and `?force=true` does NOT waive
 *    it. Disabling is one PATCH, it is reversible, and it makes the operator watch the thing stop
 *    before destroying it. A `--force` that skipped straight from "live" to "gone" would make the
 *    single most consequential operation in this domain the easiest one to typo.
 * 2. **Nothing may still rely on it** → 409 naming every dependent (`assertNotReliedUpon`): the
 *    `derived_intervals` count and window, the hws model's output point, and any automation whose
 *    trigger names it. THAT one is waivable with `?force=true`, because an operator may legitimately
 *    accept the loss — and the success body then reports what was overridden, so "I forced it" and
 *    "there was nothing to force" never look the same in a log.
 *
 * `derived_intervals.derivation_id` stays `ON DELETE CASCADE` (it is not converted to RESTRICT to
 * implement this — see the plan's ground rules): the interlock is what protects the history, and the
 * CASCADE is what makes the delete clean once the operator has said yes with their eyes open.
 */
export async function handleDelete(
  request: NextRequest,
  dxid: string,
): Promise<NextResponse> {
  const loaded = await loadDerivation(request, dxid, "write");
  if ("error" in loaded) return loaded.error;
  const record = loaded.record;

  if (record.row.enabled)
    return NextResponse.json(
      {
        error: "That derivation is still enabled",
        detail: {
          code: "derivation-enabled",
          fix: "PATCH { enabled: false } first, watch it stop, then delete. ?force=true does not waive this.",
        },
      },
      { status: 409 },
    );

  const relied = await refuseIfReliedUpon(request, "derivation", record.row.id);
  if ("response" in relied) return relied.response;

  // The sources go with it by `derivation_sources.derivation_id` ON DELETE CASCADE, and so do the
  // intervals — deliberately, and only after both interlocks above have passed.
  //
  // 🛑 `enabled = false` is RE-STATED in the WHERE, not merely checked above. The check and this
  // statement are separate snapshots, so a PATCH that re-enabled the detector in between would
  // otherwise let a delete land on a LIVE detector — defeating the one interlock that is deliberately
  // not waivable. Restating it makes the interlock atomic with the act it guards: zero rows deleted
  // means the world changed underneath, and that is a 409, not a success.
  const deleted = await requirePlanetscaleDb()
    .delete(derivations)
    .where(
      and(eq(derivations.id, record.row.id), eq(derivations.enabled, false)),
    )
    .returning({ id: derivations.id });
  if (deleted.length === 0)
    return NextResponse.json(
      {
        error: "That derivation was re-enabled while this delete was deciding",
        detail: {
          code: "derivation-enabled",
          fix: "nothing was deleted — re-read it, and disable it again if you still mean to",
        },
      },
      { status: 409 },
    );

  return NextResponse.json({
    deleted: derivationWire(record),
    // What went with it. Empty when nothing did; populated only when `?force=true` overrode a
    // refusal, which is the distinction the log needs to carry.
    forced: relied.forced,
  });
}

// ---------------------------------------------------------------------------
// Sub-resources
// ---------------------------------------------------------------------------

/**
 * POST `…/recompute` — rebuild ONE derivation's intervals over a window.
 *
 *   { action: "regenerate" | "delete" | "aggregate", last? | date? | start?+end? } → 200 { … }
 *
 * 🛑 **The scope is the path.** `/api/cron/derivations` takes the same actions with an OPTIONAL
 * filter, and every one of `regenerate`/`delete` is a delete-and-reinsert — so an unscoped
 * historical call rebuilds every detector in the fleet, and a detector whose signal has since been
 * re-pointed loses the rows its current signal cannot reproduce. A full-range unscoped regenerate on
 * dev once collapsed 71 rows to 3. Here the derivation is a path segment, so there is no unscoped
 * form to reach for: the dangerous call is not refused, it is unspellable.
 *
 * Range grammar is shared with the cron (`lib/run-tracking/range.ts`), so the two cannot drift on
 * what `end` means or where the floor is. An `action` with no dates means ALL history for this one
 * detector, which is safe precisely because it is one detector.
 */
export async function handleRecompute(
  request: NextRequest,
  dxid: string,
): Promise<NextResponse> {
  const loaded = await loadDerivation(request, dxid, "write");
  if ("error" in loaded) return loaded.error;
  const record = loaded.record;

  // `output='point'` kinds (the HWS model) heal through their own daily pass and
  // scripts/backfill-hws-temperature.ts — they write agg_5m rows, not intervals, so none of the
  // three actions below means anything for them. Refuse rather than reporting a successful no-op.
  if (record.row.kind !== RUN_DETECTOR_KIND)
    return NextResponse.json(
      {
        error: `Only ${RUN_DETECTOR_KIND} derivations produce intervals; this one is '${record.row.kind}'`,
      },
      { status: 422 },
    );

  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const action = s(body.action);
  if (action !== "regenerate" && action !== "delete" && action !== "aggregate")
    return NextResponse.json(
      { error: "action must be one of: regenerate | delete | aggregate" },
      { status: 400 },
    );

  const nowMs = Date.now();
  const startedMs = nowMs;
  let range: { startMs: number; endMs: number } | null;
  try {
    range = parseRecomputeRange(
      action,
      {
        last: s(body.last),
        date: s(body.date),
        start: s(body.start),
        end: s(body.end),
      },
      nowMs,
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid date parameters",
      },
      { status: 400 },
    );
  }
  // Unreachable in practice (an action is always present by the check above, and `parseRange`
  // returns a range whenever one is), but the type is nullable and a silent `!` here would be the
  // kind of assumption that stops being true when the grammar grows.
  if (!range)
    return NextResponse.json(
      { error: "Could not resolve a date range" },
      { status: 400 },
    );

  // Echoed on every response, exactly as the cron echoes its resolved scope: "which detector did
  // this touch?" is the question a delete-and-reinsert has to answer out loud, even when the answer
  // is structurally guaranteed.
  const scope = { derivation: derivationWire(record) };
  const window = {
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
  };
  const filter = { derivationId: record.row.id };

  // 🛑 A DISABLED derivation resolves to nothing here. `recomputeRange`/`deleteRange` both go
  // through `listEnabledRunDetectors`, which filters on `enabled` — so a scoped call against a
  // disabled detector reports zeros rather than failing, and that reads as "no data in the window".
  // Say which it was.
  if (!record.row.enabled)
    return NextResponse.json(
      {
        error:
          "This derivation is disabled, and a recompute would silently do nothing — enable it first",
      },
      { status: 422 },
    );

  const done = (extra: object) =>
    NextResponse.json({
      success: true,
      action,
      scope,
      window,
      ...extra,
      durationMs: Date.now() - startedMs,
      executedAt: getNowFormattedAEST(),
    });

  if (action === "delete")
    return done(await deleteRange(range.startMs, range.endMs, filter));

  if (action === "regenerate") {
    const del = await deleteRange(range.startMs, range.endMs, filter);
    const summary = await recomputeRange(range.startMs, range.endMs, nowMs, {
      filter,
    });
    return done({ rowsPurged: del.rowsDeleted, ...summary });
  }

  return done(
    await recomputeRange(range.startMs, range.endMs, nowMs, { filter }),
  );
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/**
 * GET `…/intervals` — the rows a derivation has produced.
 *
 *   ?last=30d | ?date=YYYY-MM-DD | ?start=&end=   ·   ?limit= (≤500) ?offset=
 *   → 200 { derivation, window, count, hasMore, intervals: [...] }
 *
 * Newest first, and bounded: `derived_intervals` is small per detector but unbounded over time, and
 * an operator read that silently returned a year would be the wrong default for both the wire and
 * the terminal.
 *
 * ## Why this is not `/api/device/{handle}/run-periods`
 *
 * That route exists and serves the same table, but it is the DASHBOARD CARD's endpoint: keyed by the
 * legacy integer handle rather than a TypeID, resolving the detector by (handle, role) rather than
 * by identity, and — decisively — serving DISPLAY STRINGS (`date: "Sat 30 Aug"`, `startTime:
 * "4:16pm"`), pre-formatted in the device's display timezone. That is exactly right for the card and
 * exactly wrong for anything that wants to compute. So this serves the ROW: ISO instants, numbers,
 * and the unit each number is in.
 */
export async function handleIntervals(
  request: NextRequest,
  dxid: string,
): Promise<NextResponse> {
  const loaded = await loadDerivation(request, dxid, "read");
  if ("error" in loaded) return loaded.error;
  const record = loaded.record;

  const { searchParams } = new URL(request.url);
  const int = (name: string, fallback: number): number | null => {
    const raw = searchParams.get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const limit = int("limit", DEFAULT_LIMIT);
  const offset = int("offset", 0);
  if (limit === null || offset === null)
    return NextResponse.json(
      { error: "limit and offset must be non-negative integers" },
      { status: 400 },
    );
  if (limit > MAX_LIMIT)
    return NextResponse.json(
      { error: `limit must be ${MAX_LIMIT} or less` },
      { status: 400 },
    );

  // The same window grammar as `…/recompute`, so "which rows did that rebuild write" is asked with
  // the flags that wrote them. Passing a truthy `action` makes an omitted window mean ALL history
  // (bounded by `limit` regardless) rather than null.
  let range: { startMs: number; endMs: number } | null;
  try {
    range = parseRecomputeRange(
      "list",
      {
        last: searchParams.get("last"),
        date: searchParams.get("date"),
        start: searchParams.get("start"),
        end: searchParams.get("end"),
      },
      Date.now(),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid date parameters",
      },
      { status: 400 },
    );
  }

  // Windowed on `start_time`, matching `deleteRange` — a run is IN a window if it STARTED in it, so
  // the rows this returns are exactly the rows a recompute over the same window would replace.
  const conds = [eq(derivedIntervals.derivationId, record.row.id)];
  if (range) {
    conds.push(gte(derivedIntervals.startTime, new Date(range.startMs)));
    conds.push(lte(derivedIntervals.startTime, new Date(range.endMs)));
  }

  // One extra row is the `hasMore` probe — cheaper and more honest than a COUNT(*) that would race
  // the minutely reconcile writing into the same window.
  const rows = await requirePlanetscaleDb()
    .select()
    .from(derivedIntervals)
    .where(and(...conds))
    .orderBy(desc(derivedIntervals.startTime))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    derivation: derivationWire(record),
    window: range
      ? {
          start: new Date(range.startMs).toISOString(),
          end: new Date(range.endMs).toISOString(),
        }
      : null,
    count: page.length,
    hasMore,
    intervals: page.map((r) => ({
      startTime: r.startTime.toISOString(),
      // null = OPEN (running now) — a fact about the row, not a missing value.
      endTime: r.endTime ? r.endTime.toISOString() : null,
      durationSeconds: r.durationSeconds,
      energyKwh: r.energyKwh,
      estimatedKwh: r.estimatedKwh,
      maxSignal: r.maxSignal,
      minSignal: r.minSignal,
      avgSignal: r.avgSignal,
      // Per ROW, not per response: one window can straddle a detector re-point and hold both units
      // (prod's Daylesford history is permanently mixed W/rpm). A response-level unit would be a
      // confident lie about 74 of 77 rows.
      signalUnit: r.signalUnit,
      costC: r.costC,
      emissionsG: r.emissionsG,
      renewableKwh: r.renewableKwh,
      sampleCount: r.sampleCount,
      detectorVersion: r.detectorVersion,
    })),
  });
}
