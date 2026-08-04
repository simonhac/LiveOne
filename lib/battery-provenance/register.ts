/**
 * Register the derived battery-provenance BLEND points for a device — the HWS/run-tracking derived-point
 * pattern (a normal `point_info` row + its own agg_5m + KV latest; NO new table/API/flag). Six points,
 * all on stem `bidi.battery`, describe "the energy currently in the battery":
 *   bidi.battery/carbon-intensity        (gCO2/kWh)
 *   bidi.battery/renewable-fraction      (%)
 *   bidi.battery/self-renewable-fraction (%)      — behind-the-meter AND renewable (Qsr/E)
 *   bidi.battery/price                   (c/kWh)  — ACTUAL (out-of-pocket) cost basis
 *   bidi.battery/price-opportunity  (c/kWh)  — forgone export revenue component (Qf/E, ≥ 0)
 *   bidi.battery/stored-energy      (kWh)    — usable stored energy (E); the totals the Contents card
 *                                              shows are `intensity × stored-energy`, reconstructed exactly.
 * Their existence is what enables the recompute (lib/db/planetscale/battery-provenance-pg.ts). The device
 * must have a `bidi.battery` power point (the battery signal) to be eligible.
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaBindings, devices, points } from "@/lib/db/planetscale/schema";
import { mintPoint } from "@/lib/point/mint-point";
import { refreshServingForMintedPoints } from "@/lib/kv-cache-manager";

const BATTERY_STEM = "bidi.battery";

export interface BlendPointSpec {
  metricType: string;
  metricUnit: string;
  displayName: string;
}

/** The derived blend points (keyed by metricType within the `bidi.battery` stem). All written per
 *  interval by the blend loop from the same `FoldStep` (unlike EFFICIENCY_POINT, written by the η shell). */
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
    metricType: "self-renewable-fraction",
    metricUnit: "%",
    displayName: "Battery Self-Renewable %",
  },
  {
    metricType: "price",
    metricUnit: "cents_kWh",
    displayName: "Battery Energy Cost",
  },
  {
    metricType: "price-opportunity",
    metricUnit: "cents_kWh",
    displayName: "Battery Opportunity Cost",
  },
  {
    metricType: "stored-energy",
    metricUnit: "kWh",
    displayName: "Battery Usable Energy",
  },
];

/**
 * LEGACY param-point specs — the four learned battery DEVICE PARAMETERS (η / C / η_c / idle) used to be
 * persisted as helper points under these metricTypes (ordinals 110-113). The learn now writes them into
 * `battery_provenance_daily` (natural units — ratios, not the points' ×100 percent) and the loader /
 * soc-meter monitor read the table, so these points are never created or written anymore. The specs are
 * kept ONLY as the canonical record of the legacy surface — the cleanup script
 * The completed legacy-param cleanup keyed its deletions on these metricTypes.
 */
export const EFFICIENCY_POINT: BlendPointSpec = {
  metricType: "round-trip-efficiency",
  metricUnit: "%",
  displayName: "Battery Round-trip Efficiency",
};
export const CAPACITY_POINT: BlendPointSpec = {
  metricType: "usable-capacity",
  metricUnit: "kWh",
  displayName: "Battery Usable Capacity",
};
export const CHARGE_EFFICIENCY_POINT: BlendPointSpec = {
  metricType: "charge-efficiency",
  metricUnit: "%",
  displayName: "Battery Charge Efficiency",
};
export const IDLE_LOSS_POINT: BlendPointSpec = {
  metricType: "idle-loss",
  metricUnit: "kWh/day",
  displayName: "Battery Idle Loss",
};

export interface EnsureBlendResult {
  status: "created" | "exists" | "no-battery-point" | "mixed";
  systemId: number;
  /** metricType → point index, for the recompute to write into. */
  pointIds: Record<string, number>;
  /**
   * metricType → `point_info.point_uid`. The identity half of `pointIds`, carried so callers never have
   * to round-trip the registry for a point they just ensured — it is what `area_bindings.point_uid` and
   * the agg_5m write both need. Same key set as `pointIds`.
   */
  pointUids: Record<string, string>;
}

/**
 * Ensure the three blend points exist on `systemId`. Idempotent (keyed by stem+metricType). Refuses if
 * the device has no `bidi.battery` power point. With `apply=false`, reports what it would do (dry run).
 */
export async function ensureBatteryProvenancePoints(
  systemId: number,
  apply: boolean,
  opts: { requireBatteryPoint?: boolean } = {},
): Promise<EnsureBlendResult> {
  const db = requirePlanetscaleDb();

  // A physical battery device must carry a `bidi.battery` power point to be eligible. The HELPER device
  // (which actually owns the blend points) has none by design, so the recompute passes false — eligibility
  // is already enforced upstream (the Area has a bound battery).
  if (opts.requireBatteryPoint !== false) {
    const [power] = await db
      .select({ rid: points.rid })
      .from(points)
      .innerJoin(devices, eq(devices.id, points.deviceId))
      .where(
        and(
          eq(devices.rid, systemId),
          eq(points.logicalPath, BATTERY_STEM),
          eq(points.metricType, "power"),
          eq(points.active, true),
        ),
      )
      .limit(1);
    if (!power)
      return {
        status: "no-battery-point",
        systemId,
        pointIds: {},
        pointUids: {},
      };
  }

  const existing = await db
    .select({
      rid: points.rid,
      pointUid: points.id,
      metricType: points.metricType,
      displayName: points.name,
      defaultName: points.defaultName,
    })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(eq(devices.rid, systemId), eq(points.logicalPath, BATTERY_STEM)),
    );
  const byMetric = new Map(existing.map((e) => [e.metricType, e]));

  const pointIds: Record<string, number> = {};
  const pointUids: Record<string, string> = {};
  const missing = BLEND_POINTS.filter((p) => !byMetric.has(p.metricType));
  for (const p of BLEND_POINTS) {
    const row = byMetric.get(p.metricType);
    if (row !== undefined) {
      pointIds[p.metricType] = row.rid;
      pointUids[p.metricType] = row.pointUid;
    }
  }

  // Reconcile display names on EXISTING rows when the spec's name changed — but only rows the user never
  // customised (displayName still === defaultName). Runs on every recompute, so a spec rename propagates
  // everywhere without manual SQL.
  if (apply) {
    for (const p of BLEND_POINTS) {
      const row = existing.find((e) => e.metricType === p.metricType);
      if (
        row &&
        row.displayName === row.defaultName &&
        row.defaultName !== p.displayName
      ) {
        // config-v4 Phase 12 terminal window: writes `points` DIRECTLY. This rename originally wrote
        // `point_info` ONLY — the third instance of slice A2's leak class (an unmirrored point_info
        // UPDATE, which silently drifted `points.name`); slice M added the mirror, and dropping
        // `point_info` removes the second home altogether, so neither the mirror nor the transaction is
        // needed. `row.pointUid` is `points.id`, so the predicate names the row by its PRIMARY KEY — no
        // rid/index ambiguity of the kind that trap was about.
        await db
          .update(points)
          .set({ name: p.displayName, defaultName: p.displayName })
          .where(eq(points.id, row.pointUid));
      }
    }
  }

  if (missing.length === 0)
    return { status: "exists", systemId, pointIds, pointUids };
  if (!apply) {
    return {
      status: Object.keys(pointIds).length > 0 ? "mixed" : "created",
      systemId,
      pointIds,
      pointUids,
    };
  }

  // config-v4 slice M: no allocator. `mintPoint` takes identity (uid + rid) from `points`' own sequence
  // and writes `point_info` behind it with index == rid — so these indices are no longer contiguous, and
  // the max(index)+1 scan this replaced (which never mirrored into `points`) is gone.
  for (const p of missing) {
    const row = await mintPoint(systemId, {
      physicalPathTail: `derived/${BATTERY_STEM}/${p.metricType}`,
      logicalPathStem: BATTERY_STEM,
      metricType: p.metricType,
      metricUnit: p.metricUnit,
      defaultName: p.displayName,
      subsystem: "battery",
    });
    // `rid`, matching the existing-row branch above. Equal to `index` for a freshly minted row (slice M
    // writes index == rid) but the rid is the field that survives PR 2.
    pointIds[p.metricType] = row.rid;
    pointUids[p.metricType] = row.pointUid;
  }
  // Once for the whole batch: fresh mints are absent from the KV serving registry until it is
  // rebuilt, so their values would reach the device hash but no Area hash.
  await refreshServingForMintedPoints("battery-provenance/ensureBlendPoints");

  return { status: "created", systemId, pointIds, pointUids };
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
  pointUids: Record<string, string>,
): Promise<{ created: number }> {
  const db = requirePlanetscaleDb();
  const values = BLEND_POINTS.filter(
    (p) => pointUids[p.metricType] !== undefined,
  ).map((p, i) => ({
    areaId,
    role: "battery",
    metricType: p.metricType,
    pointUid: pointUids[p.metricType],
    ordinal: 100 + i,
    priority: 100 + i,
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
