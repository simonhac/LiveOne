/**
 * Register the derived battery-provenance BLEND points for a system — the HWS/run-tracking derived-point
 * pattern (a normal `point_info` row + its own agg_5m + KV latest; NO new table/API/flag). Three points,
 * all on stem `bidi.battery`, describe "the energy currently in the battery":
 *   bidi.battery/carbon-intensity  (gCO2/kWh)
 *   bidi.battery/renewable-fraction (%)
 *   bidi.battery/price             (c/kWh)
 * Their existence is what enables the recompute (lib/db/planetscale/battery-provenance-pg.ts). The system
 * must have a `bidi.battery` power point (the battery signal) to be eligible.
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaBindings, pointInfo } from "@/lib/db/planetscale/schema";

const BATTERY_STEM = "bidi.battery";

export interface BlendPointSpec {
  metricType: string;
  metricUnit: string;
  displayName: string;
}

/** The three derived blend points (keyed by metricType within the `bidi.battery` stem). */
export const BLEND_POINTS: BlendPointSpec[] = [
  {
    metricType: "carbon-intensity",
    metricUnit: "gCO2/kWh",
    displayName: "Battery Carbon Intensity",
  },
  {
    metricType: "renewable-fraction",
    metricUnit: "%",
    displayName: "Battery Renewable %",
  },
  {
    metricType: "price",
    metricUnit: "cents_kWh",
    displayName: "Battery Energy Price",
  },
];

export interface EnsureBlendResult {
  status: "created" | "exists" | "no-battery-point" | "mixed";
  systemId: number;
  /** metricType → point index, for the recompute to write into. */
  pointIds: Record<string, number>;
}

/**
 * Ensure the three blend points exist on `systemId`. Idempotent (keyed by stem+metricType). Refuses if
 * the system has no `bidi.battery` power point. With `apply=false`, reports what it would do (dry run).
 */
export async function ensureBatteryProvenancePoints(
  systemId: number,
  apply: boolean,
  opts: { requireBatteryPoint?: boolean } = {},
): Promise<EnsureBlendResult> {
  const db = requirePlanetscaleDb();

  // A physical battery system must carry a `bidi.battery` power point to be eligible. The HELPER device
  // (which actually owns the blend points) has none by design, so the recompute passes false — eligibility
  // is already enforced upstream (the Area has a bound battery).
  if (opts.requireBatteryPoint !== false) {
    const [power] = await db
      .select({ index: pointInfo.index })
      .from(pointInfo)
      .where(
        and(
          eq(pointInfo.systemId, systemId),
          eq(pointInfo.logicalPathStem, BATTERY_STEM),
          eq(pointInfo.metricType, "power"),
          eq(pointInfo.active, true),
        ),
      )
      .limit(1);
    if (!power) return { status: "no-battery-point", systemId, pointIds: {} };
  }

  const existing = await db
    .select({ index: pointInfo.index, metricType: pointInfo.metricType })
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        eq(pointInfo.logicalPathStem, BATTERY_STEM),
      ),
    );
  const byMetric = new Map(existing.map((e) => [e.metricType, e.index]));

  const pointIds: Record<string, number> = {};
  const missing = BLEND_POINTS.filter((p) => !byMetric.has(p.metricType));
  for (const p of BLEND_POINTS) {
    const idx = byMetric.get(p.metricType);
    if (idx !== undefined) pointIds[p.metricType] = idx;
  }

  if (missing.length === 0) return { status: "exists", systemId, pointIds };
  if (!apply) {
    return {
      status: Object.keys(pointIds).length > 0 ? "mixed" : "created",
      systemId,
      pointIds,
    };
  }

  // Allocate contiguous next indices for the missing points — from the max index over ALL points on the
  // system (not just bidi.battery), since (system_id, id) is the primary key. Point indices are 1-based
  // (PointReference.fromIds rejects <= 0), so a FRESH system (e.g. a new helper device) starts at 1.
  const allIdx = await db
    .select({ index: pointInfo.index })
    .from(pointInfo)
    .where(eq(pointInfo.systemId, systemId));
  let nextIndex = Math.max(...allIdx.map((p) => p.index), 0) + 1;
  for (const p of missing) {
    const [row] = await db
      .insert(pointInfo)
      .values({
        systemId,
        index: nextIndex++,
        physicalPathTail: `derived/${BATTERY_STEM}/${p.metricType}`,
        logicalPathStem: BATTERY_STEM,
        metricType: p.metricType,
        metricUnit: p.metricUnit,
        defaultName: p.displayName,
        displayName: p.displayName,
        subsystem: "battery",
        transform: null,
        active: true,
        createdAt: new Date(),
      })
      .returning({ index: pointInfo.index });
    pointIds[p.metricType] = row.index;
  }

  return { status: "created", systemId, pointIds };
}

/**
 * Bind the helper's 3 blend points into the Area (`area_bindings`) so they (a) fan out to the Area's KV
 * latest and (b) appear in the Area's resolved point set — a bindings-backed Area is invisible to unbound
 * member points. Bound under `role='battery'` (a valid FK anchor); INERT to the compute/Sankey paths (the
 * loader reads only power/soc/rate/energy; the flow resolver is power-only) so there's no feedback loop.
 * Idempotent. Returns how many bindings were newly created (caller rebuilds the KV subscription registry
 * only when > 0).
 */
export async function ensureHelperBindings(
  areaId: string,
  helperSystemId: number,
  pointIds: Record<string, number>,
): Promise<{ created: number }> {
  const db = requirePlanetscaleDb();
  const values = BLEND_POINTS.filter(
    (p) => pointIds[p.metricType] !== undefined,
  ).map((p, i) => ({
    areaId,
    role: "battery",
    metricType: p.metricType,
    pointSystemId: helperSystemId,
    pointId: pointIds[p.metricType],
    ordinal: 100 + i,
    transform: null,
  }));
  if (values.length === 0) return { created: 0 };
  const inserted = await db
    .insert(areaBindings)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: areaBindings.id });
  return { created: inserted.length };
}
