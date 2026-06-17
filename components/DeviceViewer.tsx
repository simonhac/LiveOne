"use client";

import { useState, useMemo, Fragment, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AlertTriangle, Home } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import { dashboardDataQuery } from "@/lib/queries";
import { gridLatestFromData } from "@/lib/grid/latest";
import { generatorRunningFromLatest } from "@/lib/generator/running";
import GridSignalsCard from "@/components/GridSignalsCard";
import { nemRegionShortLabel } from "@/lib/vendors/openelectricity/region";
import type { GridContext } from "@/lib/grid/types";
import LinesChartCard from "@/components/LinesChartCard";
import AmberCard from "@/components/AmberCard";
import AmberNow from "@/components/AmberNow";
import AmberSmallCard from "@/components/AmberSmallCard";
import SiteChartsCard from "@/components/SiteChartsCard";
import GeneratorRunsCard from "@/components/GeneratorRunsCard";
import { ChartFocusProvider } from "@/lib/charts/ChartFocusContext";
import { useTileNodes } from "@/app/components/cards/useTileNodes";
import {
  buildDefaultDescriptor,
  tilesConfigOf,
  isCardVisible,
  type DashboardDescriptor,
} from "@/lib/dashboard/descriptor";
import { TILE_IDS, type DashboardCardType } from "@/lib/dashboard/cards";
import type { LatestPointValues } from "@/lib/types/api";

interface SystemInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface DashboardData {
  system: {
    id: number;
    vendorType: string;
    vendorSiteId: string;
    displayName: string;
    alias: string | null;
    displayTimezone: string | null;
    ownerClerkUserId: string;
    timezoneOffsetMin: number;
    status: string;
    model: string | null;
    serial: string | null;
    ratings: string | null;
    solarSize: string | null;
    batterySize: string | null;
    location: any;
    metadata: any;
    createdAt: Date;
    updatedAt: Date;
    supportsPolling: boolean;
  };
  latest: LatestPointValues;
}

interface DeviceViewerProps {
  systemId: string;
  system?: any; // System object from database
  hasAccess: boolean;
  systemExists: boolean;
  isAdmin: boolean;
  userId?: string;
  /** When true, the long-range (30D) Sankey is served from PG (FLOW_MATRIX_SERVE_FROM_PG). */
  serveFlowFromPg?: boolean;
  /**
   * The "Local Grid (NEM)" card's cross-system context (the public OpenElectricity region serving
   * this device's location), resolved server-side. Null when off-grid / no region / flags off — the
   * card then defaults off and is not rendered.
   */
  gridContext?: GridContext | null;
  /** Whether this device has an enabled generator run-tracker (gates the generator-runs card). */
  hasGenerator?: boolean;
}

// Helper function to get stale threshold based on vendor type
function getStaleThreshold(vendorType?: string): number {
  // 35 minutes (2100 seconds) for Enphase, 5 minutes (300 seconds) for selectronic
  return vendorType === "enphase" ? 2100 : 300;
}

/**
 * Read-only per-system viewer ("Device"). Renders the system's DEFAULT layout — the tiles and cards
 * that apply to this system — with no Customise / Share / Location controls (those live on
 * composition Dashboards). Recut from the former DashboardClient. Served at /device/{id}.
 */
export default function DeviceViewer({
  systemId,
  system,
  hasAccess,
  systemExists,
  isAdmin,
  userId,
  serveFlowFromPg = false,
  gridContext = null,
  hasGenerator = false,
}: DeviceViewerProps) {
  // Site-history "no data" flag, reported up from SiteChartsCard (which owns the site-data query),
  // so the unconfigured-composite warning can render here in its original position.
  const [siteHistoryEmpty, setSiteHistoryEmpty] = useState(false);

  // Get modal context to pause polling when modals are open
  const { isAnyModalOpen } = useModalContext();

  // Main device payload via React Query (latest values + system). Polls every 30s and on focus;
  // paused while a modal is open.
  const {
    data: queryData,
    isPending,
    isError,
    error: dataError,
  } = useQuery(dashboardDataQuery(systemId ?? "", { paused: isAnyModalOpen }));
  const data = (queryData ?? null) as DashboardData | null;
  const systemInfo =
    (queryData as { systemInfo?: SystemInfo } | undefined)?.systemInfo ?? null;

  // "Local Grid (NEM)" card: live signals for the household's NEM region. Read cross-system from the
  // public OpenElectricity region system using the SAME generic dashboardDataQuery — keyed on that
  // system. Disabled (id "") when no region resolves, so a null gridContext is safe.
  const { data: gridRegionData } = useQuery(
    dashboardDataQuery(gridContext?.regionSystemId ?? "", {
      paused: isAnyModalOpen,
    }),
  );
  const gridValues = useMemo(
    () => gridLatestFromData(gridRegionData),
    [gridRegionData],
  );

  // Real tile preview nodes. Built unconditionally (before any early return) to keep hook order
  // stable; harmless when data is absent.
  const { cardNodes: tileNodes, available: powerAvailable } = useTileNodes({
    latest: data?.latest ?? {},
    vendorType: data?.system.vendorType ?? "",
    getStaleThreshold,
    showGrid: !!data?.latest?.["bidi.grid/power"],
    systemId: data?.system.id,
    canControl:
      isAdmin || (!!userId && data?.system.ownerClerkUserId === userId),
  });

  // The device's default layout descriptor; null until system data has loaded. A device always uses
  // the default (no per-user customization).
  const effectiveDescriptor = useMemo<DashboardDescriptor | null>(() => {
    if (!data?.system) return null;
    return buildDefaultDescriptor(data.system, data.latest ?? {}, {
      gridSignalsAvailable: !!gridContext,
    });
  }, [data?.system, data?.latest, gridContext]);

  // Derive the display error from the query result: connection failure, an explicit `error` body,
  // or the "system exists but no charts" marker.
  const error = useMemo(() => {
    if (isError) {
      return dataError instanceof TypeError
        ? "Unable to connect to server"
        : "Failed to fetch data";
    }
    if (!queryData) return "";
    const r = queryData as { latest?: unknown; error?: string };
    if (r.latest) return "";
    if (r.error) return r.error;
    return system?.status !== "removed" ? "POINT_READINGS_NO_CHARTS" : "";
  }, [isError, dataError, queryData, system?.status]);

  // Show access denied message if user doesn't have access
  if (!hasAccess || !systemExists) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">
            Access Denied
          </h2>
          <p className="text-gray-400 mb-6">
            You don&apos;t have permission to view this system. Please contact
            your system administrator if you believe this is an error.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            <Home className="w-4 h-4" />
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!data && isPending) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading Data…</p>
        </div>
      </div>
    );
  }

  // Active descriptor: the default layout; null only until data has loaded. The layout booleans fall
  // back to vendor_type while it is null (loading).
  const activeDescriptor: DashboardDescriptor | null = effectiveDescriptor;
  const vendorTypeForLayout = data?.system.vendorType;
  const isAmberLayout = activeDescriptor
    ? activeDescriptor.layout === "amber"
    : vendorTypeForLayout === "amber";
  const isSiteLayout = activeDescriptor
    ? activeDescriptor.layout === "site"
    : vendorTypeForLayout === "mondo" || vendorTypeForLayout === "composite";

  // cardVisible() is true while the descriptor is still loading (null); tilesCfg falls back to
  // SystemTiles' default order/visibility until then.
  const cardVisible = (idOrType: DashboardCardType | string): boolean =>
    !activeDescriptor || isCardVisible(activeDescriptor, idOrType);
  const tilesCfg = activeDescriptor ? tilesConfigOf(activeDescriptor) : null;

  // Unified card grid (HA "Sections" style): the tiles (expanded individually) and the
  // Local Grid (NEM) card flow together in ONE responsive grid — no per-vendor layout fork. Each is
  // a cell; order/visibility come from the descriptor (tilesCfg) exactly as before.
  const tileHidden = new Set(tilesCfg?.hidden ?? []);
  const tileOrder = (tilesCfg?.order ?? [...TILE_IDS]).filter(
    (id) => powerAvailable[id] && !tileHidden.has(id),
  );
  const tileItems: ReactNode[] = cardVisible("tiles")
    ? tileOrder.map((id) => (
        <Fragment key={`tile-${id}`}>{tileNodes[id]}</Fragment>
      ))
    : [];
  if (gridContext && cardVisible("grid-signals")) {
    tileItems.push(
      <GridSignalsCard
        key="grid-signals"
        regionLabel={nemRegionShortLabel(gridContext.region)}
        values={gridValues}
      />,
    );
  }

  return (
    <main className="max-w-7xl mx-auto px-1 py-4">
      {/* Removed System Banner - Show regardless of data availability */}
      {system?.status === "removed" && (
        <div className="mb-4 p-4 bg-orange-900/50 border border-orange-700 text-orange-300 rounded-lg flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <div>
            <span className="font-semibold">
              This system has been marked as removed.
            </span>
            {!isAdmin && <span> Limited access is available.</span>}
          </div>
        </div>
      )}

      {error &&
        (error === "POINT_READINGS_NO_CHARTS" && !isSiteLayout ? (
          <div className="bg-blue-900/50 border border-blue-700 text-blue-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>
              Charts coming soon. Raw data is available via the settings menu.
            </span>
          </div>
        ) : error !== "POINT_READINGS_NO_CHARTS" ? (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        ) : null)}

      {(data?.latest || (data && (isSiteLayout || isAmberLayout))) && (
        <div className="space-y-6">
          {/* Show warning for unconfigured composite systems */}
          {system?.vendorType === "composite" && siteHistoryEmpty && (
            <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" />
              <span>
                Composite system needs to be configured before charts can be
                displayed.
              </span>
            </div>
          )}

          {/* Unified card grid: the power tiles + Local Grid (NEM) flow together in one responsive
              grid (HA "Sections" style). No per-vendor layout fork — order/visibility come from the
              descriptor. */}
          {(isAdmin || system?.status !== "removed") &&
            tileItems.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1">
                {tileItems}
              </div>
            )}

          {/* Amber price cards (full width). Render even for removed systems, matching prior behavior. */}
          {cardVisible("amber-now") && (
            <>
              <div className="px-1">
                <AmberSmallCard latest={data!.latest} />
              </div>
              <AmberNow latest={data!.latest} />
            </>
          )}
          {cardVisible("amber-timeline") && (
            <AmberCard
              systemId={parseInt(systemId)}
              timezoneOffsetMin={data?.system.timezoneOffsetMin ?? 600}
              displayTimezone={data?.system.displayTimezone}
            />
          )}

          {/* Full-width charts (descriptor-gated, no layout fork). One shared chart-focus so the
              line chart + stacked charts + Sankey sync their hover/highlight. */}
          {(isAdmin || system?.status !== "removed") && (
            <ChartFocusProvider>
              <div className="space-y-4 px-1">
                {/* Site-charts cluster (load + generation charts, tables, Sankey). The inner
                  cardVisible gates no-op for non-site systems. */}
                <SiteChartsCard
                  systemId={systemId}
                  system={system}
                  serveFlowFromPg={serveFlowFromPg}
                  cardVisible={cardVisible}
                  onHistoryEmptyChange={setSiteHistoryEmpty}
                />
                {cardVisible("chart:lines") && (
                  <LinesChartCard
                    systemId={parseInt(systemId)}
                    className="h-full min-h-[400px]"
                    timezoneOffsetMin={data?.system.timezoneOffsetMin ?? 600}
                    maxPowerHint={(() => {
                      // Parse solar size (format: "9 kW")
                      let solarKW: number | undefined;
                      if (systemInfo?.solarSize) {
                        const solarMatch = systemInfo.solarSize.match(
                          /^(\d+(?:\.\d+)?)\s+kW$/i,
                        );
                        if (solarMatch) {
                          solarKW = parseFloat(solarMatch[1]);
                        }
                      }

                      // Parse inverter rating (format: "7.5kW, 48V")
                      let inverterKW: number | undefined;
                      if (systemInfo?.ratings) {
                        const ratingMatch =
                          systemInfo.ratings.match(/(\d+(?:\.\d+)?)kW/i);
                        if (ratingMatch) {
                          inverterKW = parseFloat(ratingMatch[1]);
                        }
                      }

                      if (solarKW !== undefined && inverterKW !== undefined) {
                        return Math.max(solarKW, inverterKW);
                      }
                      return solarKW ?? inverterKW;
                    })()}
                  />
                )}
              </div>
            </ChartFocusProvider>
          )}

          {/* Generator runs — only when this system has an enabled generator tracker */}
          {cardVisible("generator-runs") && hasGenerator && (
            <div className="mt-4 px-1">
              <GeneratorRunsCard
                systemId={parseInt(systemId)}
                runningOverride={generatorRunningFromLatest(data!.latest)}
              />
            </div>
          )}
        </div>
      )}
    </main>
  );
}
