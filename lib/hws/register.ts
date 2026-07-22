/**
 * Register the derived hot-water temperature point for a system.
 *
 * The modelled faucet temperature lives in the generic readings system as a normal `point_info`
 * row (`load.hws/temperature`, °C) — its existence is what "enables" HWS modelling for a system
 * (the recompute, lib/hws/recompute.ts, finds it and starts producing values). It must have a
 * sibling `load.hws/power` point to model from.
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo } from "@/lib/db/planetscale/schema";
import { mintPointUid } from "@/lib/point/mint-point-uid";

const HWS_STEM = "load.hws";
const TEMP_PHYSICAL_PATH = "derived/load.hws/temperature"; // synthetic, unique per system
const TEMP_UNIT = "°C";
const TEMP_DISPLAY_NAME = "Hot Water";

export interface EnsureResult {
  status: "created" | "exists" | "no-power-point";
  systemId: number;
  tempPointId?: number;
  powerPointId?: number;
}

/**
 * Ensure a `load.hws/temperature` point exists for `systemId`. Idempotent: returns the existing
 * point if present, creates it (next index) otherwise, and refuses if the system has no
 * `load.hws/power` signal point. When `apply` is false, reports what it would do without writing.
 */
export async function ensureHwsTemperaturePoint(
  systemId: number,
  apply: boolean,
): Promise<EnsureResult> {
  const db = requirePlanetscaleDb();

  const [power] = await db
    .select({ index: pointInfo.index })
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        eq(pointInfo.logicalPathStem, HWS_STEM),
        eq(pointInfo.metricType, "power"),
        eq(pointInfo.active, true),
      ),
    )
    .limit(1);
  if (!power) return { status: "no-power-point", systemId };

  const [existing] = await db
    .select({ index: pointInfo.index })
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        eq(pointInfo.logicalPathStem, HWS_STEM),
        eq(pointInfo.metricType, "temperature"),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      status: "exists",
      systemId,
      tempPointId: existing.index,
      powerPointId: power.index,
    };
  }

  if (!apply) {
    return { status: "created", systemId, powerPointId: power.index };
  }

  const all = await db
    .select({ index: pointInfo.index })
    .from(pointInfo)
    .where(eq(pointInfo.systemId, systemId));
  const nextIndex =
    all.length > 0 ? Math.max(...all.map((p) => p.index)) + 1 : 0;

  const [row] = await db
    .insert(pointInfo)
    .values({
      systemId,
      index: nextIndex,
      physicalPathTail: TEMP_PHYSICAL_PATH,
      logicalPathStem: HWS_STEM,
      metricType: "temperature",
      metricUnit: TEMP_UNIT,
      defaultName: TEMP_DISPLAY_NAME,
      displayName: TEMP_DISPLAY_NAME,
      subsystem: null,
      transform: null,
      active: true,
      pointUid: await mintPointUid(systemId, TEMP_PHYSICAL_PATH),
      createdAt: new Date(),
    })
    .returning({ index: pointInfo.index });

  return {
    status: "created",
    systemId,
    tempPointId: row.index,
    powerPointId: power.index,
  };
}
