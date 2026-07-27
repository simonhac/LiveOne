/**
 * The read half of the sparse-params contract (the write half is `fill-map.ts`).
 *
 * `derivations.params` stores only what was explicitly configured; everything else inherits the
 * per-role detector defaults. Keeping the merge here — pure, DB-free — means the inheritance rule
 * is unit-testable and has exactly one implementation.
 */
import { detectorDefaultsForRole } from "@/lib/run-tracking/defaults";
import type { RunDetectorParams } from "./resolve";

export interface DetectConfig {
  lowerW: number | null;
  upperW: number | null;
  hysteresisW: number;
  delayOnMs: number;
  delayOffMs: number;
  boundaryMode: "edge" | "midpoint";
}

/**
 * Merge a run detector's sparse `params` over its role defaults. Thresholds stay nullable (they
 * have no default); `boundaryMode` is code-only and always comes from the defaults, exactly as it
 * did when trackers were rows — there was never a column for it.
 */
export function mergeDetectConfig(
  params: RunDetectorParams,
  role: string,
): DetectConfig {
  const defaults = detectorDefaultsForRole(role);
  return {
    lowerW: params.lowerW ?? null,
    upperW: params.upperW ?? null,
    hysteresisW: params.hysteresisW ?? defaults.hysteresisW,
    delayOnMs:
      params.delayOnSeconds != null
        ? params.delayOnSeconds * 1000
        : defaults.delayOnMs,
    delayOffMs:
      params.delayOffSeconds != null
        ? params.delayOffSeconds * 1000
        : defaults.delayOffMs,
    boundaryMode: defaults.boundaryMode,
  };
}
