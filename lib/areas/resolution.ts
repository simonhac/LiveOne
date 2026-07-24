import { asc, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaBindings, areas, pointInfo } from "@/lib/db/planetscale/schema";
import { Area, Point, type AreaId, type PointId } from "@/lib/ids";
import { getAreaDeviceSystemIds } from "./devices";
import { RESOLUTION_SLOTS } from "./slots";
import type { AreaConfig } from "./types";

export type ResolutionMode = "explicit" | "auto" | "config" | "absent";
export type ResolutionReason = "ambiguous" | "inactive" | "missing";
export type ResolutionProducer =
  | { kind: "point"; id: PointId }
  | { kind: "config"; key: string }
  | null;

export interface AreaResolutionSlot {
  slot: string;
  role: string;
  metricType: string;
  mode: ResolutionMode;
  available: boolean;
  producer: ResolutionProducer;
  reason?: ResolutionReason;
  candidates?: PointId[];
}

export interface ResolutionCandidate {
  systemId: number;
  index: number;
  id: PointId;
  logicalPathStem: string | null;
  metricType: string;
  active: boolean;
}

export interface ResolutionBinding {
  pointSystemId: number;
  pointId: number;
  role: string;
  metricType: string;
  priority: number;
}

/** Pure deterministic resolver, exported so precedence/ambiguity are exhaustively testable. */
export function resolveSlotsFromData(
  points: ResolutionCandidate[],
  bindingRows: ResolutionBinding[],
  config: AreaConfig | null,
): AreaResolutionSlot[] {
  const byAddr = new Map(
    points.map((point) => [`${point.systemId}.${point.index}`, point]),
  );
  return RESOLUTION_SLOTS.map((definition): AreaResolutionSlot => {
    const explicit = bindingRows
      .filter((binding) => binding.role === definition.role)
      .map((binding) => ({
        binding,
        point: byAddr.get(`${binding.pointSystemId}.${binding.pointId}`),
      }))
      .filter(
        (entry): entry is typeof entry & { point: ResolutionCandidate } =>
          entry.point != null &&
          entry.binding.metricType === entry.point.metricType &&
          definition.matches(entry.point),
      )
      .sort(
        (a, b) =>
          a.binding.priority - b.binding.priority ||
          a.point.id.localeCompare(b.point.id),
      )[0];
    if (explicit) {
      return {
        slot: definition.slot,
        role: definition.role,
        metricType: definition.metricType,
        mode: "explicit",
        available: explicit.point.active,
        producer: { kind: "point", id: explicit.point.id },
        ...(explicit.point.active ? {} : { reason: "inactive" as const }),
      };
    }

    const candidates = points
      .filter((point) => definition.matches(point))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (candidates.length === 1) {
      const point = candidates[0];
      return {
        slot: definition.slot,
        role: definition.role,
        metricType: definition.metricType,
        mode: "auto",
        available: point.active,
        producer: { kind: "point", id: point.id },
        ...(point.active ? {} : { reason: "inactive" as const }),
      };
    }
    if (candidates.length > 1) {
      return {
        slot: definition.slot,
        role: definition.role,
        metricType: definition.metricType,
        mode: "absent",
        available: false,
        producer: null,
        reason: "ambiguous",
        candidates: candidates.map((point) => point.id),
      };
    }
    if (definition.config?.available(config)) {
      return {
        slot: definition.slot,
        role: definition.role,
        metricType: definition.metricType,
        mode: "config",
        available: true,
        producer: { kind: "config", key: definition.config.key },
      };
    }
    return {
      slot: definition.slot,
      role: definition.role,
      metricType: definition.metricType,
      mode: "absent",
      available: false,
      producer: null,
      reason: "missing",
    };
  });
}

export async function resolveAreaSlots(
  areaUuid: string,
  legacyHandle: number,
): Promise<{ areaId: AreaId; slots: AreaResolutionSlot[] }> {
  const db = requirePlanetscaleDb();
  const [area] = await db
    .select({ id: areas.id, config: areas.config })
    .from(areas)
    .where(eq(areas.id, areaUuid))
    .limit(1);
  if (!area) throw new Error(`Area not found: ${areaUuid}`);
  const members = await getAreaDeviceSystemIds(areaUuid);
  const memberIds = members.length > 0 ? members : [legacyHandle];
  const [pointRows, bindingRows] = await Promise.all([
    db
      .select({
        systemId: pointInfo.systemId,
        index: pointInfo.index,
        pointUid: pointInfo.pointUid,
        logicalPathStem: pointInfo.logicalPathStem,
        metricType: pointInfo.metricType,
        active: pointInfo.active,
      })
      .from(pointInfo)
      .where(inArray(pointInfo.systemId, memberIds)),
    db
      .select({
        pointSystemId: areaBindings.pointSystemId,
        pointId: areaBindings.pointId,
        role: areaBindings.role,
        metricType: areaBindings.metricType,
        priority: areaBindings.priority,
      })
      .from(areaBindings)
      .where(eq(areaBindings.areaId, areaUuid))
      .orderBy(
        asc(areaBindings.role),
        asc(areaBindings.metricType),
        asc(areaBindings.priority),
        asc(areaBindings.id),
      ),
  ]);
  const points: ResolutionCandidate[] = pointRows.map((point) => ({
    systemId: point.systemId,
    index: point.index,
    id: Point.encode(point.pointUid),
    logicalPathStem: point.logicalPathStem,
    metricType: point.metricType,
    active: point.active,
  }));
  const slots = resolveSlotsFromData(points, bindingRows, area.config);
  return { areaId: Area.encode(area.id), slots };
}
