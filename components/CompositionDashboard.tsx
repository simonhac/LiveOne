"use client";

import { Fragment, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { dashboardDataQuery } from "@/lib/queries";
import { useModalContext } from "@/contexts/ModalContext";
import { useTileNodes } from "@/app/components/cards/useTileNodes";
import LinesChartCard from "@/components/LinesChartCard";
import SiteChartsCard from "@/components/SiteChartsCard";
import AmberCard from "@/components/AmberCard";
import AmberSmallCard from "@/components/AmberSmallCard";
import AmberNow from "@/components/AmberNow";
import GeneratorRunsCard from "@/components/GeneratorRunsCard";
import GridSignalsCard from "@/components/GridSignalsCard";
import { gridLatestFromData } from "@/lib/grid/latest";
import { nemRegionShortLabel } from "@/lib/vendors/openelectricity/region";
import { isNemRegion } from "@/lib/vendors/openelectricity/types";
import type { TileId } from "@/lib/dashboard/cards";
import type {
  AreaSectionV3,
  CardV3,
  DashboardV3,
  TileV3,
} from "@/lib/dashboard/v3";
import type { ReadableArea } from "@/lib/areas/list";
import type { LatestPointValues } from "@/lib/types/api";

/**
 * The nested dashboard renderer. Consumes the v3 definition (Dashboard -> AreaSection -> Card -> Tile,
 * see lib/dashboard/v3.ts) and renders each AreaSection against its Area's handle. There is NO home
 * system: every section self-fetches via the per-systemId query factories, and every tile/chart reads
 * either the section's own handle (whole-area) or a named member device.
 *
 * Render derivations (nothing below is stored in the descriptor):
 *  - handle = area.legacySystemId
 *  - header shown only when there are 2+ sections (single-area page = frameless, like /dashboard/8)
 *  - the stacked-areas charts + sankey of a section collapse into ONE SiteChartsCard (shared period),
 *    reproducing the legacy unified layout.
 *  - the grid-signals tile reads its bound OE region member; the region label comes from that device's
 *    own vendorSiteId payload — no location derivation, no conditional card.
 */
interface AreaDatum {
  system?: {
    id: number;
    vendorType: string;
    vendorSiteId: string | null;
    timezoneOffsetMin: number;
    displayTimezone: string | null;
  };
  latest?: LatestPointValues;
}

function staleThreshold(vendorType: string): number {
  return vendorType === "enphase" ? 2100 : 300;
}

function cardKeyV3(card: CardV3, i: number): string {
  return card.id ?? `${card.type}-${i}`;
}
function tileKeyV3(t: TileV3, i: number): string {
  return t.id ?? `${t.view}-${t.deviceSystemId ?? "self"}-${i}`;
}

interface CompositionDashboardProps {
  descriptor: DashboardV3;
  /** areaId -> its Area (addressing handle + label). */
  areaById: Map<string, ReadableArea>;
  /** The readable-areas fetch is still in flight (so an empty areaById is "loading", not "empty"). */
  areasLoading?: boolean;
  serveFlowFromPg?: boolean;
}

export default function CompositionDashboard({
  descriptor,
  areaById,
  areasLoading = false,
  serveFlowFromPg = false,
}: CompositionDashboardProps) {
  const sections = descriptor.sections.filter(
    (s) => !s.hidden && areaById.has(s.areaId),
  );

  if (sections.length === 0) {
    // Distinguish "areas still loading" (sections exist but their Areas haven't resolved) from a
    // genuinely empty dashboard, so we don't flash "no cards yet" on every load.
    if (areasLoading && descriptor.sections.length > 0) {
      return (
        <div className="px-1 py-16 text-center text-sm text-gray-500">
          Loading…
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-gray-400">
        <Layers className="mx-auto mb-3 h-10 w-10 text-gray-600" />
        <p className="text-sm">
          This dashboard has no cards yet. Add an area to get started.
        </p>
      </div>
    );
  }

  const showHeaders = sections.length > 1;
  return (
    <div className="space-y-4 px-1">
      {sections.map((section) => (
        <AreaSectionView
          key={section.areaId}
          section={section}
          area={areaById.get(section.areaId)!}
          showHeader={showHeaders}
          serveFlowFromPg={serveFlowFromPg}
        />
      ))}
    </div>
  );
}

/** One Area's cards, stacked. Header only in multi-area dashboards; single-area = frameless (/dashboard/8). */
function AreaSectionView({
  section,
  area,
  showHeader,
  serveFlowFromPg,
}: {
  section: AreaSectionV3;
  area: ReadableArea;
  showHeader: boolean;
  serveFlowFromPg: boolean;
}) {
  const handle = area.legacySystemId;
  const visible = section.cards.filter((c) => !c.hidden);

  // Collapse all stacked-areas charts + sankey of this section into ONE SiteChartsCard (shared period
  // + hover), exactly like the legacy unified view; `lines` charts stay standalone.
  const chartKeys = new Set<string>();
  for (const c of visible) {
    if (c.type === "sankey") chartKeys.add("sankey");
    else if (c.type === "chart" && c.chart?.variant === "stacked-areas")
      chartKeys.add(
        c.chart.split === "generation" ? "chart:generation" : "chart:load",
      );
  }
  let chartsEmitted = false;

  const body: ReactNode[] = visible.map((card, i) => {
    const isStacked =
      card.type === "sankey" ||
      (card.type === "chart" && card.chart?.variant === "stacked-areas");
    if (isStacked) {
      if (chartsEmitted) return null;
      chartsEmitted = true;
      return (
        <AreaSiteCharts
          key="site-charts"
          systemId={handle}
          keys={chartKeys}
          serveFlowFromPg={serveFlowFromPg}
        />
      );
    }
    switch (card.type) {
      case "tiles":
        return (
          <TilesGrid
            key={cardKeyV3(card, i)}
            handleSystemId={handle}
            tiles={card.tiles ?? []}
          />
        );
      case "chart": // lines variant
        return (
          <LinesChartCard
            key={cardKeyV3(card, i)}
            systemId={handle}
            className="h-full min-h-[360px]"
          />
        );
      case "amber-now":
        return <AreaAmberNow key={cardKeyV3(card, i)} systemId={handle} />;
      case "amber-timeline":
        return <AreaAmberTimeline key={cardKeyV3(card, i)} systemId={handle} />;
      case "generator-runs":
        return <GeneratorRunsCard key={cardKeyV3(card, i)} systemId={handle} />;
      default:
        return null;
    }
  });

  return (
    <section
      className={
        showHeader
          ? "rounded-lg border border-gray-700/70 bg-gray-900/30 p-2 sm:p-3"
          : ""
      }
    >
      {showHeader && (
        <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
          <Layers className="h-3.5 w-3.5" />
          <span>{area.displayName}</span>
        </div>
      )}
      <div className="space-y-4">{body}</div>
    </section>
  );
}

/**
 * A section's tiles. Whole-area tiles (no deviceSystemId) share ONE useTileNodes render on the section
 * handle; device-bound tiles (e.g. grid-signals) render as their own self-fetching component so each
 * owns its hooks. Tile order is the descriptor order.
 */
function TilesGrid({
  handleSystemId,
  tiles,
}: {
  handleSystemId: number;
  tiles: TileV3[];
}) {
  const { isAnyModalOpen } = useModalContext();
  const { data, isLoading } = useQuery(
    dashboardDataQuery(handleSystemId, { paused: isAnyModalOpen }),
  );
  const datum = (data ?? null) as AreaDatum | null;
  const latest = datum?.latest ?? {};
  const { cardNodes, available } = useTileNodes({
    latest,
    vendorType: datum?.system?.vendorType ?? "",
    getStaleThreshold: staleThreshold,
    showGrid: !!latest["bidi.grid/power"],
    systemId: handleSystemId,
    canControl: false,
  });

  // While the handle's data is still loading, show skeleton tiles (not "No live data", not a
  // partial render) so the grid never flashes an empty/error state and every tile appears together.
  if (isLoading) {
    const n = tiles.filter((t) => !t.hidden).length || 4;
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1">
        {Array.from({ length: n }).map((_, i) => (
          <div
            key={i}
            className="min-h-[120px] animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30"
          />
        ))}
      </div>
    );
  }

  const cells: ReactNode[] = [];
  tiles.forEach((t, i) => {
    if (t.hidden) return;
    if (t.view === "oe-grid") {
      if (t.deviceSystemId != null)
        cells.push(
          <DeviceGridTile
            key={tileKeyV3(t, i)}
            deviceSystemId={t.deviceSystemId}
          />,
        );
      return;
    }
    const view = t.view as TileId;
    if (available[view])
      cells.push(<Fragment key={tileKeyV3(t, i)}>{cardNodes[view]}</Fragment>);
  });

  if (cells.length === 0) {
    return (
      <div className="px-1 py-6 text-center text-sm text-gray-500">
        No live data
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1">
      {cells}
    </div>
  );
}

/**
 * A grid-signals tile bound to a member device (the OE region system). Self-fetches that device; the
 * region label comes straight from its `vendorSiteId` (e.g. "VIC1") — no location lookup needed.
 */
function DeviceGridTile({ deviceSystemId }: { deviceSystemId: number }) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(deviceSystemId, { paused: isAnyModalOpen }),
  );
  const siteId = ((data ?? null) as AreaDatum | null)?.system?.vendorSiteId;
  const region = siteId && isNemRegion(siteId) ? siteId : null;
  // Empty label (not "Grid") while the region/values are still loading: GridSignalsCard then renders
  // null (its `!regionLabel && values === null` guard), so this tile is cleanly absent during load —
  // matching the whole-area tiles — instead of flashing "Grid Grid".
  return (
    <GridSignalsCard
      regionLabel={region ? nemRegionShortLabel(region) : ""}
      values={gridLatestFromData(data)}
    />
  );
}

/**
 * The collapsed site charts (+ sankey) for a section. Self-fetches the handle's `system` (vendorType +
 * timezone) and passes it to SiteChartsCard, which gates its site-history query on the site vendor;
 * `keys` selects which sub-charts show (chart:load / chart:generation / sankey).
 */
function AreaSiteCharts({
  systemId,
  keys,
  serveFlowFromPg,
}: {
  systemId: number;
  keys: Set<string>;
  serveFlowFromPg: boolean;
}) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  const system = ((data ?? null) as AreaDatum | null)?.system;
  // Hold the layout until `system` (vendorType) is known. Mounting SiteChartsCard with
  // system=undefined disables its history query (isSiteVendor=false), which renders "No data
  // available" before any real loading state. An empty min-height container avoids that flash;
  // SiteChartsCard's own (delayed) spinner takes over once the system loads.
  if (!system) {
    return <div className="min-h-[360px]" />;
  }
  return (
    <SiteChartsCard
      systemId={String(systemId)}
      system={system}
      serveFlowFromPg={serveFlowFromPg}
      cardVisible={(k) => keys.has(k)}
    />
  );
}

function AreaAmberNow({ systemId }: { systemId: number }) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  const latest = ((data ?? null) as AreaDatum | null)?.latest ?? {};
  return (
    <>
      <div className="px-1">
        <AmberSmallCard latest={latest} />
      </div>
      <AmberNow latest={latest} />
    </>
  );
}

function AreaAmberTimeline({ systemId }: { systemId: number }) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  const datum = (data ?? null) as AreaDatum | null;
  return (
    <AmberCard
      systemId={systemId}
      timezoneOffsetMin={datum?.system?.timezoneOffsetMin ?? 600}
      displayTimezone={datum?.system?.displayTimezone}
    />
  );
}
