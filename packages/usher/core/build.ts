/**
 * Collector core — construct a self-describing reading set from a source's manifest + a values
 * snapshot. Shared by every source; drops null/undefined values (sensor n/a).
 */

import type { Manifest, Values } from "./source";
import type { PushReading } from "@liveone/protocol";

export function buildReadings(
  manifest: Manifest,
  values: Values,
): PushReading[] {
  const out: PushReading[] = [];
  for (const def of manifest) {
    const v = values[def.key];
    if (v == null) continue; // skip n/a
    out.push({
      physicalPathTail: def.physicalPathTail,
      value: v,
      metricType: def.metricType,
      metricUnit: def.metricUnit,
      logicalPathStem: def.logicalPathStem ?? null,
      defaultName: def.defaultName ?? def.physicalPathTail,
      subsystem: def.subsystem ?? null,
      transform: def.transform ?? null,
    });
  }
  return out;
}
