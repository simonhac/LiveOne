"use client";

import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { dashboardDataQuery } from "@/lib/queries";
import { useModalContext } from "@/contexts/ModalContext";
import { useTileNodes } from "@/app/components/cards/useTileNodes";
import LinesChartCard from "@/components/LinesChartCard";
import SiteChartsCard from "@/components/SiteChartsCard";
import { ChartFocusProvider } from "@/lib/charts/ChartFocusContext";
import AmberCard from "@/components/AmberCard";
import AmberSmallCard from "@/components/AmberSmallCard";
import AmberNow from "@/components/AmberNow";
import GeneratorRunsCard from "@/components/GeneratorRunsCard";
import GridSignalsCard from "@/components/GridSignalsCard";
import { gridLatestFromData } from "@/lib/grid/latest";
import { nemRegionShortLabel } from "@/lib/vendors/openelectricity/region";
import { isNemRegion } from "@/lib/vendors/openelectricity/types";
import { getLayout, chartHasData } from "@/lib/dashboard/cards";
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

interface DashboardProps {
  descriptor: DashboardV3;
  /** areaId -> its Area (addressing handle + label). May be empty while the readable-areas fetch is
   *  in flight — sections still render their skeleton layout from the descriptor in the meantime. */
  areaById: Map<string, ReadableArea>;
  serveFlowFromPg?: boolean;
}

export default function Dashboard({
  descriptor,
  areaById,
  serveFlowFromPg = false,
}: DashboardProps) {
  // Render every section straight from the descriptor — its Area (and so the live data) may not have
  // resolved yet, in which case each card draws a skeleton. We have enough to draw the layout
  // immediately, so there's no "Loading…" gate before the skeletons appear.
  const sections = descriptor.sections.filter((s) => !s.hidden);

  if (sections.length === 0) {
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
          area={areaById.get(section.areaId)}
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
  /** Undefined while the readable-areas fetch is in flight → the cards draw skeletons. */
  area?: ReadableArea;
  showHeader: boolean;
  serveFlowFromPg: boolean;
}) {
  const handle = area?.legacySystemId;
  const visible = section.cards.filter((c) => !c.hidden);

  // Collapse this section's stacked-areas charts + sankey into ONE SiteChartsCard (shared period +
  // hover), exactly like the legacy unified view; `lines` charts stay standalone. SiteChartsCard works
  // for ANY area with loads + sources (not just mondo/composite) — a sidebar area with just a sankey
  // card renders that sankey alone in the same container.
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
    // Each card draws a skeleton until the Area's handle is known (then its leaf self-fetches and
    // shows its own loading state). TilesGrid handles the no-handle case internally (skeleton cells).
    if (isStacked) {
      if (chartsEmitted) return null;
      chartsEmitted = true;
      return handle != null ? (
        <AreaSiteCharts
          key="site-charts"
          systemId={handle}
          keys={chartKeys}
          serveFlowFromPg={serveFlowFromPg}
        />
      ) : (
        <ChartSkeleton key="site-charts" />
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
        return handle != null ? (
          <AreaLinesChart key={cardKeyV3(card, i)} systemId={handle} />
        ) : (
          <ChartSkeleton key={cardKeyV3(card, i)} />
        );
      case "amber-now":
        return handle != null ? (
          <AreaAmberNow key={cardKeyV3(card, i)} systemId={handle} />
        ) : (
          <ChartSkeleton key={cardKeyV3(card, i)} />
        );
      case "amber-timeline":
        return handle != null ? (
          <AreaAmberTimeline key={cardKeyV3(card, i)} systemId={handle} />
        ) : (
          <ChartSkeleton key={cardKeyV3(card, i)} />
        );
      case "generator-runs":
        return handle != null ? (
          <GeneratorRunsCard key={cardKeyV3(card, i)} systemId={handle} />
        ) : (
          <ChartSkeleton key={cardKeyV3(card, i)} />
        );
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
      {showHeader && area && (
        <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
          <Layers className="h-3.5 w-3.5" />
          <span>{area.displayName}</span>
        </div>
      )}
      {/* One shared chart-focus per section: the line chart + stacked charts + Sankey of this Area
          sync their hover/highlight; areas don't cross-sync. */}
      <ChartFocusProvider>
        <div className="space-y-4">{body}</div>
      </ChartFocusProvider>
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
  /** Undefined while the Area is still resolving → skeleton cells (count from the descriptor). */
  handleSystemId?: number;
  tiles: TileV3[];
}) {
  const visible = tiles.filter((t) => !t.hidden);
  if (visible.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1">
      {visible.map((t, i) =>
        handleSystemId == null ? (
          <TileSkeleton key={tileKeyV3(t, i)} />
        ) : (
          <TileCell
            key={tileKeyV3(t, i)}
            view={t.view}
            deviceSystemId={t.deviceSystemId}
            handleSystemId={handleSystemId}
          />
        ),
      )}
    </div>
  );
}

/** A tile-shaped loading placeholder shown while a TileCell's data is in flight. */
function TileSkeleton() {
  return (
    <div className="min-h-[120px] animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30" />
  );
}

/** A card-height loading placeholder for non-tile cards (charts / sankey / amber / generator-runs). */
function ChartSkeleton() {
  return (
    <div className="min-h-[360px] animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30" />
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
 * timezone) and `latest`, and renders SiteChartsCard for ANY area that has loads + sources — not just
 * mondo/composite "site" vendors. `keys` selects which sub-charts show (chart:load / chart:generation /
 * sankey). The "has loads + sources" decision is data-driven (`chartHasData`), so a selectronic area
 * with a sankey card renders the sankey here just like a composite would; site vendors keep rendering
 * via their layout even before `latest` resolves.
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
  const datum = (data ?? null) as AreaDatum | null;
  const system = datum?.system;
  const latest = datum?.latest ?? {};
  // Hold the layout until `system` (vendorType) is known. Mounting SiteChartsCard with
  // system=undefined disables its history query, which renders "No data available" before any real
  // loading state. An empty min-height container avoids that flash; SiteChartsCard's own (delayed)
  // spinner takes over once the system loads.
  if (!system) {
    return <div className="min-h-[360px]" />;
  }
  // Render the charts/sankey for site vendors (by layout, even before `latest` lands — preserves the
  // existing composite loading UX) OR any area whose data actually carries sources + loads.
  const siteCapable =
    getLayout(system.vendorType) === "site" || chartHasData(latest);
  if (!siteCapable) return null;
  return (
    <SiteChartsCard
      systemId={String(systemId)}
      system={system}
      serveFlowFromPg={serveFlowFromPg}
      siteCapable={siteCapable}
      cardVisible={(k) => keys.has(k)}
    />
  );
}

/**
 * The line chart for a section — self-fetches the handle's `system` for its timezone (the temporal
 * navigator needs it to format the range label + encode historical URLs), then renders LinesChartCard.
 * Mirrors AreaSiteCharts; React Query dedupes the shared dashboardDataQuery fetch. Holds the layout
 * (skeleton) until the timezone is known.
 */
/**
 * The line chart's y-axis scaling hint, derived from the system's nameplate solar/inverter sizing
 * (`systemInfo.solarSize` "9 kW" / `ratings` "7.5kW, 48V"). Used by the per-device viewer historically;
 * resolved here so every section's lines chart scales the same. Undefined when no sizing is known.
 */
function maxPowerHintFromSystemInfo(systemInfo?: {
  solarSize?: string;
  ratings?: string;
}): number | undefined {
  const solarMatch = systemInfo?.solarSize?.match(/^(\d+(?:\.\d+)?)\s+kW$/i);
  const solarKW = solarMatch ? parseFloat(solarMatch[1]) : undefined;
  const ratingMatch = systemInfo?.ratings?.match(/(\d+(?:\.\d+)?)kW/i);
  const inverterKW = ratingMatch ? parseFloat(ratingMatch[1]) : undefined;
  if (solarKW !== undefined && inverterKW !== undefined) {
    return Math.max(solarKW, inverterKW);
  }
  return solarKW ?? inverterKW;
}

function AreaLinesChart({ systemId }: { systemId: number }) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  const tz = ((data ?? null) as AreaDatum | null)?.system?.timezoneOffsetMin;
  if (tz == null) {
    return <ChartSkeleton />;
  }
  const systemInfo = (
    data as { systemInfo?: { solarSize?: string; ratings?: string } } | null
  )?.systemInfo;
  return (
    <LinesChartCard
      systemId={systemId}
      className="h-full min-h-[360px]"
      timezoneOffsetMin={tz}
      maxPowerHint={maxPowerHintFromSystemInfo(systemInfo)}
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
