/**
 * Read the materialised attributed daily flow matrices (`point_readings_flow_attr_1d`) for one Area
 * over a `[startYMD, endYMD]` local-day range, shaped into the {@link DailyFlowMatrices} the Sankey
 * client consumes (energy + the metric legs emissions/renewable/cost/estimated per edge).
 *
 * Originally extracted from the (now-retired) `/api/energy-flow-matrix` route; the sole caller is now
 * the 1d branch of the history API (`?include=sankey`). Pure DB read — no auth, no HTTP.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import { pointReadingsFlowAttr1d } from "@/lib/db/planetscale/schema";
import { toDailyFlowMatrices } from "@/lib/aggregation/flow-node-meta";
import type { LogicalSystem } from "@/lib/aggregation/logical-system";
import type { DailyFlowMatrices } from "@/lib/energy-flow-matrix";

type PgDb = NonNullable<typeof planetscaleDb>;

/**
 * `reason` explains an empty result so a blank Sankey isn't read as "no energy":
 *   - `not-a-logical-system` — no resolvable/complete logical system for the Area.
 *   - `not-materialized` — a complete system, but no `flow_attr_1d` rows in the window yet.
 */
export async function readAttributedDailyMatrices(
  db: PgDb,
  logicalSystem: LogicalSystem | null,
  startYMD: string,
  endYMD: string,
): Promise<DailyFlowMatrices & { reason?: string }> {
  if (!logicalSystem)
    return { sources: [], loads: [], days: [], reason: "not-a-logical-system" };

  const rows = await db
    .select({
      day: pointReadingsFlowAttr1d.day,
      sourcePath: pointReadingsFlowAttr1d.sourcePath,
      loadPath: pointReadingsFlowAttr1d.loadPath,
      energyKwh: pointReadingsFlowAttr1d.energyKwh,
      emissionsG: pointReadingsFlowAttr1d.emissionsG,
      renewableKwh: pointReadingsFlowAttr1d.renewableKwh,
      selfRenewableKwh: pointReadingsFlowAttr1d.selfRenewableKwh,
      costC: pointReadingsFlowAttr1d.costC,
      estimatedKwh: pointReadingsFlowAttr1d.estimatedKwh,
    })
    .from(pointReadingsFlowAttr1d)
    .where(
      and(
        eq(pointReadingsFlowAttr1d.areaId, logicalSystem.areaId),
        gte(pointReadingsFlowAttr1d.day, startYMD),
        lte(pointReadingsFlowAttr1d.day, endYMD),
      ),
    );

  const displayNameByStem = new Map<string, string>();
  for (const p of logicalSystem.points) {
    if (!displayNameByStem.has(p.stem)) {
      displayNameByStem.set(p.stem, p.displayName);
    }
  }

  if (rows.length === 0) {
    const reason = logicalSystem.isComplete
      ? "not-materialized"
      : "not-a-logical-system";
    return { sources: [], loads: [], days: [], reason };
  }

  // includeMetrics=true: also build the emissions/renewable/cost/estimated legs (the modern superset).
  return toDailyFlowMatrices(rows, displayNameByStem, true);
}
