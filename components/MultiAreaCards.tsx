"use client";

import { Fragment, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { dashboardDataQuery } from "@/lib/queries";
import { useModalContext } from "@/contexts/ModalContext";
import { useTileNodes } from "@/app/components/cards/useTileNodes";
import LinesChartCard from "@/components/LinesChartCard";
import AmberCard from "@/components/AmberCard";
import GeneratorRunsCard from "@/components/GeneratorRunsCard";
import { TILE_IDS } from "@/lib/dashboard/cards";
import {
  cardIdentity,
  type DashboardDescriptor,
  type ModuleCardInstance,
} from "@/lib/dashboard/descriptor";
import { offAreaCards } from "@/lib/dashboard/multi-area";
import type { ReadableArea } from "@/lib/areas/list";
import type { LatestPointValues } from "@/lib/types/api";

/**
 * Multi-area composition (Phase 2b): the dashboard's cards that read ANOTHER Area than the page's.
 *
 * The page's own cards still render via DashboardClient's template; this section renders the cards a
 * user composed from other Areas (each `ModuleCardInstance.areaId` resolving to a different
 * systemId). Every card is a self-contained, area-labelled component that fetches its OWN area's
 * data via the existing per-systemId query factories — the same pattern the Local Grid (NEM) card
 * already uses to render a different system. In the read-only shared view each fetch carries the
 * share token (appended by the fetcher) and is authorised by the live union scope (requireDashboardAccess).
 *
 * Which card types compose (tiles, chart, amber-timeline, generator-runs) lives in
 * lib/dashboard/multi-area.ts, shared with the Customize dialog's add-card picker.
 */
function staleThreshold(vendorType: string): number {
  return vendorType === "enphase" ? 2100 : 300;
}

interface AreaDatum {
  system?: {
    id: number;
    vendorType: string;
    timezoneOffsetMin: number;
    displayTimezone: string | null;
  };
  latest?: LatestPointValues;
}

interface MultiAreaCardsProps {
  descriptor: DashboardDescriptor | null;
  /** areaId → its readable Area (addressing handle + label). */
  areaById: Map<string, ReadableArea>;
  /** The page's own systemId — cards resolving to it are NOT off-area, so they're skipped here. */
  pageSystemId: number;
}

export default function MultiAreaCards({
  descriptor,
  areaById,
  pageSystemId,
}: MultiAreaCardsProps) {
  const cards = offAreaCards(
    descriptor,
    (areaId) => areaById.get(areaId)?.legacySystemId,
    pageSystemId,
  );
  if (cards.length === 0) return null;

  return (
    <div className="space-y-4 px-1">
      {cards.map((card) => {
        const area = areaById.get(card.areaId!)!;
        return <AreaCard key={cardIdentity(card)} card={card} area={area} />;
      })}
    </div>
  );
}

/** A labelled frame around one off-area card; dispatches to the right inner card by type. */
function AreaCard({
  card,
  area,
}: {
  card: ModuleCardInstance;
  area: ReadableArea;
}) {
  return (
    <section className="rounded-lg border border-gray-700/70 bg-gray-900/30 p-2 sm:p-3">
      <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
        <Layers className="h-3.5 w-3.5" />
        <span>{area.displayName}</span>
      </div>
      <AreaCardBody card={card} area={area} />
    </section>
  );
}

function AreaCardBody({
  card,
  area,
}: {
  card: ModuleCardInstance;
  area: ReadableArea;
}): ReactNode {
  const systemId = area.legacySystemId;
  switch (card.type) {
    case "chart":
      return <AreaChartCard systemId={systemId} />;
    case "generator-runs":
      return <GeneratorRunsCard systemId={systemId} />;
    case "tiles":
      return <AreaTilesCard systemId={systemId} />;
    case "amber-timeline":
      return <AreaAmberCard systemId={systemId} />;
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
  const vendorType = datum?.system?.vendorType ?? "";

  const { cardNodes, available } = useTileNodes({
    latest,
    vendorType,
    getStaleThreshold: staleThreshold,
    showGrid: !!latest["bidi.grid/power"],
    systemId,
    canControl: false, // read-only when composed onto another dashboard
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

/** Another Area's line chart — self-fetches that area's tz (for the temporal navigator), then renders. */
function AreaChartCard({ systemId }: { systemId: number }) {
  const { isAnyModalOpen } = useModalContext();
  const { data } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  const tz = ((data ?? null) as AreaDatum | null)?.system?.timezoneOffsetMin;
  return (
    <LinesChartCard
      systemId={systemId}
      className="h-full min-h-[360px]"
      timezoneOffsetMin={tz ?? 600}
    />
  );
}

/** Another Area's Amber forecast — self-fetches that area's tz, then renders the shared Amber card. */
function AreaAmberCard({ systemId }: { systemId: number }) {
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
