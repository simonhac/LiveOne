"use client";

import { type ReactNode } from "react";
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
  TileView,
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
 * A section's tiles — one self-contained <TileCell> per descriptor tile, in order. The grid is a stable
 * set of cells; each cell self-fetches and shows its own skeleton until ready (no whole-grid swap).
 */
function TilesGrid({
  handleSystemId,
  tiles,
}: {
  handleSystemId: number;
  tiles: TileV3[];
}) {
  const visible = tiles.filter((t) => !t.hidden);
  if (visible.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1">
      {visible.map((t, i) => (
        <TileCell
          key={tileKeyV3(t, i)}
          view={t.view}
          deviceSystemId={t.deviceSystemId}
          handleSystemId={handleSystemId}
        />
      ))}
    </div>
  );
}

/** A tile-shaped loading placeholder shown while a TileCell's data is in flight. */
function TileSkeleton() {
  return (
    <div className="min-h-[120px] animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30" />
  );
}

/**
 * One tile — the SINGLE uniform rendering path for EVERY view, whole-area or device-bound. It
 * self-fetches its system (`deviceSystemId ?? handle` — React Query dedupes, so all whole-area tiles
 * share one request; a device tile adds one), shows its own skeleton while loading, then renders the
 * view: standard views via the shared `useTileNodes` node-builder; `oe-grid` via `GridSignalsCard`
 * (region from the device's `vendorSiteId`). The device tile is a VIEW CASE here — not a bespoke
 * component — so it behaves identically to every other tile (same fetch, same skeleton); it just points
 * at a member device.
 */
function TileCell({
  view,
  deviceSystemId,
  handleSystemId,
}: {
  view: TileView;
  deviceSystemId?: number;
  handleSystemId: number;
}) {
  const { isAnyModalOpen } = useModalContext();
  const systemId = deviceSystemId ?? handleSystemId;
  const { data, isLoading } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  const datum = (data ?? null) as AreaDatum | null;
  const latest = datum?.latest ?? {};
  // useTileNodes is a hook → call it unconditionally. It's the standard-view node source; the oe-grid
  // branch below ignores its output.
  const { cardNodes, available } = useTileNodes({
    latest,
    vendorType: datum?.system?.vendorType ?? "",
    getStaleThreshold: staleThreshold,
    showGrid: !!latest["bidi.grid/power"],
    systemId,
    canControl: false,
  });

  if (isLoading) return <TileSkeleton />;

  if (view === "oe-grid") {
    const values = gridLatestFromData(data);
    if (!values) return null;
    const siteId = datum?.system?.vendorSiteId;
    const region = siteId && isNemRegion(siteId) ? siteId : null;
    return (
      <GridSignalsCard
        regionLabel={region ? nemRegionShortLabel(region) : ""}
        values={values}
      />
    );
  }

  const tileId = view as TileId;
  return available[tileId] ? <>{cardNodes[tileId]}</> : null;
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
