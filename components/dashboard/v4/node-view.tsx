"use client";

/**
 * config-v4 dashboard renderer — the recursive v4 node tree (Phase 5, DARK).
 *
 * `<DashboardV4View doc>` renders a v4 document (clean-sheet §8) by recursing `<NodeView>`:
 *   - `group` → a flex layout container; a group with `heading` + a resolved `area` renders the area
 *     header (a v3 "section"); a `row` group is a v3 "tiles" grid. Its direct card children that are
 *     chart/sankey collapse into ONE <SiteChartsGroup> (the v3 two-pass collapse, ported here and keyed
 *     on the GROUP's area handle).
 *   - `card` → dispatched by type: a promoted tile view renders a self-fetching tile cell; a v3 card
 *     type renders the UNCHANGED v3 `CardPlugin` via the v4→v3 adapter (lib/dashboard/v4-adapt.ts);
 *     an unknown type renders a labelled placeholder (§8.4).
 *
 * Context (`area`/`device`) inherits down the tree (§8.1). Nothing in the live path renders v4 yet
 * (no dashboard has a `doc`); the two v3 registries are reused untouched. Layout is structurally
 * correct; pixel parity with v3 is tuned once real v4 docs render (Phase 6+).
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
import { CARD_RENDERERS } from "@/components/dashboard/cards/registry";
import type { DashboardCardType } from "@/lib/dashboard/v3";
import { TILE_RENDERERS } from "@/components/dashboard/tiles/registry";
import {
  useAreaDatum,
  staleThreshold,
  TileSkeleton,
  ChartSkeleton,
} from "@/components/dashboard/cards/shared";
import { SiteChartsGroup } from "@/components/dashboard/cards/site-charts";
import {
  isV3CardType,
  synthCardV3,
  synthSectionV3,
  v4CardRenderKind,
} from "@/lib/dashboard/v4-adapt";

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
      const uuid = areaUuidOf(id);
      if (!uuid) return null;
      const ra = areaById.get(uuid);
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

/** One tile-view card — mirrors the v3 TilesCard cell (self-fetch, availability gate, plugin mount). */
function V4TileCell({
  view,
  systemId,
}: {
  view: DashboardCardType | string;
  systemId: number;
}) {
  const { data, datum, isLoading } = useAreaDatum(systemId);
  const latest = datum?.latest ?? {};
  if (isLoading) return <TileSkeleton />;
  const plugin = TILE_RENDERERS[view as keyof typeof TILE_RENDERERS];
  if (!plugin) return null;
  const showGrid = !!latest["bidi.grid/power"];
  if (!plugin.isAvailable({ latest, data, showGrid })) return null;
  return (
    <plugin.Render
      latest={latest}
      data={data}
      systemId={systemId}
      staleThresholdSeconds={staleThreshold(
        datum?.system?.vendorType ?? "",
        datum?.system?.config?.updateCadenceSeconds,
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
}: {
  node: CardNode;
  context: NodeContext;
  resolver: ShellResolver;
  areasResolved: boolean;
}) {
  const area: ResolvedArea | null = context.area
    ? resolver.area(context.area)
    : null;
  const device: ResolvedDevice | null = context.device
    ? resolver.device(context.device)
    : null;
  if (context.device && device == null) return <DeviceUnavailable />;
  const handle = area?.handle ?? null;
  const systemId = context.device ? (device?.systemId ?? null) : handle;
  const renderKind = v4CardRenderKind(node.type);

  // Promoted tile view → a self-fetching tile cell.
  if (renderKind === "tile") {
    if (systemId == null) return <TileSkeleton />;
    return <V4TileCell view={node.type} systemId={systemId} />;
  }

  // Known v3 card type → the unchanged v3 CardPlugin, via the v4→v3 adapter.
  if (renderKind === "v3") {
    const plugin = CARD_RENDERERS[node.type as DashboardCardType];
    if (!plugin) return null;
    if (plugin.pending !== "self" && handle == null) {
      return areasResolved ? null : <ChartSkeleton />;
    }
    const card = synthCardV3(node, device?.systemId ?? undefined);
    const section = synthSectionV3(
      context.area ? (areaUuidOf(context.area) ?? undefined) : undefined,
    );
    return (
      <plugin.Render
        card={card}
        section={section}
        handle={handle ?? undefined}
      />
    );
  }

  // Unknown/future card type (§8.4): a labelled placeholder — never destroy its opaque config.
  return (
    <div className="rounded-lg border border-gray-700/70 bg-gray-900/30 px-4 py-3 text-sm text-gray-400">
      Unknown card type <code className="text-gray-300">{node.type}</code>
    </div>
  );
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
  const handle = area?.handle ?? null;

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
  // keyed on this group's area handle). Reuses each v3 plugin's own collapseKey.
  const chartKeys = new Set<string>();
  for (const child of node.children) {
    if (child.kind === "card" && isV3CardType(child.type)) {
      const plugin = CARD_RENDERERS[child.type as DashboardCardType];
      const k = plugin?.collapseKey?.(synthCardV3(child)) ?? null;
      if (k != null) chartKeys.add(k);
    }
  }
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
      if (child.kind === "card" && isV3CardType(child.type)) {
        const plugin = CARD_RENDERERS[child.type as DashboardCardType];
        if (plugin?.collapseKey?.(synthCardV3(child)) != null) {
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
      }
      return (
        <NodeView
          key={nodeKey(child, i)}
          node={child}
          context={nodeContext}
          resolver={resolver}
          dashboardId={dashboardId}
          areasResolved={areasResolved}
        />
      );
    });

  const isRow = node.direction === "row";
  const layoutClass = isRow
    ? `flex flex-row ${node.wrap ? "flex-wrap" : ""} gap-2 lg:gap-4`
    : "flex flex-col gap-4";
  const inner = <div className={layoutClass}>{body}</div>;

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
}: {
  node: DashboardNode;
  context: NodeContext;
  resolver: ShellResolver;
  dashboardId?: string;
  areasResolved: boolean;
}): React.ReactElement | null {
  if (node.kind === "group") {
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
