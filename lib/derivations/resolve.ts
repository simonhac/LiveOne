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
  areas,
  derivations,
  devices,
  legacyHandles,
  points,
} from "@/lib/db/planetscale/schema";
import { Device, Point, type PointId } from "@/lib/ids";
import { DeviceRegistry } from "@/lib/registry/device-registry";
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

/** All enabled run-detector derivations, resolved. Unresolvable rows are dropped with a warning. */
export async function listEnabledRunDetectors(): Promise<
  ResolvedRunDetector[]
> {
  const rows = await requirePlanetscaleDb()
    .select({ d: derivations, a: areaFactsProjection })
    .from(derivations)
    .innerJoin(areas, eq(areas.id, derivations.areaId))
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(
      and(
        eq(derivations.kind, RUN_DETECTOR_KIND),
        eq(derivations.enabled, true),
      ),
    );
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
