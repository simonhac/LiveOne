/**
 * Server-safe (React-free) helpers for deciding whether a dashboard hosts a component that can
 * "travel" through time — i.e. reads the shared temporal window (`?period/?start/?end`) — and which
 * area's timezone the single page-header navigator should format its label in.
 *
 * The predicate mirrors the render/collapse logic in `components/dashboard/v4/node-view.tsx` + the
 * card plugins, keyed on the SAME `chartCapable` flag the renderer gates the site charts on, so
 * navigator visibility always matches what actually renders (incl. on `/device`, where the document
 * binds a device and no area, so `chartCapable` is unknowable — the site charts don't render there
 * either, while the standalone lines chart still does).
 *
 * config-v4 Phase 14 stage 9: both walk a `DashboardV4`. The v3 `tiles` card became a structural
 * `row` group, so its two time-travelling views (`hotWater`, `renewables`) are now ordinary sibling
 * card nodes and need no special case — the walk is uniform over card types.
 *
 * The walk is written out rather than delegated to `walkNodes` (v4.ts) because both questions need
 * two things a bare pre-order visit does not carry: the INHERITED area binding (§8.1), and pruning
 * of hidden SUBTREES — a hidden group hides its children, which `walkNodes` would still visit.
 */
import type { DashboardV4, DashboardNode, CardNode } from "@/lib/dashboard/v4";
import type { AreaId } from "@/lib/ids";
import type { ReadableArea } from "@/lib/areas/list";

/** Does this card read the shared temporal window (render or consume it)? */
function cardTravels(node: CardNode, chartCapable: boolean): boolean {
  switch (node.type) {
    case "chart":
      // The lines variant mounts immediately (rendered its own navigator today); the stacked-areas
      // variant folds into SiteChartsGroup, which only renders when the area is chartCapable.
      return (node.config as { variant?: string } | undefined)?.variant ===
        "stacked-areas"
        ? chartCapable
        : true;
    case "sankey":
      return chartCapable; // SiteChartsGroup, gated on chartCapable
    case "generator-runs":
      return true; // consumes the shared window
    // hotWater renders the shared window's sparkline; renewables (the Home Energy card) reduces the
    // window's attributed flow. Either one means the navigator has to be there.
    case "hotWater":
    case "renewables":
      return true;
    default:
      return false;
  }
}

/**
 * Visit every VISIBLE node depth-first, with its inherited area binding (§8.1). A hidden node prunes
 * its whole subtree. `visit` returning true stops the walk (and is returned).
 */
function walkVisible(
  doc: DashboardV4,
  visit: (node: DashboardNode, area: AreaId | undefined) => boolean,
): boolean {
  const recur = (
    node: DashboardNode,
    inherited: AreaId | undefined,
  ): boolean => {
    if (node.hidden) return false;
    const area = node.area ?? inherited;
    if (visit(node, area)) return true;
    if (node.kind === "group") {
      for (const child of node.children) if (recur(child, area)) return true;
    }
    return false;
  };
  return recur(doc.root, undefined);
}

/** True when at least one visible card reads the shared temporal window. */
export function hasTimeTravelingCard(
  doc: DashboardV4,
  areaById: Map<string, ReadableArea>,
): boolean {
  return walkVisible(doc, (node, area) => {
    if (node.kind !== "card") return false;
    const capable = area ? !!areaById.get(area)?.chartCapable : false;
    return cardTravels(node, capable);
  });
}

/**
 * The handle whose timezone the header navigator formats its label in — the first visible node that
 * binds an area, resolved to that area's handle. Undefined while the areas are still resolving (the
 * navigator holds until then), or when the document binds no area at all (a `/device` doc, which
 * supplies its own handle instead).
 */
export function primaryHandle(
  doc: DashboardV4,
  areaById: Map<string, ReadableArea>,
): number | undefined {
  let handle: number | undefined;
  walkVisible(doc, (_node, area) => {
    if (!area) return false;
    handle = areaById.get(area)?.legacySystemId;
    return true; // first area binding wins, resolvable or not (matches the v3 first-section rule)
  });
  return handle;
}
