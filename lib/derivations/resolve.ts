/**
 * Resolve `derivations` rows into the concrete config each engine needs — the single discovery
 * layer for every kind of derived signal (config-v4 Phase 11).
 *
 * A derivation is config that computes a new signal from existing points (clean-sheet §4.4):
 * `output='intervals'` → run/event periods in `derived_intervals`; `output='point'` → a derived
 * point in the readings pipeline (the HWS model, previously discovered by scanning `point_info` for
 * a `load.hws/temperature` row).
 *
 * Two conventions worth knowing:
 *
 * - **`params` is SPARSE.** A key is present only when it was explicitly configured; anything
 *   absent inherits the per-role code defaults (`lib/run-tracking/defaults.ts`). Thresholds are
 *   always explicit — they have no sensible default.
 * - **`source_points` holds raw uuids**, not the legacy `(system_id, index)` address pair. They are
 *   `points.id` values, so a consumer encodes straight to a `PointId` and hands it to the DAO — no
 *   `RegistryCache.pointForAddr` round-trip, and a point rename can't break the wiring.
 *
 * The integer `legacyHandle` is still carried because `point_info` and the KV latest keyspace stay
 * int-addressed until Phase 13; it is the area's `legacy_handles.handle`, i.e. exactly the `systemId`
 * these engines used before.
 */
import { and, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaMembers,
  areas,
  derivations,
  devices,
  legacyHandles,
  points,
} from "@/lib/db/planetscale/schema";
import { Device, Point, type PointId } from "@/lib/ids";
import { DeviceRegistry } from "@/lib/registry/device-registry";
import { TRACKABLE_ROLE_IDS, type RoleId } from "@/lib/roles/registry";
import { deriveDerivationId } from "./ids";
import { mergeDetectConfig, type DetectConfig } from "./params";
import {
  DEFAULT_HWS_MODEL_OPTIONS,
  type HwsModelOptions,
} from "@/lib/hws-model";

export const RUN_DETECTOR_KIND = "run-detector";
export const HWS_MODEL_KIND = "hws-model";

// ---------------------------------------------------------------------------
// Persisted jsonb contracts
// ---------------------------------------------------------------------------

/** `derivations.params` for kind='run-detector'. Sparse: absent ⇒ inherit the role default. */
export interface RunDetectorParams {
  signalKind: "power-threshold";
  /** At least one bound is required; both are always explicit (no default exists). */
  lowerW?: number;
  upperW?: number;
  hysteresisW?: number;
  delayOnSeconds?: number;
  delayOffSeconds?: number;
}

/** `derivations.source_points` for kind='run-detector'. Raw `points.id` uuids. */
export interface RunDetectorSourcePoints {
  signal: string;
  energy?: string | null;
  /**
   * Optional CONTROL point whose edges cut runs apart (`DetectConfig.boundaryEventsMs`) — for the
   * generator, the hub's commanded-run point. Absent = detection behaves exactly as before.
   */
  boundary?: string | null;
}

/** `derivations.params` for kind='hws-model'. Sparse overrides on the model constants. */
export type HwsModelParams = Partial<HwsModelOptions>;

/** `derivations.source_points` for kind='hws-model'. Raw `points.id` uuid of the power signal. */
export interface HwsSourcePoints {
  power: string;
}

// ---------------------------------------------------------------------------
// Resolved shapes
// ---------------------------------------------------------------------------

export interface ResolvedRunDetector {
  /** `derivations.id` — the identity `derived_intervals` rows hang off. */
  id: string;
  areaId: string;
  /** The area's `legacy_handles.handle`: the integer this detector used to be keyed by. */
  legacyHandle: number;
  role: string;
  name: string;
  signalPoint: PointId;
  /**
   * The RAW `points.unit` of `signalPoint` ('W', 'rpm', …), or null when the point has no `points`
   * row. This is what `derived_intervals.signal_unit` is stamped with, so a stored statistic says
   * what it measures instead of being assumed to be Watts (migration 0055).
   *
   * Null is a broken binding, not a normal state — `source_points.signal` should always name a live
   * point. The writer treats it as "refuse to store an unlabelled number" rather than guessing.
   */
  signalUnit: string | null;
  energyPoint: PointId | null;
  /** Control point whose edges force a run boundary (see RunDetectorSourcePoints.boundary). */
  boundaryPoint: PointId | null;
  detect: DetectConfig;
  detectorVersion: number;
  timezoneOffsetMin: number;
  displayTimezone: string;
}

export interface ResolvedHwsModel {
  id: string;
  areaId: string;
  /** The output point's own owning-device handle (`devices.rid`) — the KV latest cache key, as before. */
  systemId: number;
  powerPoint: PointId;
  /** The derived output point (`output_point_id`) — the agg_5m write target. */
  tempPoint: PointId;
  tempPath: string;
  tempUnit: string;
  tempDisplayName: string;
  options: HwsModelOptions;
}

// ---------------------------------------------------------------------------
// Handle → area
// ---------------------------------------------------------------------------

/**
 * The old integer handle → owning area uuid. Area-first (a handle naming both an area-of-one and
 * its device must resolve as the area), else the device's `primary_area_id`.
 *
 * This is deliberately the ONE mapping used by both the fill script and every runtime lookup, so a
 * derivation can never be written against an area the readers don't resolve to.
 */
export async function resolveAreaIdForHandle(
  handle: number,
): Promise<string | null> {
  const targets = await DeviceRegistry.resolveHandle(handle);
  if (!targets) return null;
  if (targets.areaId) return targets.areaId;
  if (!targets.deviceId) return null;
  const [row] = await requirePlanetscaleDb()
    .select({ areaId: devices.primaryAreaId })
    .from(devices)
    .where(eq(devices.id, Device.toUuid(targets.deviceId)))
    .limit(1);
  return row?.areaId ?? null;
}

// ---------------------------------------------------------------------------
// Run detectors
// ---------------------------------------------------------------------------

type DerivationRow = typeof derivations.$inferSelect;
type AreaFacts = {
  legacySystemId: number | null;
  tzOffset: number;
  tz: string;
};

// config-v4 Phase 13 PR 5: `legacySystemId` is read from `legacy_handles`, not the dropped
// `areas.legacy_system_id`. Every query using this projection must therefore also LEFT JOIN
// `legacyHandles` on `area_id` — left, so the field stays `number | null` and `resolveRunDetector`'s
// existing "area has no legacy handle — skipping" guard keeps its referent instead of the detector
// silently disappearing from the result set with no log line.
const areaFactsProjection = {
  legacySystemId: legacyHandles.handle,
  tzOffset: areas.timezoneOffsetMin,
  tz: areas.displayTimezone,
};

function resolveRunDetector(
  row: DerivationRow,
  area: AreaFacts,
): ResolvedRunDetector | null {
  if (area.legacySystemId == null) {
    console.warn(
      `[Derivations] run-detector ${row.id}: area ${row.areaId} has no legacy handle — skipping`,
    );
    return null;
  }
  if (row.role == null) {
    console.warn(`[Derivations] run-detector ${row.id}: no role — skipping`);
    return null;
  }
  const params = row.params as RunDetectorParams;
  const src = row.sourcePoints as RunDetectorSourcePoints;
  if (!src?.signal) {
    console.warn(
      `[Derivations] run-detector ${row.id}: no signal source point — skipping`,
    );
    return null;
  }
  return {
    id: row.id,
    areaId: row.areaId,
    legacyHandle: area.legacySystemId,
    role: row.role,
    name: row.name,
    signalPoint: Point.encode(src.signal),
    signalUnit: null, // filled by attachSignalUnits — one batched read for the whole result set
    energyPoint: src.energy ? Point.encode(src.energy) : null,
    boundaryPoint: src.boundary ? Point.encode(src.boundary) : null,
    detect: mergeDetectConfig(params, row.role),
    detectorVersion: row.detectorVersion,
    timezoneOffsetMin: area.tzOffset,
    displayTimezone: area.tz,
  };
}

/**
 * Fill `signalUnit` on every detector, in ONE `points` read for the whole set.
 *
 * Deliberately a second query rather than a join: `source_points.signal` is a jsonb key, so joining
 * it needs a hand-written `(source_points ->> 'signal')::uuid` fragment — and raw SQL is invisible
 * to tsc, which the execution plan names as the single most reliable failure mode of this whole
 * migration. `inArray` over the already-decoded uuids is typed end to end and costs one round trip.
 */
async function attachSignalUnits(
  detectors: ResolvedRunDetector[],
): Promise<ResolvedRunDetector[]> {
  if (detectors.length === 0) return detectors;
  const uuids = [...new Set(detectors.map((d) => Point.toUuid(d.signalPoint)))];
  const rows = await requirePlanetscaleDb()
    .select({ id: points.id, unit: points.unit })
    .from(points)
    .where(inArray(points.id, uuids));
  const unitById = new Map(rows.map((r) => [r.id, r.unit]));
  for (const d of detectors) {
    const unit = unitById.get(Point.toUuid(d.signalPoint));
    if (unit === undefined) {
      console.warn(
        `[Derivations] run-detector ${d.id}: signal point ${Point.toUuid(d.signalPoint)} has no points row — its interval statistics will be stored WITHOUT values, since they cannot be labelled`,
      );
    }
    d.signalUnit = unit ?? null;
  }
  return detectors;
}

/**
 * Narrow a detector listing to ONE detector — by its `derivations.id`, or by the (handle, role) pair
 * that names it.
 *
 * 🛑 This exists so a recompute can be aimed. `recomputeRange`/`deleteRange` delete-and-reinsert every
 * enabled detector's intervals over the window, which makes an unscoped historical backfill
 * DESTRUCTIVE to detectors other than the one being backfilled: a detector whose signal has been
 * re-pointed (Daylesford's generator moved to the DeepSea engine-speed point, whose history starts
 * 2026-07-11) regenerates NOTHING for a window predating its current signal, so its existing rows
 * are deleted and not replaced. Scope every historical pass.
 */
export type RunDetectorFilter =
  | { derivationId: string }
  | { handle: number; role: string };

/** All enabled run-detector derivations, resolved. Unresolvable rows are dropped with a warning. */
export async function listEnabledRunDetectors(
  filter?: RunDetectorFilter,
): Promise<ResolvedRunDetector[]> {
  const conds = [
    eq(derivations.kind, RUN_DETECTOR_KIND),
    eq(derivations.enabled, true),
  ];
  if (filter) {
    if ("derivationId" in filter) {
      conds.push(eq(derivations.id, filter.derivationId));
    } else {
      const areaId = await resolveAreaIdForHandle(filter.handle);
      // An unresolvable handle must select NOTHING, never everything. The caller asked to be
      // narrowed; silently widening back to the whole fleet is how a scoped backfill becomes a
      // fleet-wide delete-and-reinsert.
      if (!areaId) return [];
      conds.push(
        eq(derivations.areaId, areaId),
        eq(derivations.role, filter.role),
      );
    }
  }
  const rows = await requirePlanetscaleDb()
    .select({ d: derivations, a: areaFactsProjection })
    .from(derivations)
    .innerJoin(areas, eq(areas.id, derivations.areaId))
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(and(...conds));
  return attachSignalUnits(
    rows
      .map(({ d, a }) => resolveRunDetector(d, a))
      .filter((t): t is ResolvedRunDetector => t !== null),
  );
}

/** The enabled run detector for a legacy (handle, role), or null. */
export async function getRunDetectorForHandleRole(
  handle: number,
  role: string,
): Promise<ResolvedRunDetector | null> {
  const areaId = await resolveAreaIdForHandle(handle);
  if (!areaId) return null;
  const [row] = await requirePlanetscaleDb()
    .select({ d: derivations, a: areaFactsProjection })
    .from(derivations)
    .innerJoin(areas, eq(areas.id, derivations.areaId))
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(
      and(
        eq(derivations.areaId, areaId),
        eq(derivations.role, role),
        eq(derivations.kind, RUN_DETECTOR_KIND),
        eq(derivations.enabled, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  const det = resolveRunDetector(row.d, row.a);
  return det ? (await attachSignalUnits([det]))[0] : null;
}

/** Cheap existence check: does this legacy (handle, role) have an enabled run detector? */
export async function hasEnabledRunDetector(
  handle: number,
  role: string,
): Promise<boolean> {
  const areaId = await resolveAreaIdForHandle(handle);
  if (!areaId) return false;
  const [row] = await requirePlanetscaleDb()
    .select({ id: derivations.id })
    .from(derivations)
    .where(
      and(
        eq(derivations.areaId, areaId),
        eq(derivations.role, role),
        eq(derivations.kind, RUN_DETECTOR_KIND),
        eq(derivations.enabled, true),
      ),
    )
    .limit(1);
  return !!row;
}

export interface EnsureRunDetectorInput {
  /** The area the detector hangs off — see the placement note below. */
  areaId: string;
  role: RoleId;
  name: string;
  /** `points.id` uuid of the series the detector thresholds. */
  signalPointUid: string;
  /** `points.id` uuid of a cumulative energy counter, or null for a detector with no kWh. */
  energyPointUid?: string | null;
  params: RunDetectorParams;
  /** False = report what would happen without writing. */
  apply: boolean;
}

export type EnsureRunDetectorStatus =
  | "created"
  | "exists"
  | "no-area"
  | "not-trackable"
  | "no-signal-point"
  | "no-energy-point"
  | "no-bounds"
  | "area-not-probed";

export interface EnsureRunDetectorResult {
  status: EnsureRunDetectorStatus;
  role: string;
  derivationId?: string;
  areaId?: string;
  /** For `area-not-probed`: the member handles that ARE eligible to carry the detector. */
  memberHandles?: number[];
}

/**
 * Ensure the run-detector derivation for `(areaId, role)` exists. The write-side twin of
 * {@link getRunDetectorForHandleRole}, modelled on `ensureHwsDerivation` (lib/hws/register.ts) —
 * until now the only derivation with a writer at all, which is why Daylesford's generator row was
 * hand-written SQL.
 *
 * Idempotent via the deterministic id (`deriveDerivationId`), which is also what lets
 * `prod-dev-sync` copy `derivations` as a plain by-PK upsert: seed prod and dev inherits the same
 * row, pointing at the same `derived_intervals`.
 *
 * 🛑 **WHICH AREA.** A detector belongs on a device's own AREA-OF-ONE, never on the composite site
 * area you want the card on. `capabilitiesForDevice` probes `hasEnabledRunDetector` for each MEMBER
 * handle of an area and never for the area's own handle, so a detector parked on the composite is
 * invisible to the capability that lights its card up. Daylesford's generator detector lives on
 * handle 1 (a member of the Daylesford composite) for exactly this reason. The consequence is that
 * the dashboard card must be pinned with `device:`.
 *
 * That rule used to be a docstring a caller had to read and obey; it is now ENFORCED, and stated in
 * the same terms as the probe it protects: **the area's own handle must be one of its member
 * devices' handles** — precisely the condition under which `memberSystemIds` will hand this area's
 * handle to `hasEnabledRunDetector`. A composite fails it (its handle names no device); an
 * area-of-one passes. Refusal is `area-not-probed`, carrying the member handles that would work.
 *
 * ⚠️ What is deliberately NOT checked is where the SIGNAL POINT lives. A detector may watch a point
 * on a different device entirely, and one does: Daylesford's generator sits on area/handle 1
 * (Selectronic) with its energy point there, but takes its signal from the DeepSea genset's Engine
 * Speed on handle 14 — because handle 1's Grid-import proxy was measurably unable to tell a running
 * genset from a stopped one. `resolveRunDetector` has always allowed this. An earlier version of
 * this guard required the signal point's device to own the area and would have refused to recreate
 * Daylesford's own detector; `scripts/utils/v4-surface-smoke.ts` caught it by driving the real row.
 *
 * Every failure mode is a distinct status rather than a throw, because the callers are a dry-run
 * script and an API route, both of which want to report rather than crash. The point existence
 * checks matter: `resolveRunDetector` only WARNS on a dangling `source_points.signal`, so a typo'd
 * uuid would otherwise persist as a detector that silently derives nothing forever.
 */
export async function ensureRunDetector(
  input: EnsureRunDetectorInput,
): Promise<EnsureRunDetectorResult> {
  const { areaId, role, signalPointUid, energyPointUid, params, apply } = input;
  const base = { role, areaId };

  if (!TRACKABLE_ROLE_IDS.includes(role))
    return { ...base, status: "not-trackable" };
  // detectRunPeriods throws without a bound, and it throws deep inside the cron rather than here.
  if (params.lowerW == null && params.upperW == null)
    return { ...base, status: "no-bounds" };

  const db = requirePlanetscaleDb();
  const wanted = [signalPointUid, ...(energyPointUid ? [energyPointUid] : [])];
  const found = new Set(
    (
      await db
        .select({ id: points.id })
        .from(points)
        .where(inArray(points.id, wanted))
    ).map((r) => r.id),
  );
  if (!found.has(signalPointUid)) return { ...base, status: "no-signal-point" };
  if (energyPointUid && !found.has(energyPointUid))
    return { ...base, status: "no-energy-point" };

  // Is this an area the capability probe will ask? See the WHICH AREA note above.
  const [handleRow] = await db
    .select({ handle: legacyHandles.handle })
    .from(legacyHandles)
    .where(eq(legacyHandles.areaId, areaId))
    .limit(1);
  const memberHandles = (
    await db
      .select({ rid: devices.rid })
      .from(areaMembers)
      .innerJoin(devices, eq(devices.id, areaMembers.deviceId))
      .where(eq(areaMembers.areaId, areaId))
  ).map((r) => r.rid);
  if (handleRow == null) return { ...base, status: "no-area" };
  if (!memberHandles.includes(handleRow.handle))
    return { ...base, status: "area-not-probed", memberHandles };

  const id = deriveDerivationId(areaId, RUN_DETECTOR_KIND, role);
  const [existing] = await db
    .select({ id: derivations.id })
    .from(derivations)
    .where(eq(derivations.id, id))
    .limit(1);
  if (existing) return { ...base, status: "exists", derivationId: id };
  if (!apply) return { ...base, status: "created", derivationId: id };

  await db.insert(derivations).values({
    id,
    areaId,
    kind: RUN_DETECTOR_KIND,
    role,
    name: input.name,
    enabled: true,
    output: "intervals",
    // Sparse by convention: anything absent inherits `detectorDefaultsForRole` at resolve time.
    params,
    sourcePoints: {
      signal: signalPointUid,
      energy: energyPointUid ?? null,
    } satisfies RunDetectorSourcePoints,
  });

  return { ...base, status: "created", derivationId: id };
}

/**
 * `ensureRunDetector` addressed by the legacy integer handle — what the seed script's `--handle`
 * flag means. Kept as a thin wrapper rather than a second implementation so the placement rule is
 * enforced in exactly one place.
 */
export async function ensureRunDetectorForHandle(
  input: Omit<EnsureRunDetectorInput, "areaId"> & { handle: number },
): Promise<EnsureRunDetectorResult> {
  const areaId = await resolveAreaIdForHandle(input.handle);
  if (!areaId) return { role: input.role, status: "no-area" };
  const { handle: _handle, ...rest } = input;
  return ensureRunDetector({ ...rest, areaId });
}

// ---------------------------------------------------------------------------
// HWS models
// ---------------------------------------------------------------------------

/**
 * All enabled hws-model derivations, resolved. The output point's integer address / unit / display
 * name still come from `point_info` (primary until Phase 12), looked up by its uuid.
 */
export async function listEnabledHwsModels(): Promise<ResolvedHwsModel[]> {
  const rows = await requirePlanetscaleDb()
    .select({ d: derivations })
    .from(derivations)
    .where(
      and(eq(derivations.kind, HWS_MODEL_KIND), eq(derivations.enabled, true)),
    );

  const resolved: ResolvedHwsModel[] = [];
  for (const { d } of rows) {
    const src = d.sourcePoints as HwsSourcePoints;
    if (!d.outputPointId || !src?.power) {
      console.warn(
        `[Derivations] hws-model ${d.id}: missing output point or power source — skipping`,
      );
      continue;
    }
    const [out] = await requirePlanetscaleDb()
      .select({
        systemId: devices.rid,
        stem: points.logicalPath,
        metric: points.metricType,
        unit: points.unit,
        displayName: points.name,
      })
      .from(points)
      .innerJoin(devices, eq(devices.id, points.deviceId))
      .where(eq(points.id, d.outputPointId))
      .limit(1);
    if (!out) {
      console.warn(
        `[Derivations] hws-model ${d.id}: output point ${d.outputPointId} has no points row — skipping`,
      );
      continue;
    }
    resolved.push({
      id: d.id,
      areaId: d.areaId,
      systemId: out.systemId,
      powerPoint: Point.encode(src.power),
      tempPoint: Point.encode(d.outputPointId),
      tempPath: `${out.stem}/${out.metric}`,
      tempUnit: out.unit,
      tempDisplayName: out.displayName,
      options: {
        ...DEFAULT_HWS_MODEL_OPTIONS,
        ...(d.params as HwsModelParams),
      },
    });
  }
  return resolved;
}
