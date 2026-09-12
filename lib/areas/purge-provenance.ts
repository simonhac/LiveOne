/**
 * Retire an Area's DERIVED rows — the two layers `liveone area purge` deletes.
 *
 * ## Why a delete exists at all
 *
 * Every other path here MATERIALISES: `recomputeAreaProvenance` upserts, `device recompute` does a
 * per-day delete-and-reinsert, the crons heal forward. Nothing retires. That is fine while an area
 * stays a site, and wrong the moment one stops being one — an area whose bindings are cleared is no
 * longer flow-eligible, so nothing refreshes its rows AND nothing removes them. They freeze, and
 * keep answering questions. Area 13 ("Kutis") sat for weeks attributing 160.0 kg CO₂ to a house that
 * High Street Kew attributes 155.6 kg to, with `costC` 0, from a member set that no longer exists.
 *
 * ## Two layers, and they are NOT the same risk
 *
 * 🛑 **`point_readings_flow_attr_1d` is not a provenance table — it is the flow matrix wearing a
 * provenance table's name.** `point_readings_flow_1d` was retired into it, so it holds the Sankey
 * for EVERY complete area, battery or not: `energy_kwh` is the energy history, and the metric legs
 * are the attribution laid over it. Deleting a row deletes both; there is no column-level split.
 *
 * And it does not come back on its own. The nightly reheal covers only `REHEAL_TRAILING_MS` (96 h),
 * and `rehealStaleAttrDays` finds work by SELECTING FROM THIS TABLE — so a deleted day is not a
 * stale day it will find, it is a day that has ceased to exist as far as the backlog is concerned.
 * Only an explicit `recompute-provenance` over the range restores it. Hence `purgeFlows` takes a
 * REQUIRED window and its caller prints the restore command.
 *
 * `battery_provenance_daily` + the blend series are the opposite: genuinely disposable.
 * `learnAllForHandle` forces a full rebuild from the fixed anchor whenever the table is empty
 * (`cached.length === 0`), with fixed seeds, so deletion is a supported operation rather than damage.
 * Nothing here needs a window.
 *
 * ## What the helper leg is, and why it needs a join
 *
 * The fold writes six blend points — `bidi.battery/{carbon-intensity, renewable-fraction,
 * self-renewable-fraction, price, price-opportunity, stored-energy}` — onto the Area's HELPER device
 * (vendor `helper`, the "· derived" ones), and binds them at ordinal 100–105. Those readings are
 * `point_rid`-keyed, not `area_id`-keyed, so they are the one layer with no clean `WHERE area_id`:
 * it takes `points ⋈ devices ⋈ area_members`. Nothing in the DAO could delete them — `delete1dRange`
 * is day-ranged and fleet-wide — so `ReadingsDao.deleteAggsForPoints` was added for this. It lives
 * there, not here, because `agg_5m`/`agg_1d` are hot tables behind the readings seam that
 * `scripts/check-readings-boundary.mjs` gates; THIS file resolves which points, the DAO deletes them.
 *
 * 🛑 The helper DEVICE and its POINTS survive. They go inert, and `ensureHelperDevice` /
 * `ensureBatteryProvenancePoints` refill the same `pt_` ids on the next recompute. Dropping the
 * points would change identities that other rows (and any stored reference) address by id, to save
 * nothing — every FK into them is NO ACTION, so it would also have to be done in a forced order.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areaMembers,
  batteryProvenanceDaily,
  devices,
  pointReadingsFlowAttr1d,
  points,
} from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings/dao";
import { BLEND_POINTS } from "@/lib/battery-provenance/register";
import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";

const BLEND_METRICS = BLEND_POINTS.map((p) => p.metricType);

export interface FlowsPurgeReport {
  /** Rows in `point_readings_flow_attr_1d` matched by the window. */
  rows: number;
  /** Distinct local days those rows cover. */
  days: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface ProvenancePurgeReport {
  /** `battery_provenance_daily` rows for the area. */
  dailyRows: number;
  firstDay: string | null;
  lastDay: string | null;
  /** The area's helper device, if it has one. */
  helper: { deviceId: string; name: string; pointRids: number[] } | null;
  /** Blend readings, by table. */
  agg5mRows: number;
  agg1dRows: number;
  /** Blend bindings (`role='battery'` at the six blend metrics). */
  bindings: number;
}

/**
 * The helper device's blend POINT rids for one area.
 *
 * Scoped by `metric_type` as well as by the helper device: a helper carries only blend points today,
 * but `role='battery'` alone would also name the real power/soc/energy bindings if this set were
 * ever used to pick bindings, and the two lookups must not disagree about what "a blend point" is.
 */
async function helperFor(areaUuid: string) {
  const db = requirePlanetscaleDb();
  const [helper] = await db
    .select({ id: devices.id, rid: devices.rid, name: devices.name })
    .from(devices)
    .innerJoin(areaMembers, eq(areaMembers.deviceId, devices.id))
    .where(and(eq(areaMembers.areaId, areaUuid), eq(devices.vendor, "helper")))
    .limit(1);
  if (!helper) return null;

  const rows = await db
    .select({ rid: points.rid })
    .from(points)
    .where(
      and(
        eq(points.deviceId, helper.id),
        inArray(points.metricType, BLEND_METRICS),
      ),
    );
  return {
    deviceId: helper.id,
    name: helper.name,
    pointRids: rows.map((r) => r.rid),
  };
}

/** Count what `purgeFlows` would remove, without removing it. */
export async function inspectFlows(
  areaUuid: string,
  window: { start: string; end: string },
): Promise<FlowsPurgeReport> {
  const db = requirePlanetscaleDb();
  const [row] = await db
    .select({
      rows: sql<number>`count(*)::int`,
      days: sql<number>`count(distinct ${pointReadingsFlowAttr1d.day})::int`,
      firstDay: sql<string | null>`min(${pointReadingsFlowAttr1d.day})`,
      lastDay: sql<string | null>`max(${pointReadingsFlowAttr1d.day})`,
    })
    .from(pointReadingsFlowAttr1d)
    .where(
      and(
        eq(pointReadingsFlowAttr1d.areaId, areaUuid),
        gte(pointReadingsFlowAttr1d.day, window.start),
        lte(pointReadingsFlowAttr1d.day, window.end),
      ),
    );
  return {
    rows: row?.rows ?? 0,
    days: row?.days ?? 0,
    firstDay: row?.firstDay ?? null,
    lastDay: row?.lastDay ?? null,
  };
}

/**
 * Delete an Area's flow matrix over a window of local days.
 *
 * 🛑 The window is required by the SIGNATURE, not merely by the caller — there is no overload that
 * means "everything". The recompute that restores this is per-day and batched, so an unscoped delete
 * would be trivially easy to type and expensive to undo.
 */
export async function purgeFlows(
  areaUuid: string,
  window: { start: string; end: string },
): Promise<FlowsPurgeReport> {
  const before = await inspectFlows(areaUuid, window);
  const db = requirePlanetscaleDb();
  await db
    .delete(pointReadingsFlowAttr1d)
    .where(
      and(
        eq(pointReadingsFlowAttr1d.areaId, areaUuid),
        gte(pointReadingsFlowAttr1d.day, window.start),
        lte(pointReadingsFlowAttr1d.day, window.end),
      ),
    );
  return before;
}

/** Count what `purgeProvenance` would remove, without removing it. */
export async function inspectProvenance(
  areaUuid: string,
): Promise<ProvenancePurgeReport> {
  const db = requirePlanetscaleDb();
  const helper = await helperFor(areaUuid);
  const rids = helper?.pointRids ?? [];

  const [daily] = await db
    .select({
      rows: sql<number>`count(*)::int`,
      firstDay: sql<string | null>`min(${batteryProvenanceDaily.day})`,
      lastDay: sql<string | null>`max(${batteryProvenanceDaily.day})`,
    })
    .from(batteryProvenanceDaily)
    .where(eq(batteryProvenanceDaily.areaId, areaUuid));

  const counts = await ReadingsDao.countAggsForPoints(rids);

  const [bindings] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(areaBindings)
    .where(
      and(
        eq(areaBindings.areaId, areaUuid),
        eq(areaBindings.role, "battery"),
        inArray(areaBindings.metricType, BLEND_METRICS),
      ),
    );

  return {
    dailyRows: daily?.rows ?? 0,
    firstDay: daily?.firstDay ?? null,
    lastDay: daily?.lastDay ?? null,
    helper,
    agg5mRows: counts.agg5m,
    agg1dRows: counts.agg1d,
    bindings: bindings?.n ?? 0,
  };
}

/**
 * Delete an Area's battery provenance: the blend readings, the blend bindings and the fold's own
 * per-day rows (learn inputs, learned params AND the `fold_state` checkpoints).
 *
 * Order matters and is not arbitrary: readings before bindings before the daily rows, so that a
 * failure part-way leaves a state the next recompute can still reason about (bindings pointing at
 * empty points is ordinary warm-up; readings with no bindings is invisible to every reader).
 *
 * Finally rebuilds the subscription registry, so `gcAreaLatestFields` drops the now-unserved
 * `bidi.battery/*` fields from KV. Without that the last blend value stays frozen in the latest map
 * forever — deleting rows out of Postgres does not touch KV, and the cache has no other GC.
 */
export async function purgeProvenance(
  areaUuid: string,
): Promise<ProvenancePurgeReport> {
  const before = await inspectProvenance(areaUuid);
  const db = requirePlanetscaleDb();
  const rids = before.helper?.pointRids ?? [];

  await ReadingsDao.deleteAggsForPoints(rids);

  await db
    .delete(areaBindings)
    .where(
      and(
        eq(areaBindings.areaId, areaUuid),
        eq(areaBindings.role, "battery"),
        inArray(areaBindings.metricType, BLEND_METRICS),
      ),
    );

  await db
    .delete(batteryProvenanceDaily)
    .where(eq(batteryProvenanceDaily.areaId, areaUuid));

  // Best-effort: the rows are already gone, and a KV rebuild that fails must not make the caller
  // think the delete did not happen. It is reported, not thrown.
  await buildSubscriptionRegistry().catch((e) => {
    console.error("[purgeProvenance] subscription registry rebuild failed", e);
  });

  return before;
}
