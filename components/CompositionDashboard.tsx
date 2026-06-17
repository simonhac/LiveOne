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
import { TILE_IDS } from "@/lib/dashboard/cards";
import {
  cardIdentity,
  type DashboardDescriptor,
  type ModuleCardInstance,
} from "@/lib/dashboard/descriptor";
import type { ReadableArea } from "@/lib/areas/list";
import type { GridContext } from "@/lib/grid/types";
import type { LatestPointValues } from "@/lib/types/api";

/**
 * The composition-first dashboard renderer (Phase 2b-2). Renders a dashboard's ordered, area-bound
 * cards — there is NO home system; each card resolves its own `areaId → systemId` and self-fetches
 * via the existing per-systemId query factories (the proven cross-system pattern). Every card type is
 * supported, each rendered inside an Area-labelled frame.
 *
 * `gridContextByArea` carries the server-resolved NEM region for each Area that has a grid-signals
 * card (the region is derived from the Area's location, which the client can't see). In a read-only
 * shared view, per-Area fetches carry the share token (appended by the fetcher) and are authorized by
 * the live union scope.
 */
interface AreaDatum {
  system?: {
    id: number;
    vendorType: string;
    timezoneOffsetMin: number;
    displayTimezone: string | null;
  };
  latest?: LatestPointValues;
}

function staleThreshold(vendorType: string): number {
  return vendorType === "enphase" ? 2100 : 300;
}

interface CompositionDashboardProps {
  descriptor: DashboardDescriptor;
  /** areaId → its Area (addressing handle + label). */
  areaById: Map<string, ReadableArea>;
  /** Server-resolved NEM region per Area for grid-signals cards (null = no derivable region). */
  gridContextByArea?: Record<string, GridContext | null>;
  serveFlowFromPg?: boolean;
}

export default function CompositionDashboard({
  descriptor,
  areaById,
  gridContextByArea = {},
  serveFlowFromPg = false,
}: CompositionDashboardProps) {
  const cards = descriptor.cards.filter(
    (c) => !c.hidden && c.areaId && areaById.has(c.areaId),
  );

  if (cards.length === 0) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-gray-400">
        <Layers className="mx-auto mb-3 h-10 w-10 text-gray-600" />
        <p className="text-sm">
          This dashboard has no cards yet. Open Customize to add cards from your
          areas.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-1">
      {cards.map((card) => {
        const area = areaById.get(card.areaId!)!;
        return (
          <AreaCard
            key={cardIdentity(card)}
            card={card}
            area={area}
            gridContext={gridContextByArea[card.areaId!] ?? null}
            serveFlowFromPg={serveFlowFromPg}
          />
        );
      })}
    </div>
  );
}

/** A labelled frame around one card; dispatches to the right inner card by type. */
function AreaCard({
  card,
  area,
  gridContext,
  serveFlowFromPg,
}: {
  card: ModuleCardInstance;
  area: ReadableArea;
  gridContext: GridContext | null;
  serveFlowFromPg: boolean;
}) {
  return (
    <section className="rounded-lg border border-gray-700/70 bg-gray-900/30 p-2 sm:p-3">
      <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
        <Layers className="h-3.5 w-3.5" />
        <span>{area.displayName}</span>
      </div>
      <AreaCardBody
        card={card}
        systemId={area.legacySystemId}
        gridContext={gridContext}
        serveFlowFromPg={serveFlowFromPg}
      />
    </section>
  );
}

function AreaCardBody({
  card,
  systemId,
  gridContext,
  serveFlowFromPg,
}: {
  card: ModuleCardInstance;
  systemId: number;
  gridContext: GridContext | null;
  serveFlowFromPg: boolean;
}): ReactNode {
  switch (card.type) {
    case "tiles":
      return <AreaTilesCard systemId={systemId} />;
    case "chart":
      if (card.chart?.variant === "stacked-areas") {
        const key =
          card.chart.split === "generation" ? "chart:generation" : "chart:load";
        return (
          <AreaSiteChartCard
            systemId={systemId}
            serveFlowFromPg={serveFlowFromPg}
            cardKey={key}
          />
        );
      }
      return (
        <LinesChartCard systemId={systemId} className="h-full min-h-[360px]" />
      );
    case "sankey":
      return (
        <AreaSiteChartCard
          systemId={systemId}
          serveFlowFromPg={serveFlowFromPg}
          cardKey="sankey"
        />
      );
    case "amber-now":
      return <AreaAmberNowCard systemId={systemId} />;
    case "amber-timeline":
      return <AreaAmberTimelineCard systemId={systemId} />;
    case "generator-runs":
      return <GeneratorRunsCard systemId={systemId} />;
    case "grid-signals":
      return gridContext ? (
        <AreaGridSignalsCard gridContext={gridContext} />
      ) : null;
    default:
      return null;
  }
}

/** Another Area's power tiles — self-fetches that area's latest, then reuses the shared tile builder. */
function AreaTilesCard({ systemId }: { systemId: number }) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  const datum = (data ?? null) as AreaDatum | null;
  const latest = datum?.latest ?? {};
  const { cardNodes, available } = useTileNodes({
    latest,
    vendorType: datum?.system?.vendorType ?? "",
    getStaleThreshold: staleThreshold,
    showGrid: !!latest["bidi.grid/power"],
    systemId,
    canControl: false,
  });
  const order = TILE_IDS.filter((id) => available[id]);
  if (order.length === 0) {
    return (
      <div className="px-1 py-6 text-center text-sm text-gray-500">
        No live data
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1">
      {order.map((id) => (
        <Fragment key={`tile-${id}`}>{cardNodes[id]}</Fragment>
      ))}
    </div>
  );
}

/**
 * A site stacked-areas chart / sankey for an Area. Self-fetches the Area's `system` (vendorType +
 * timezone) and passes it to SiteChartsCard — which gates its site-history query on
 * `isSiteVendor = system.vendorType ∈ {mondo, composite}`, so without the system prop it renders
 * "No data". `cardKey` selects which sub-card to show (`chart:load` / `chart:generation` / `sankey`).
 */
function AreaSiteChartCard({
  systemId,
  serveFlowFromPg,
  cardKey,
}: {
  systemId: number;
  serveFlowFromPg: boolean;
  cardKey: string;
}) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  const system = ((data ?? null) as AreaDatum | null)?.system;
  return (
    <SiteChartsCard
      systemId={String(systemId)}
      system={system}
      serveFlowFromPg={serveFlowFromPg}
      cardVisible={(k) => k === cardKey}
    />
  );
}

function AreaAmberNowCard({ systemId }: { systemId: number }) {
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

function AreaAmberTimelineCard({ systemId }: { systemId: number }) {
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

function AreaGridSignalsCard({ gridContext }: { gridContext: GridContext }) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(gridContext.regionSystemId ?? "", {
      paused: isAnyModalOpen,
    }),
  );
  const values = gridLatestFromData(data);
  return (
    <GridSignalsCard
      regionLabel={nemRegionShortLabel(gridContext.region)}
      values={values}
    />
  );
}
