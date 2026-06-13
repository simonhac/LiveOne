/**
 * Per-role detector defaults — the behaviour knobs a `device_trackers` row inherits when its
 * own column is null. The threshold bounds (lower/upper) have no sensible default and are always
 * per-instance; these cover the anti-flap / boundary behaviour only.
 *
 * Generator defaults reproduce the legacy generator-events behaviour (120s coalescing, no
 * hysteresis, edge boundaries, no min-run) so the cutover is observable as "same events, now
 * bounded and persisted".
 */

export interface DetectorDefaults {
  hysteresisW: number;
  delayOnMs: number;
  delayOffMs: number;
  boundaryMode: "edge" | "midpoint";
}

const SECOND = 1000;

const GENERATOR_DEFAULTS: DetectorDefaults = {
  hysteresisW: 0,
  delayOnMs: 0,
  delayOffMs: 120 * SECOND,
  boundaryMode: "edge",
};

/** Fallback for any role without explicit defaults (e.g. a future pump). */
const GENERIC_DEFAULTS: DetectorDefaults = {
  hysteresisW: 0,
  delayOnMs: 30 * SECOND,
  delayOffMs: 120 * SECOND,
  boundaryMode: "edge",
};

const DEFAULTS_BY_ROLE: Record<string, DetectorDefaults> = {
  generator: GENERATOR_DEFAULTS,
};

export function detectorDefaultsForRole(role: string): DetectorDefaults {
  return DEFAULTS_BY_ROLE[role] ?? GENERIC_DEFAULTS;
}
