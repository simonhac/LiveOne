"use client";

import { useState, useEffect, useMemo, Fragment, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useModalContext } from "@/contexts/ModalContext";
import { dashboardDataQuery, dashboardDescriptorQuery } from "@/lib/queries";
import { gridLatestFromData } from "@/lib/grid/latest";
import { generatorRunningFromLatest } from "@/lib/generator/running";
import GridSignalsCard from "@/components/GridSignalsCard";
import { nemRegionShortLabel } from "@/lib/vendors/openelectricity/region";
import type { GridContext } from "@/lib/grid/types";
import EnergyChart from "@/components/EnergyChart";
import AmberCard from "@/components/AmberCard";
import AmberNow from "@/components/AmberNow";
import AmberSmallCard from "@/components/AmberSmallCard";
import SiteChartsCard from "@/components/SiteChartsCard";
import GeneratorRunsCard from "@/components/GeneratorRunsCard";
import { useTileNodes } from "@/app/components/cards/useTileNodes";
import DashboardCustomizeDialog from "@/components/DashboardCustomizeDialog";
import { useDashboardCustomize } from "@/contexts/DashboardCustomizeContext";
import {
  buildDefaultDescriptor,
  normalizeDescriptor,
  tilesConfigOf,
  isCardVisible,
  type DashboardDescriptor,
} from "@/lib/dashboard/descriptor";
import {
  CARD_REGISTRY,
  availableTiles,
  TILE_IDS,
  type DashboardCardType,
} from "@/lib/dashboard/cards";
import { formatDateTime } from "@/lib/fe-date-format";
import type { LatestPointValues } from "@/lib/types/api";
import { AlertTriangle, Home } from "lucide-react";
import Link from "next/link";

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
    pollingStatus: {
      lastPollTime: string | null;
      lastSuccessTime: string | null;
      lastErrorTime: string | null;
      lastError: string | null;
      consecutiveErrors: number;
      totalPolls: number;
      successfulPolls: number;
      isActive: boolean;
    } | null;
  };
  latest: LatestPointValues;
  historical: {
    yesterday: {
      date: string;
      energy: {
        solarKwh: number | null;
        loadKwh: number | null;
        batteryChargeKwh: number | null;
        batteryDischargeKwh: number | null;
        gridImportKwh: number | null;
        gridExportKwh: number | null;
      };
      power: {
        solar: {
          minW: number | null;
          avgW: number | null;
          maxW: number | null;
        };
        load: { minW: number | null; avgW: number | null; maxW: number | null };
        battery: {
          minW: number | null;
          avgW: number | null;
          maxW: number | null;
        };
        grid: { minW: number | null; avgW: number | null; maxW: number | null };
      };
      soc: {
        minBattery: number | null;
        avgBattery: number | null;
        maxBattery: number | null;
        endBattery: number | null;
      };
      dataQuality: {
        intervalCount: number | null;
        coverage: string | null;
      };
    } | null;
  };
}

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface DashboardClientProps {
  systemId?: string;
  system?: any; // System object from database
  hasAccess: boolean;
  systemExists: boolean;
  isAdmin: boolean;
  availableSystems?: AvailableSystem[];
  userId?: string;
  /** When true, the long-range (30D) Sankey is served from PG (FLOW_MATRIX_SERVE_FROM_PG). */
  serveFlowFromPg?: boolean;
  /**
   * The "Local Grid (NEM)" card's cross-system context (the public OpenElectricity region serving
   * this Area's location), resolved server-side. Null when off-grid / no region / flags off — the
   * card then defaults off and is not rendered. See areas-and-dashboards.md.
   */
  gridContext?: GridContext | null;
  /** Whether this system has an enabled generator run-tracker (gates the generator-runs card). */
  hasGenerator?: boolean;
}

// Helper function to get stale threshold based on vendor type
function getStaleThreshold(vendorType?: string): number {
  // 35 minutes (2100 seconds) for Enphase, 5 minutes (300 seconds) for selectronic
  return vendorType === "enphase" ? 2100 : 300;
}

export default function DashboardClient({
  systemId,
  system,
  hasAccess,
  systemExists,
  isAdmin: isAdminProp,
  availableSystems = [],
  userId,
  serveFlowFromPg = false,
  gridContext = null,
  hasGenerator = false,
}: DashboardClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [isAdmin, setIsAdmin] = useState(isAdminProp);
  const [currentDisplayName, setCurrentDisplayName] = useState(
    system?.displayName || "",
  );
  const [currentAlias, setCurrentAlias] = useState(system?.alias || null);
  // Site-history "no data" flag, reported up from SiteChartsCard (which owns the site-data query),
  // so the unconfigured-composite warning can render here in its original position.
  const [siteHistoryEmpty, setSiteHistoryEmpty] = useState(false);
  const [currentDisplayTimezone, setCurrentDisplayTimezone] = useState(
    system?.displayTimezone || null,
  );

  // Get modal context to pause polling when modals are open
  const { isAnyModalOpen } = useModalContext();

  // Main dashboard payload via React Query (latest values + system + available systems).
  // Polls every 30s and on focus; paused while a modal is open. A manual Poll-Now
  // invalidates ['data', systemId] through the shared client.
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
  // public OpenElectricity region system (gridContext.regionSystemId) using the SAME generic
  // dashboardDataQuery every other live card uses — just keyed on that system. Disabled (id "") when
  // no region resolves, so a null gridContext is safe. Paused while a modal is open like the others.
  const { data: gridRegionData } = useQuery(
    dashboardDataQuery(gridContext?.regionSystemId ?? "", {
      paused: isAnyModalOpen,
    }),
  );
  const gridValues = useMemo(
    () => gridLatestFromData(gridRegionData),
    [gridRegionData],
  );

  // Persisted/customizable dashboard descriptor. The descriptor query is disabled (systemId "")
  // until a systemId is known.
  const { data: savedDescriptorResp } = useQuery(
    dashboardDescriptorQuery(systemId ?? ""),
  );
  // Customize open/close + availability are shared with the header menu via context (the
  // "Customise…" item lives in DashboardHeader, a sibling subtree). DashboardClient owns the dialog.
  const { setCanCustomize, isCustomizeOpen, closeCustomize } =
    useDashboardCustomize();
  useEffect(() => {
    setCanCustomize(!!data);
    return () => setCanCustomize(false);
  }, [data, setCanCustomize]);

  // Real tile preview nodes for the Customize dialog — the SAME nodes the dashboard renders,
  // so the editor shows cards exactly as they appear. Built unconditionally (before any early
  // return) to keep hook order stable; harmless when data is absent.
  const { cardNodes: tileNodes, available: powerAvailable } = useTileNodes({
    latest: data?.latest ?? {},
    vendorType: data?.system.vendorType ?? "",
    getStaleThreshold,
    showGrid: !!data?.latest?.["bidi.grid/power"],
    systemId: data?.system.id,
    canControl:
      isAdmin || (!!userId && data?.system.ownerClerkUserId === userId),
  });

  // The effective (saved-or-default) descriptor; null until system data has loaded.
  const effectiveDescriptor = useMemo<DashboardDescriptor | null>(() => {
    if (!data?.system) return null;
    const def = buildDefaultDescriptor(data.system, data.latest ?? {}, {
      gridSignalsAvailable: !!gridContext,
    });
    const saved = savedDescriptorResp?.descriptor ?? null;
    return saved ? normalizeDescriptor(saved, def) : def;
  }, [data?.system, data?.latest, savedDescriptorResp, gridContext]);

  // Derive the display error from the query result, preserving the original branches:
  // connection failure, an explicit `error` body, or the "system exists but no charts" marker.
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

  // Helper function to safely get a point value
  // Helper function to get a point (contains value and measurementTime)
  const getPoint = (latest: LatestPointValues | null, pointPath: string) => {
    if (!latest) return null;
    return latest[pointPath] || null;
  };

  // Sync local state with data when loaded (unless user has manually updated)
  useEffect(() => {
    if (data?.system?.displayName && !currentDisplayName) {
      setCurrentDisplayName(data.system.displayName);
    }
  }, [data?.system?.displayName, currentDisplayName]);

  useEffect(() => {
    if (data?.system?.displayTimezone && !currentDisplayTimezone) {
      setCurrentDisplayTimezone(data.system.displayTimezone);
    }
  }, [data?.system?.displayTimezone, currentDisplayTimezone]);

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

  const formatPower = (watts: number) => {
    return `${(watts / 1000).toFixed(1)}\u00A0kW`;
  };

  // Determine the appropriate unit for an energy value

  // Automatically determine if grid information should be shown
  // TODO: Update to use energy counter points when available
  const showGrid = data?.latest
    ? getPoint(data.latest, "bidi.grid/power") !== null
    : false;

  // Active descriptor: the saved-or-default (customizable) descriptor; null only until data has
  // loaded. The layout booleans fall back to vendor_type while it is null (loading).
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

  // Customize (P2) handlers + the cards available on this system (for the dialog).
  const saveDashboard = async (next: DashboardDescriptor) => {
    if (systemId) {
      await fetch(`/api/dashboard/${systemId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ descriptor: next }),
      });
      await queryClient.invalidateQueries({
        queryKey: ["dashboard-descriptor", systemId],
      });
    }
    closeCustomize();
  };
  const resetDashboard = async () => {
    if (systemId) {
      await fetch(`/api/dashboard/${systemId}`, { method: "DELETE" });
      await queryClient.invalidateQueries({
        queryKey: ["dashboard-descriptor", systemId],
      });
    }
    closeCustomize();
  };
  const availableModules = new Set<DashboardCardType>(
    (Object.keys(CARD_REGISTRY) as DashboardCardType[]).filter((t) =>
      CARD_REGISTRY[t].canRender({
        vendorType: data?.system.vendorType ?? "",
        latest: data?.latest ?? {},
        hasGenerator,
      }),
    ),
  );
  const availableTileSet = new Set(
    data?.latest ? availableTiles(data.latest) : [],
  );

  // Unified card grid (HA "Sections" style): the tiles (expanded individually) and the
  // Local Grid (NEM) card flow together in ONE responsive grid — no per-vendor layout fork. Each is
  // a cell; order/visibility come from the descriptor (tilesCfg) exactly as before.
  const tileHidden = new Set(tilesCfg?.hidden ?? []);
  const tileOrder = (tilesCfg?.order ?? [...TILE_IDS]).filter(
    (id) => powerAvailable[id] && !tileHidden.has(id),
  );
  // Render each tile as a DIRECT grid item (no wrapper div) so it stretches to fill its cell;
  // auto-rows-fr (below) keeps every row equal height. This is how the cards "grow into the grid".
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

      {/* Customize dialog — opened from the header "Customise…" menu item. */}
      {data && (
        <DashboardCustomizeDialog
          isOpen={isCustomizeOpen}
          onClose={closeCustomize}
          descriptor={effectiveDescriptor}
          availableModules={availableModules}
          availablePower={availableTileSet}
          powerCardNodes={tileNodes}
          onSave={saveDashboard}
          onReset={resetDashboard}
        />
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
          {/* Fault Warning
                TEMPORARILY DISABLED - Needs composite points implementation

                Previously displayed fault codes from data.latest.system.faultCode
                and timestamps from data.latest.system.faultTimestamp.

                To restore: Add fault code and timestamp as composite points, then update this section to:
                - Check getPointValue(data.latest, "system.fault/code")
                - Use getPointValue(data.latest, "system.fault/timestamp") for timing
                - Parse the measurementTime from the point value
            */}
          {/* {data.latest?.system.faultCode &&
              data.latest.system.faultCode !== 0 &&
              data.latest.system.faultTimestamp &&
              data.latest.system.faultTimestamp > 0 && (
                <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" />
                  <div>
                    <span className="font-semibold">
                      Fault Code {data.latest.system.faultCode}
                    </span>{" "}
                    encountered at{" "}
                    {
                      formatDateTime(
                        new Date(data.latest.system.faultTimestamp * 1000),
                      ).display
                    }
                  </div>
                </div>
              )} */}

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
          {cardVisible("amber-now") && systemId && (
            <>
              <div className="px-1">
                <AmberSmallCard latest={data.latest} />
              </div>
              <AmberNow latest={data.latest} />
            </>
          )}
          {cardVisible("amber-timeline") && systemId && (
            <AmberCard
              systemId={parseInt(systemId)}
              timezoneOffsetMin={data?.system.timezoneOffsetMin ?? 600}
              displayTimezone={data?.system.displayTimezone}
            />
          )}

          {/* Full-width charts (descriptor-gated, no layout fork). The chart cluster JSX below is
              unchanged — only its wrapper/gate changed. */}
          {(isAdmin || system?.status !== "removed") && (
            <div className="space-y-4 px-1">
              {/* Site-charts cluster (load + generation charts, tables, Sankey).
                  Extracted to SiteChartsCard; the inner cardVisible gates no-op for
                  non-site systems. */}
              <SiteChartsCard
                systemId={systemId as string}
                system={system}
                serveFlowFromPg={serveFlowFromPg}
                cardVisible={cardVisible}
                onHistoryEmptyChange={setSiteHistoryEmpty}
              />
              {cardVisible("chart:lines") && (
                // For other systems, show the regular energy chart
                <EnergyChart
                  systemId={parseInt(systemId as string)}
                  vendorType={data?.system.vendorType}
                  className="h-full min-h-[400px]"
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

                    // Return the maximum of both values, or undefined if neither parsed
                    if (solarKW !== undefined && inverterKW !== undefined) {
                      return Math.max(solarKW, inverterKW);
                    }
                    return solarKW ?? inverterKW;
                  })()}
                />
              )}
            </div>
          )}

          {/* Generator runs — only when this system has an enabled generator tracker */}
          {cardVisible("generator-runs") && hasGenerator && systemId && (
            <div className="mt-4 px-1">
              <GeneratorRunsCard
                systemId={parseInt(systemId)}
                runningOverride={generatorRunningFromLatest(data.latest)}
              />
            </div>
          )}

          {/* Energy Panel - Only show for admin or non-removed systems
                TEMPORARILY DISABLED - Needs composite points implementation

                Previously displayed energy data from data.latest.energy with structure:
                {
                  today: { solarKwh, loadKwh, batteryInKwh, batteryOutKwh, gridInKwh, gridOutKwh },
                  total: { solarKwh, loadKwh, batteryInKwh, batteryOutKwh, gridInKwh, gridOutKwh }
                }

                To restore: Add energy counter points to composite system, then:
                1. Create energy object from points like:
                   - getPointValue(data.latest, "source.solar/energy_today")
                   - getPointValue(data.latest, "load/energy_today")
                   - getPointValue(data.latest, "bidi.battery/energy_in_today")
                   - getPointValue(data.latest, "bidi.battery/energy_out_today")
                   - etc.
                2. Pass constructed energy object to EnergyPanel
            */}
          {/* {(isAdmin || system?.status !== "removed") && data.latest && (
              <EnergyPanel
                energy={data.latest.energy}
                historical={data.historical}
                showGrid={showGrid}
              />
            )} */}
        </div>
      )}
    </main>
  );
} // Test comment
