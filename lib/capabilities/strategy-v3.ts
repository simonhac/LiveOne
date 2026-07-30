/**
 * 🛑 TEMPORARY — the v3 projection of the v4 area strategy. DELETE ME.
 *
 * `buildAreaStrategy` emits a v4 `GroupNode` natively (config-v4 Phase 14 stage 8). Three consumers
 * still speak v3 and are removed by the two PRs that follow:
 *   - `app/device/[...slug]/page.tsx` → the v3 renderer (`components/Dashboard.tsx`)  — stage 9
 *   - `GET /api/areas/{areaId}/default-section` and `POST /api/dashboards` (descriptor) — stage 13
 * When the last of them goes, this file and `buildAreaStrategyV3ForHandle` go with it.
 *
 * It is the exact inverse of `rewriteV3ToV4`'s mapping over the narrow shape the strategy emits (a
 * heading group whose children are leaf cards plus at most one `row` group of tile cards) — NOT a
 * general v4→v3 rewriter. Two things the v4 shape does not carry are re-derived here so the v3 output
 * is byte-identical to the pre-Phase-14 builder's:
 *   - `section.areaId` — a raw string (a uuid, or `/device/{id}`'s synthetic `device-{id}` key), passed
 *     back in verbatim rather than decoded from the group's `ar_` envelope.
 *   - `card.id` on chart cards (`chart:lines` / `chart:load` / `chart:generation`) — the v3 React key.
 *     v4 node ids are server-assigned `n_…` (§8.2), so the strategy deliberately does not smuggle the
 *     v3 id into the doc; it is re-derived from the chart config, which is what named it.
 */
import type { DeviceId } from "@/lib/ids";
import type { GroupNode, DashboardNode } from "@/lib/dashboard/v4";
import type { DeviceMetricsConfig } from "@/lib/dashboard/card-types";
import type {
  CardV3,
  ChartCardConfig,
  DashboardV3,
  TileV3,
} from "@/lib/dashboard/v3";
import type { DashboardCardType } from "@/lib/dashboard/cards";
// The tile vocabulary lives in card-types.ts since Phase 14 stage 4 (#308) — v3.ts imports it, so it
// cannot be re-imported from there.
import type { TileView } from "@/lib/dashboard/card-types";

export interface StrategyV3ProjectionOptions {
  /** The raw `section.areaId` the v3 consumers expect (uuid, or the `/device/{id}` synthetic key). */
  areaId: string;
  /** The `dv_` → legacy `system_id` pairs the strategy pinned (today: the OE grid device, or none). */
  handleForDevice: ReadonlyMap<DeviceId, number>;
}

/** The v3 card id the pre-v4 strategy gave each chart — derived from the chart config that named it. */
function chartIdFor(chart: ChartCardConfig): string {
  if (chart.variant === "lines") return "chart:lines";
  return chart.split === "generation" ? "chart:generation" : "chart:load";
}

function deviceSystemId(
  node: { device?: DeviceId },
  opts: StrategyV3ProjectionOptions,
): number | undefined {
  return node.device ? opts.handleForDevice.get(node.device) : undefined;
}

function toTileV3(
  node: DashboardNode,
  opts: StrategyV3ProjectionOptions,
): TileV3 {
  if (node.kind !== "card") {
    throw new TypeError("area strategy: a tiles row may only hold card nodes");
  }
  const handle = deviceSystemId(node, opts);
  return {
    view: node.type as TileView,
    ...(handle != null ? { deviceSystemId: handle } : {}),
  };
}

function toCardV3(
  node: DashboardNode,
  opts: StrategyV3ProjectionOptions,
): CardV3 {
  if (node.kind === "group") {
    return {
      type: "tiles",
      tiles: node.children.map((child) => toTileV3(child, opts)),
    };
  }
  // The strategy only ever emits known card types, so the open v4 `type` narrows safely here.
  const type = node.type as DashboardCardType;
  if (type === "chart") {
    const chart = node.config as ChartCardConfig;
    return { type, id: chartIdFor(chart), chart };
  }
  const handle = deviceSystemId(node, opts);
  const variant = (node.config as DeviceMetricsConfig | undefined)?.variant;
  return {
    type,
    ...(handle != null ? { deviceSystemId: handle } : {}),
    ...(type === "device-metrics" && variant ? { variant } : {}),
  };
}

/** Project an area strategy group back onto the v3 descriptor the legacy consumers still read. */
export function areaStrategyGroupToV3(
  group: GroupNode,
  opts: StrategyV3ProjectionOptions,
): DashboardV3 {
  return {
    version: 3,
    sections: [
      {
        areaId: opts.areaId,
        cards: group.children.map((child) => toCardV3(child, opts)),
      },
    ],
  };
}
