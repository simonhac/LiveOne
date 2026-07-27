/**
 * Pure row mappers for the config-v4 Phase 11 fill: `device_trackers` → `derivations` and
 * `device_run_periods` → `derived_intervals`.
 *
 * Kept DB-free (and out of `scripts/`) so the mapping — the part that can silently corrupt derived
 * history — is unit-testable without a database. The script in `scripts/config-v4/fill-derivations.ts`
 * supplies the rows and writes the results.
 *
 * The one judgement call is `params`: it is written SPARSE. A legacy tracker column that was NULL
 * meant "inherit the per-role default" (lib/run-tracking/defaults.ts), so the fill omits the key
 * rather than materializing today's default value — otherwise a later defaults change would silently
 * stop applying to migrated rows, and config would appear to exist that never did.
 */
import { deriveDerivationId } from "./ids";
import {
  RUN_DETECTOR_KIND,
  type RunDetectorParams,
  type RunDetectorSourcePoints,
} from "./resolve";

/** The `device_trackers` columns the fill consumes. */
export interface LegacyTrackerRow {
  id: string;
  systemId: number;
  role: string;
  displayName: string;
  enabled: boolean;
  signalKind: string;
  signalSystemId: number;
  signalPointId: number;
  lowerW: number | null;
  upperW: number | null;
  hysteresisW: number | null;
  energySystemId: number | null;
  energyPointId: number | null;
  delayOnSeconds: number | null;
  delayOffSeconds: number | null;
  detectorVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The `device_run_periods` columns the fill consumes. */
export interface LegacyRunPeriodRow {
  systemId: number;
  role: string;
  startTime: Date;
  endTime: Date | null;
  durationSeconds: number | null;
  energyKwh: number | null;
  maxPowerW: number | null;
  minPowerW: number | null;
  avgPowerW: number | null;
  sampleCount: number;
  detectorVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DerivationInsert {
  id: string;
  areaId: string;
  kind: string;
  role: string | null;
  name: string;
  enabled: boolean;
  output: string;
  outputPointId: string | null;
  params: RunDetectorParams;
  sourcePoints: RunDetectorSourcePoints;
  detectorVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DerivedIntervalInsert {
  derivationId: string;
  startTime: Date;
  endTime: Date | null;
  durationSeconds: number | null;
  energyKwh: number | null;
  maxPowerW: number | null;
  minPowerW: number | null;
  avgPowerW: number | null;
  sampleCount: number;
  detectorVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export class FillMappingError extends Error {}

/** Look up a point's uuid by its legacy (system_id, index) address. */
export type PointUidLookup = (systemId: number, index: number) => string | null;

/**
 * Build the sparse `params` for a run detector. Thresholds are copied whenever present (they have
 * no default); the anti-flap knobs only when the legacy column was non-NULL.
 */
export function buildRunDetectorParams(t: LegacyTrackerRow): RunDetectorParams {
  const params: RunDetectorParams = {
    signalKind: "power-threshold",
  };
  if (t.signalKind !== "power-threshold") {
    throw new FillMappingError(
      `tracker ${t.id}: unsupported signal_kind ${JSON.stringify(t.signalKind)}`,
    );
  }
  if (t.lowerW != null) params.lowerW = t.lowerW;
  if (t.upperW != null) params.upperW = t.upperW;
  if (t.hysteresisW != null) params.hysteresisW = t.hysteresisW;
  if (t.delayOnSeconds != null) params.delayOnSeconds = t.delayOnSeconds;
  if (t.delayOffSeconds != null) params.delayOffSeconds = t.delayOffSeconds;
  if (params.lowerW == null && params.upperW == null) {
    throw new FillMappingError(
      `tracker ${t.id}: neither lower_w nor upper_w set — the detector has no threshold`,
    );
  }
  return params;
}

/** Map one `device_trackers` row onto its `derivations` row. */
export function mapTrackerToDerivation(
  t: LegacyTrackerRow,
  areaId: string,
  pointUid: PointUidLookup,
): DerivationInsert {
  const signal = pointUid(t.signalSystemId, t.signalPointId);
  if (!signal) {
    throw new FillMappingError(
      `tracker ${t.id}: signal point (${t.signalSystemId}, ${t.signalPointId}) has no point_uid`,
    );
  }
  let energy: string | null = null;
  if (t.energySystemId != null && t.energyPointId != null) {
    energy = pointUid(t.energySystemId, t.energyPointId);
    if (!energy) {
      throw new FillMappingError(
        `tracker ${t.id}: energy point (${t.energySystemId}, ${t.energyPointId}) has no point_uid`,
      );
    }
  }
  return {
    id: deriveDerivationId(areaId, RUN_DETECTOR_KIND, t.role),
    areaId,
    kind: RUN_DETECTOR_KIND,
    role: t.role,
    name: t.displayName,
    enabled: t.enabled,
    output: "intervals",
    outputPointId: null,
    params: buildRunDetectorParams(t),
    sourcePoints: { signal, energy },
    detectorVersion: t.detectorVersion,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Map one `device_run_periods` row onto its `derived_intervals` row. Stats copy verbatim. */
export function mapRunPeriodToInterval(
  r: LegacyRunPeriodRow,
  derivationId: string,
): DerivedIntervalInsert {
  return {
    derivationId,
    startTime: r.startTime,
    endTime: r.endTime,
    durationSeconds: r.durationSeconds,
    energyKwh: r.energyKwh,
    maxPowerW: r.maxPowerW,
    minPowerW: r.minPowerW,
    avgPowerW: r.avgPowerW,
    sampleCount: r.sampleCount,
    detectorVersion: r.detectorVersion,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
