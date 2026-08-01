"use client";

/**
 * config-v4 dashboard renderer — the recursive v4 node tree. This is the LIVE renderer: since the
 * Phase 8/10 cutover `dashboards.doc` is NOT NULL, so `DashboardClient` always takes this branch.
 *
 * `<DashboardV4View doc>` renders a v4 document (clean-sheet §8) by recursing `<NodeView>`:
 *   - `group` → a layout container; a group with `heading` + a resolved `area` renders the area
 *     header (a v3 "section"); a `row` group is a v3 "tiles" grid — an `@container` grid of equal
 *     columns (lib/dashboard/tile-grid.ts). Its direct card children that are chart/sankey collapse
 *     into ONE <SiteChartsGroup> (the v3 two-pass collapse, ported here and keyed on the GROUP's
 *     area handle).
 *   - `card` → ONE registry lookup (components/dashboard/registry.tsx), then dispatch on the
 *     plugin's own `kind`: a tile plugin renders a self-fetching tile cell, a card plugin is handed
 *     the node + its inherited context. A type with NO plugin — an unknown/future type, or the v3
 *     `tiles` container that became a group — renders a labelled placeholder (§8.4).
 *
 * Context (`area`/`device`) inherits down the tree (§8.1) and is handed to the plugins verbatim.
 * `GroupNode.size` (the 12-column hint) is still unread here — layout is child order + group flow.
 */
import type React from "react";
import type { ReactNode } from "react";
import { Layers, AlertTriangle } from "lucide-react";
import { Area } from "@/lib/ids";
import type { AreaId } from "@/lib/ids";
import {
  type DashboardV4,
  type DashboardNode,
  type GroupNode,
  type CardNode,
} from "@/lib/dashboard/v4";
import type {
  NodeContext,
  ShellResolver,
  ResolvedArea,
  ResolvedDevice,
} from "@/lib/dashboard/resolve-shell";
import type { ReadableArea } from "@/lib/areas/list";
import {
  CARD_RENDERERS,
  type NodePlugin,
} from "@/components/dashboard/registry";
import type { TilePlugin } from "@/components/dashboard/tiles/types";
import {
  useAreaDatum,
  staleThreshold,
  TileSkeleton,
  ChartSkeleton,
} from "@/components/dashboard/cards/shared";
import { SiteChartsGroup } from "@/components/dashboard/cards/site-charts";
import {
  TILE_GRID_CONTAINER,
  tileGridClass,
  tileRowClass,
} from "@/lib/dashboard/tile-grid";

/**
 * The registry, indexed by the document's OPEN `type` string (§8.4). `CARD_RENDERERS` is exhaustive
 * over `KnownCardType`, so a miss here is exactly "this build does not know this type" — the one
 * condition that takes the labelled-placeholder branch. This widening is the whole reason the lookup
 * is safe to do FIRST, before any tile-vs-card question.
 */
const RENDERERS: Record<string, NodePlugin | undefined> = CARD_RENDERERS;

function areaUuidOf(id: AreaId): string | null {
  try {
    return Area.toUuid(id);
  } catch {
    return null;
  }
}

/** Build a client-side ShellResolver from the SSR-authorized area and stable-device maps. */
export function clientShellResolver(
  areaById: Map<string, ReadableArea>,
  deviceById?: Map<string, ResolvedDevice>,
): ShellResolver {
  return {
    area: (id) => {
      // areaById is keyed by `ar_` (DashboardClient's readableAreas — the wire/props form), same as
      // `id` here — key by it directly. areaUuidOf is kept only as a validity guard (malformed `id`
      // never resolves), not for the lookup.
      if (!areaUuidOf(id)) return null;
      const ra = areaById.get(id);
      if (!ra) return null;
      return {
        areaId: id,
        displayName: ra.displayName,
        handle: ra.legacySystemId ?? null,
        chartCapable: !!ra.chartCapable,
      };
    },
    device: (id) => deviceById?.get(id) ?? null,
  };
}

function childContext(
  node: DashboardNode,
  inherited: NodeContext,
): NodeContext {
  return {
    area: node.area ?? inherited.area,
    device: node.device ?? inherited.device,
  };
}

function nodeKey(node: DashboardNode, i: number): string {
  return node.id ?? `${node.kind}-${i}`;
}

/**
 * One tile-view card — mirrors the v3 TilesCard cell (self-fetch, availability gate, plugin mount).
 * The plugin arrives already resolved: the single registry lookup happens once, in `CardNodeView`.
 */
function V4TileCell({
  plugin,
  systemId,
}: {
  plugin: TilePlugin;
  systemId: number;
}) {
  const { data, datum, isLoading } = useAreaDatum(systemId);
  const latest = datum?.latest ?? {};
  if (isLoading) return <TileSkeleton />;
  const showGrid = !!latest["bidi.grid/power"];
  if (!plugin.isAvailable({ latest, data, showGrid })) return null;
  return (
    <plugin.Render
      latest={latest}
      data={data}
      systemId={systemId}
      staleThresholdSeconds={staleThreshold(
        datum?.device?.vendorType ?? "",
        datum?.device?.config?.updateCadenceSeconds,
      )}
      showGrid={showGrid}
      canControl={false}
    />
  );
}

function CardNodeView({
  node,
  context,
  resolver,
  areasResolved,
  sharedSiteData,
}: {
  node: CardNode;
  context: NodeContext;
  resolver: ShellResolver;
  areasResolved: boolean;
  sharedSiteData?: boolean;
}) {
  const area: ResolvedArea | null = context.area
    ? resolver.area(context.area)
    : null;
  const device: ResolvedDevice | null = context.device
    ? resolver.device(context.device)
    : null;
  if (context.device && device == null) return <DeviceUnavailable />;
  // The addressing handle a card plugin fetches with: the inherited AREA's handle, or — when the
  // node inherits no area at all — the inherited DEVICE's. The device fallback is what makes a
  // device-scoped subtree work: `/device/{id}` binds only `device` on its root (there is no area
  // envelope for a device page), and without this every `pending: "host-skeleton"` plugin would be
  // gated off by `handle == null` and render nothing. Area wins where both are bound, which is the
  // v3 rule (the per-card device pin was never the section handle) — see `systemId` below and the
  // plugins' `deviceSystemId`, both of which DO prefer the device.
  const handle = area?.handle ?? device?.systemId ?? null;
  const systemId = context.device ? (device?.systemId ?? null) : handle;

  // ONE lookup for every card node. A miss is an unknown/future type (§8.4): a labelled placeholder
  // — never destroy its opaque config.
  const plugin = RENDERERS[node.type];
  if (!plugin) {
    return (
      <div className="rounded-lg border border-gray-700/70 bg-gray-900/30 px-4 py-3 text-sm text-gray-400">
        Unknown card type <code className="text-gray-300">{node.type}</code>
      </div>
    );
  }

  // Tile plugin → a self-fetching tile cell.
  if (plugin.kind === "tile") {
    if (systemId == null) return <TileSkeleton />;
    return <V4TileCell plugin={plugin} systemId={systemId} />;
  }

  // Card plugin → handed the node + its inherited context.
  if (plugin.pending !== "self" && handle == null) {
    return areasResolved ? null : <ChartSkeleton />;
  }
  return (
    <plugin.Render
      node={node}
      context={context}
      handle={handle ?? undefined}
      deviceSystemId={device?.systemId ?? undefined}
      sharedSiteData={sharedSiteData}
    />
  );
}

/** A card node's site-charts collapse contribution, or null. Tile plugins never collapse. */
function collapseKeyOf(node: DashboardNode): string | null {
  if (node.kind !== "card") return null;
  const plugin = RENDERERS[node.type];
  if (plugin?.kind !== "card") return null;
  return plugin.collapseKey?.(node) ?? null;
}

function GroupNodeView({
  node,
  context,
  resolver,
  dashboardId,
  areasResolved,
}: {
  node: GroupNode;
  context: NodeContext;
  resolver: ShellResolver;
  dashboardId?: string;
  areasResolved: boolean;
}) {
  const nodeContext = childContext(node, context);
  const area: ResolvedArea | null = nodeContext.area
    ? resolver.area(nodeContext.area)
    : null;
  const device: ResolvedDevice | null = nodeContext.device
    ? resolver.device(nodeContext.device)
    : null;
  // Same rule as CardNodeView: area handle, else the inherited device's. This is the handle the
  // collapsed <SiteChartsGroup> fetches with, so a device-scoped group (`/device/{id}`) charts too.
  const handle = area?.handle ?? device?.systemId ?? null;

  if (nodeContext.device && device == null) return <DeviceUnavailable />;

  // A heading group bound to an area that can't be resolved (removed / not readable) → clear notice
  // (matches the v3 "Area unavailable" behaviour), but only once areas are known.
  if (node.heading && nodeContext.area && area == null && areasResolved) {
    return (
      <section className="rounded-lg border border-gray-700/70 bg-gray-900/30 p-2 sm:p-3">
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
          <div>
            <p className="font-medium text-amber-200">Area unavailable</p>
            <p className="mt-0.5 text-amber-200/70">
              This section points to an area that couldn&rsquo;t be loaded — it
              may have been removed, or you don&rsquo;t have access to it.
            </p>
          </div>
        </div>
      </section>
    );
  }

  // Collapse pass 1: gather the site-charts keys of every direct chart/sankey child (v3 collapse,
  // keyed on this group's area handle). Reuses each plugin's own collapseKey, called on the NODE.
  const chartKeys = new Set<string>();
  for (const child of node.children) {
    const k = collapseKeyOf(child);
    if (k != null) chartKeys.add(k);
  }
  // Will a <SiteChartsGroup> actually MOUNT for this group, and will it run its `siteDataQuery`?
  // Mirrors the two gates below exactly: pass 2 emits it only for a non-hidden collapse member with a
  // resolved `handle`, and SiteChartsGroup itself bails on `!chartCapable`. A standalone `lines`
  // chart in this same group reads this to decide whether it can ride that fetch instead of issuing
  // its own `/api/history` for the same window — so it must not be true when nothing drives the
  // query, or the chart would wait forever on a payload nobody fetches. Note `chartKeys` is NOT the
  // right input: it deliberately includes hidden members (they stay addressable via `cardVisible`),
  // and an all-hidden collapse emits no group at all.
  const siteChartsMounted =
    handle != null &&
    !!area?.chartCapable &&
    node.children.some((c) => !c.hidden && collapseKeyOf(c) != null);
  const sankeyChild = node.children.find(
    (c) => c.kind === "card" && c.type === "sankey",
  );
  const areaUuid = nodeContext.area ? areaUuidOf(nodeContext.area) : null;
  const sankeyOptionsKey =
    dashboardId != null && areaUuid
      ? `${sankeyChild?.id ?? "sankey"}:${areaUuid}:${dashboardId}`
      : undefined;

  // Collapse pass 2 + render.
  let chartsEmitted = false;
  const body: ReactNode[] = node.children
    .filter((c) => !c.hidden)
    .map((child, i) => {
      if (collapseKeyOf(child) != null) {
        if (chartsEmitted) return null;
        chartsEmitted = true;
        return handle != null ? (
          <SiteChartsGroup
            key="site-charts"
            systemId={handle}
            keys={chartKeys}
            sankeyOptionsKey={sankeyOptionsKey}
            chartCapable={area?.chartCapable}
          />
        ) : areasResolved ? null : (
          <ChartSkeleton key="site-charts" />
        );
      }
      return (
        <NodeView
          key={nodeKey(child, i)}
          node={child}
          context={nodeContext}
          resolver={resolver}
          dashboardId={dashboardId}
          areasResolved={areasResolved}
          sharedSiteData={siteChartsMounted}
        />
      );
    });

  // A `row` group is a GRID of equal columns, not a flex row: flex items size to max-content, which
  // leaves tiles ragged and collapses the ones that size themselves from their own `@container`
  // queries (Amber/Tesla small cards) onto their `min-w` floor. Column count comes from the rendered
  // child count and the container's width — see lib/dashboard/tile-grid.ts.
  const inner =
    node.direction === "row" ? (
      <div className={TILE_GRID_CONTAINER}>
        <div
          className={
            node.wrap === false
              ? tileRowClass()
              : tileGridClass(body.filter(Boolean).length)
          }
        >
          {body}
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-4">{body}</div>
    );

  if (node.heading && area) {
    return (
      <section className="rounded-lg border border-gray-700/70 bg-gray-900/30 p-2 sm:p-3">
        <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
          <Layers className="h-3.5 w-3.5" />
          <span>{area.displayName}</span>
        </div>
        {inner}
      </section>
    );
  }
  return inner;
}

function DeviceUnavailable() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
      <div>
        <p className="font-medium text-amber-200">Device unavailable</p>
        <p className="mt-0.5 text-amber-200/70">
          This item points to a device that couldn&rsquo;t be loaded — it may
          have been removed, or you don&rsquo;t have access to it.
        </p>
      </div>
    </div>
  );
}

export function NodeView({
  node,
  context,
  resolver,
  dashboardId,
  areasResolved,
  sharedSiteData,
}: {
  node: DashboardNode;
  context: NodeContext;
  resolver: ShellResolver;
  dashboardId?: string;
  areasResolved: boolean;
  /** Set by the parent GroupNodeView for its DIRECT card children — see `siteChartsMounted`. */
  sharedSiteData?: boolean;
}): React.ReactElement | null {
  if (node.kind === "group") {
    // Deliberately NOT forwarded: a nested group has its own area/handle and its own collapse
    // members, so it recomputes `siteChartsMounted` for its own children. Inheriting the parent's
    // would claim a fetch keyed on a DIFFERENT handle.
    return (
      <GroupNodeView
        node={node}
        context={context}
        resolver={resolver}
        dashboardId={dashboardId}
        areasResolved={areasResolved}
      />
    );
  }
  return (
    <CardNodeView
      node={node}
      context={childContext(node, context)}
      resolver={resolver}
      areasResolved={areasResolved}
      sharedSiteData={sharedSiteData}
    />
  );
}

/** Entry point: render a whole v4 document. */
export function DashboardV4View({
  doc,
  areaById,
  dashboardId,
  areasResolved = true,
  deviceById,
}: {
  doc: DashboardV4;
  areaById: Map<string, ReadableArea>;
  dashboardId?: string;
  areasResolved?: boolean;
  deviceById?: Map<string, ResolvedDevice>;
}) {
  const resolver = clientShellResolver(areaById, deviceById);
  return (
    <NodeView
      node={doc.root}
      context={{}}
      resolver={resolver}
      dashboardId={dashboardId}
      areasResolved={areasResolved}
    />
  );
}
