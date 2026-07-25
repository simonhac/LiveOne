import type { PointId } from "@/lib/ids";
import type { Agg5mInsert } from "@/lib/readings";

export interface OeBulkPointTarget {
  point: PointId;
  metricType: string;
  transform: string | null;
}

export function toAgg5mInsert(
  reading: {
    pointMetadata: { physicalPathTail: string };
    rawValue: unknown;
    intervalEndMs: number;
  },
  targets: ReadonlyMap<string, OeBulkPointTarget>,
): Agg5mInsert | null {
  const point = targets.get(reading.pointMetadata.physicalPathTail);
  if (!point) return null;
  const num = reading.rawValue == null ? null : Number(reading.rawValue);
  const isError = num == null || Number.isNaN(num);
  const value = isError ? null : (num as number);
  const isEnergyCounter =
    point.metricType === "energy" && point.transform === "d";
  const isEnergyDelta =
    point.metricType === "energy" && point.transform !== "d";
  const scalar = !isError && !isEnergyCounter && !isEnergyDelta ? value : null;
  return {
    point: point.point,
    intervalEndMs: reading.intervalEndMs,
    sessionId: null,
    avg: scalar,
    min: scalar,
    max: scalar,
    last: isEnergyCounter ? value : isEnergyDelta ? null : scalar,
    delta: isEnergyDelta ? value : null,
    valueStr: null,
    sampleCount: isError ? 0 : 1,
    errorCount: isError ? 1 : 0,
    dataQuality: "actual",
  };
}
