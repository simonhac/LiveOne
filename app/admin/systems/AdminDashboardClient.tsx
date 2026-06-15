"use client";

import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Clock,
  Wifi,
  WifiOff,
  Battery,
  Home,
  PauseCircle,
  Sun,
  PlayCircle,
} from "lucide-react";
import SystemInfoTooltip from "@/components/SystemInfoTooltip";
import SystemActionsMenu from "@/components/SystemActionsMenu";
import PollingStatsModal from "@/components/PollingStatsModal";
import TestConnectionModal from "@/components/TestConnectionModal";
import SystemSettingsDialog from "@/components/SystemSettingsDialog";
import PollNowModal from "@/components/PollNowModal";
import ViewDataModal from "@/components/ViewDataModal";
import { PollAllModal } from "@/components/PollAllModal";
import { formatDateTime, formatTime } from "@/lib/fe-date-format";
import type { SystemData as ServerSystemData } from "@/lib/admin/get-systems-data";
import { usePollingState } from "@/hooks/usePollingState";

interface SystemInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface SystemData {
  systemId: number; // Our internal ID
  owner: {
    clerkId: string;
    email: string | null;
    userName: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  displayName: string; // Non-null from database
  shortName: string | null; // Optional short name for history API IDs
  vendor: {
    type: string;
    siteId: string; // Vendor's identifier
    userId: string | null; // Vendor-specific user ID
    supportsPolling?: boolean;
  };
  status: "active" | "disabled" | "removed"; // System status
  location?: any; // Location data
  metadata?: any; // Vendor-specific metadata
  timezoneOffsetMin: number; // Timezone offset in minutes
  systemInfo?: SystemInfo | null;
  polling: {
    isActive: boolean;
    lastPollTime: string | null;
    lastSuccessTime: string | null;
    lastErrorTime: string | null;
    lastError: string | null;
    lastResponse: any | null;
    consecutiveErrors: number;
    totalPolls: number;
    successfulPolls: number;
    failedPolls: number;
    successRate: number;
  };
  data: {
    solarPower: number;
    loadPower: number;
    batteryPower: number;
    batterySOC: number;
    gridPower: number;
    timestamp: string;
  } | null;
}

interface AdminDashboardClientProps {
  initialSystems: ServerSystemData[];
  latestValuesIncluded: boolean;
}

export default function AdminDashboardClient({
  initialSystems,
  latestValuesIncluded,
}: AdminDashboardClientProps) {
  const queryClient = useQueryClient();
  // Track if we need to fetch latest values
  const [needsLatestValues, setNeedsLatestValues] =
    useState(!latestValuesIncluded);
  const [activeTab, setActiveTab] = useState<"active" | "removed">("active");
  const [testModal, setTestModal] = useState<{
    isOpen: boolean;
    systemId: number | null;
    displayName: string | null;
    vendorType: string | null;
  }>({
    isOpen: false,
    systemId: null,
    displayName: null,
    vendorType: null,
  });
  const [pollingStatsModal, setPollingStatsModal] = useState<{
    isOpen: boolean;
    systemId: number | null;
    systemName: string;
    vendorType: string;
    status: "active" | "disabled" | "removed" | null;
    stats: SystemData["polling"] | null;
  }>({
    isOpen: false,
    systemId: null,
    systemName: "",
    vendorType: "",
    status: null,
    stats: null,
  });
  const [settingsModal, setSettingsDialog] = useState<{
    isOpen: boolean;
    system: SystemData | null;
  }>({
    isOpen: false,
    system: null,
  });
  const [pollNowModal, setPollNowModal] = useState<{
    isOpen: boolean;
    systemId: number | null;
    displayName: string | null;
    vendorType: string | null;
    dryRun: boolean;
  }>({
    isOpen: false,
    systemId: null,
    displayName: null,
    vendorType: null,
    dryRun: false,
  });
  const [viewDataModal, setViewDataModal] = useState<{
    isOpen: boolean;
    systemId: number | null;
    systemName: string | null;
    vendorType: string | null;
    vendorSiteId: string | null;
    timezoneOffsetMin: number | null;
  }>({
    isOpen: false,
    systemId: null,
    systemName: null,
    vendorType: null,
    vendorSiteId: null,
    timezoneOffsetMin: null,
  });

  const [pollAllModalOpen, setPollAllModalOpen] = useState(false);

  // Hook for managing polling state via SSE
  const {
    state: pollingState,
    systems: pollingSystems,
    isConnected: isPollingConnected,
    isComplete: isPollingComplete,
    startPolling,
    disconnect: disconnectPolling,
    reset: resetPolling,
  } = usePollingState();

  const openTestModal = (system: SystemData) => {
    setTestModal({
      isOpen: true,
      systemId: system.systemId,
      displayName: system.displayName,
      vendorType: system.vendor.type,
    });
  };

  const closeTestModal = () => {
    setTestModal({
      isOpen: false,
      systemId: null,
      displayName: null,
      vendorType: null,
    });
  };

  const openPollNowModal = (system: SystemData, dryRun: boolean = false) => {
    setPollNowModal({
      isOpen: true,
      systemId: system.systemId,
      displayName: system.displayName,
      vendorType: system.vendor.type,
      dryRun,
    });
  };

  const closePollNowModal = () => {
    setPollNowModal({
      isOpen: false,
      systemId: null,
      displayName: null,
      vendorType: null,
      dryRun: false,
    });
  };

  const handlePollAll = () => {
    setPollAllModalOpen(true);
    startPolling("/api/cron/minutely?force=true&realTime=true");
  };

  const closePollAllModal = () => {
    setPollAllModalOpen(false);
    disconnectPolling();
    resetPolling();
    // Refresh systems list after poll
    refetchSystems();
  };

  // Track if any modal is open
  const isAnyModalOpen = useCallback(() => {
    return (
      testModal.isOpen ||
      pollingStatsModal.isOpen ||
      settingsModal.isOpen ||
      pollNowModal.isOpen ||
      viewDataModal.isOpen ||
      pollAllModalOpen
    );
  }, [
    testModal.isOpen,
    pollingStatsModal.isOpen,
    settingsModal.isOpen,
    pollNowModal.isOpen,
    viewDataModal.isOpen,
    pollAllModalOpen,
  ]);

  const modalOpen = isAnyModalOpen();

  // Auto-refreshing systems list (30s), seeded from server-rendered data. The poll
  // is paused while any modal is open (refetchInterval false) so an open dialog
  // isn't disturbed by a background refresh — matching the legacy interval logic.
  const { data: systemsData, error: queryError } = useQuery({
    queryKey: ["admin", "systems"],
    queryFn: async () => {
      const response = await fetch("/api/admin/systems");

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = "/sign-in";
        }
        throw new Error("Failed to fetch systems");
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Failed to load systems");
      }

      return (data.systems || []) as SystemData[];
    },
    initialData: initialSystems as unknown as SystemData[],
    refetchInterval: modalOpen ? false : 30000,
    refetchOnWindowFocus: false,
  });

  const systems = systemsData ?? [];
  const fetchError = queryError
    ? queryError instanceof Error &&
      queryError.message !== "Failed to fetch systems"
      ? queryError.message
      : "Failed to connect to server"
    : null;
  const displayError = fetchError;

  const refetchSystems = useCallback(() => {
    if (isAnyModalOpen()) {
      console.log("[AdminDashboard] Skipping fetch - modal is open");
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["admin", "systems"] });
  }, [isAnyModalOpen, queryClient]);

  const updateSystemStatus = async (
    systemId: number,
    newStatus: "active" | "disabled" | "removed",
  ) => {
    try {
      const response = await fetch(`/api/admin/systems/${systemId}/status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update status");
      }

      const result = await response.json();

      // Optimistically patch the cached systems list (matches the legacy local update)
      queryClient.setQueryData<SystemData[]>(["admin", "systems"], (prev) =>
        (prev ?? []).map((sys) =>
          sys.systemId === systemId ? { ...sys, status: newStatus } : sys,
        ),
      );

      return result;
    } catch (err) {
      console.error("Error updating system status:", err);
      alert(
        `Failed to update status: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
  };

  const updateSystem = async () => {
    // Refetch systems after update
    refetchSystems();
  };

  // Fetch latest values once if the server-side render timed out before including them.
  useEffect(() => {
    if (needsLatestValues) {
      console.log(
        "[AdminDashboard] Fetching latest values (server-side timed out)",
      );
      queryClient.invalidateQueries({ queryKey: ["admin", "systems"] });
      setNeedsLatestValues(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsLatestValues]);

  // When all modals close, refetch immediately (the legacy interval did a fetch on
  // resume); while a modal is open the poll is paused via refetchInterval above.
  useEffect(() => {
    if (!modalOpen) {
      queryClient.invalidateQueries({ queryKey: ["admin", "systems"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen]);

  return (
    <>
      <div className="flex flex-col">
        <div className="px-0 md:px-6 pt-3 pb-0 flex flex-col">
          {displayError && (
            <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-4">
              {displayError}
            </div>
          )}

          {/* Systems Table */}
          <div className="bg-gray-800 border-t md:border border-gray-700 md:rounded-t overflow-hidden flex flex-col">
            <div className="border-b border-gray-700">
              <div className="flex items-stretch justify-between -mb-px">
                <div className="flex items-stretch">
                  <button
                    onClick={() => setActiveTab("active")}
                    className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                      activeTab === "active"
                        ? "text-white border-blue-500 bg-gray-700/50"
                        : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                    }`}
                  >
                    Active Systems
                  </button>
                  <button
                    onClick={() => setActiveTab("removed")}
                    className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                      activeTab === "removed"
                        ? "text-white border-blue-500 bg-gray-700/50"
                        : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                    }`}
                  >
                    Removed
                  </button>
                </div>
                <button
                  onClick={handlePollAll}
                  disabled={isPollingConnected}
                  className="px-4 py-2 m-3 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded transition-colors flex items-center gap-2"
                >
                  <PlayCircle className="w-4 h-4" />
                  Poll All
                </button>
              </div>
            </div>

            <div className="overflow-auto bg-gray-900 max-h-[calc(100vh-100px)]">
              <table className="w-full">
                <thead className="sticky top-0 bg-gray-800 z-10">
                  <tr className="border-b border-gray-700">
                    <th className="w-5"></th>
                    <th className="text-left px-1.5 md:px-1.5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                      System
                    </th>
                    <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Owner
                    </th>
                    <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Readings
                    </th>
                    <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Last Poll
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {systems
                    .filter((system) =>
                      activeTab === "active"
                        ? system.status === "active" ||
                          system.status === "disabled"
                        : system.status === "removed",
                    )
                    .map((system, index, filteredSystems) => (
                      <tr
                        key={system.systemId}
                        className={`${
                          index % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"
                        } hover:bg-gray-700/50 transition-colors border-b border-gray-700 relative ${
                          system.status === "disabled" ? "opacity-40" : ""
                        }`}
                        style={
                          system.status === "removed"
                            ? {
                                backgroundImage:
                                  "repeating-linear-gradient(135deg, transparent, transparent 10px, rgba(251,146,60,0.15) 10px, rgba(251,146,60,0.15) 20px)",
                              }
                            : undefined
                        }
                      >
                        <td className="w-5 align-top pt-3 text-center">
                          <SystemActionsMenu
                            systemId={system.systemId}
                            systemName={system.displayName}
                            status={system.status}
                            vendorType={system.vendor.type}
                            supportsPolling={system.vendor.supportsPolling}
                            onTest={() => openTestModal(system)}
                            onPollNow={(dryRun) =>
                              openPollNowModal(system, dryRun)
                            }
                            onStatusChange={(newStatus) =>
                              updateSystemStatus(system.systemId, newStatus)
                            }
                            onPollingStats={() => {
                              setPollingStatsModal({
                                isOpen: true,
                                systemId: system.systemId,
                                systemName: system.displayName,
                                vendorType: system.vendor.type,
                                status: system.status,
                                stats: system.polling,
                              });
                            }}
                            onSettings={() => {
                              setSettingsDialog({
                                isOpen: true,
                                system: system,
                              });
                            }}
                            onViewData={() => {
                              setViewDataModal({
                                isOpen: true,
                                systemId: system.systemId,
                                systemName: system.displayName,
                                vendorType: system.vendor.type,
                                vendorSiteId: system.vendor.siteId,
                                timezoneOffsetMin: system.timezoneOffsetMin,
                              });
                            }}
                          />
                        </td>
                        <td className="px-1.5 md:px-1.5 py-4 whitespace-nowrap align-top">
                          <Link
                            href={`/dashboard/${system.systemId}`}
                            className="block group"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">
                                {system.displayName}
                              </span>
                              {system.shortName && (
                                <span className="text-sm text-gray-400">
                                  ({system.shortName})
                                </span>
                              )}
                              <span className="text-sm text-gray-500">
                                ID: {system.systemId}
                              </span>
                              {system.status === "disabled" && (
                                <div className="relative group/pause">
                                  <PauseCircle className="w-4 h-4 text-orange-400" />
                                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover/pause:opacity-100 pointer-events-none transition-opacity z-10 border border-gray-700">
                                    System Disabled
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-gray-400 group-hover:text-blue-400 transition-colors">
                                  {`${system.vendor.type}/${system.vendor.siteId}`}
                                </span>
                                {system.systemInfo && (
                                  <div onClick={(e) => e.preventDefault()}>
                                    <SystemInfoTooltip
                                      systemInfo={system.systemInfo}
                                      systemNumber={system.vendor.siteId}
                                    />
                                  </div>
                                )}
                              </div>
                              {system.vendor.userId && (
                                <span className="text-xs text-gray-500">
                                  {system.vendor.userId}
                                </span>
                              )}
                            </div>
                          </Link>
                        </td>
                        <td className="px-2 md:px-6 py-4 whitespace-nowrap align-top">
                          <div className="text-sm">
                            <div className="text-gray-300">
                              {system.owner.userName ||
                                system.owner.clerkId ||
                                "unknown"}
                              {(system.owner.firstName ||
                                system.owner.lastName) && (
                                <span className="text-gray-400 hidden xl:inline">
                                  {" "}
                                  ({system.owner.firstName || ""}
                                  {system.owner.firstName &&
                                  system.owner.lastName
                                    ? " "
                                    : ""}
                                  {system.owner.lastName || ""})
                                </span>
                              )}
                            </div>
                            {(system.owner.firstName ||
                              system.owner.lastName) && (
                              <div className="text-xs text-gray-400 xl:hidden">
                                {system.owner.firstName || ""}
                                {system.owner.firstName && system.owner.lastName
                                  ? " "
                                  : ""}
                                {system.owner.lastName || ""}
                              </div>
                            )}
                            {system.owner.email && (
                              <a
                                href={`mailto:${system.owner.email}`}
                                className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                              >
                                {system.owner.email}
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-2 md:px-6 py-4 whitespace-nowrap">
                          {system.data &&
                          (system.data.solarPower != null ||
                            system.data.loadPower != null ||
                            system.data.batterySOC != null) ? (
                            <div className="text-sm">
                              <div className="flex flex-col items-start gap-1 xl:flex-row xl:items-center xl:gap-0">
                                {/* Solar - fixed width */}
                                <div className="min-w-[70px] xl:min-w-[75px]">
                                  {system.data.solarPower != null ? (
                                    <div className="flex items-center gap-1.5">
                                      <Sun className="w-3.5 h-3.5 text-yellow-400" />
                                      <span className="text-yellow-400">
                                        {(
                                          system.data.solarPower / 1000
                                        ).toFixed(1)}{" "}
                                        kW
                                      </span>
                                    </div>
                                  ) : (
                                    <span />
                                  )}
                                </div>
                                {/* Load - fixed width */}
                                <div className="min-w-[70px] xl:min-w-[75px]">
                                  {system.data.loadPower != null ? (
                                    <div className="flex items-center gap-1.5">
                                      <Home className="w-3.5 h-3.5 text-blue-400" />
                                      <span className="text-blue-400">
                                        {(system.data.loadPower / 1000).toFixed(
                                          1,
                                        )}{" "}
                                        kW
                                      </span>
                                    </div>
                                  ) : (
                                    <span />
                                  )}
                                </div>
                                {/* Battery SOC - fixed width */}
                                <div className="min-w-[65px] xl:min-w-[70px]">
                                  {system.data.batterySOC != null ? (
                                    <div className="flex items-center gap-1.5">
                                      <Battery className="w-3.5 h-3.5 text-green-400" />
                                      <span className="text-green-400">
                                        {system.data.batterySOC.toFixed(1)}%
                                      </span>
                                    </div>
                                  ) : (
                                    <span />
                                  )}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <span className="text-sm text-gray-500">—</span>
                          )}
                        </td>
                        <td className="px-2 md:px-6 py-4 whitespace-nowrap align-baseline">
                          <div className="sm:block flex flex-col">
                            <div>
                              {!system.polling.isActive ? (
                                <div>
                                  <span className="text-sm text-red-400">
                                    Polling disabled
                                  </span>
                                </div>
                              ) : system.polling.lastPollTime ? (
                                <div className="text-xs text-gray-400">
                                  <div>
                                    <Clock className="w-3 h-3 inline mr-1" />
                                    {(() => {
                                      const result = formatDateTime(
                                        system.polling.lastPollTime,
                                      );
                                      if (result.isToday) {
                                        return result.time;
                                      } else {
                                        const pollDate = new Date(
                                          system.polling.lastPollTime,
                                        );
                                        // Use fixed locale to avoid SSR hydration mismatch
                                        return pollDate.toLocaleDateString(
                                          "en-AU",
                                          { month: "short", day: "numeric" },
                                        );
                                      }
                                    })()}
                                  </div>
                                  {(() => {
                                    const result = formatDateTime(
                                      system.polling.lastPollTime,
                                    );
                                    if (!result.isToday) {
                                      return (
                                        <div className="ml-4">
                                          {result.time}
                                        </div>
                                      );
                                    }
                                    return null;
                                  })()}
                                </div>
                              ) : (
                                <span className="text-sm text-gray-500">
                                  Never
                                </span>
                              )}
                              {system.polling.lastError && (
                                <p
                                  className="text-xs text-red-400 mt-1 max-w-xs truncate"
                                  title={system.polling.lastError}
                                >
                                  {system.polling.lastError}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Test Connection Modal - Using TestConnectionModal component */}
      {testModal.isOpen && testModal.systemId && (
        <TestConnectionModal
          systemId={testModal.systemId}
          displayName={testModal.displayName}
          vendorType={testModal.vendorType}
          onClose={closeTestModal}
        />
      )}

      {/* Polling Stats Modal */}
      {pollingStatsModal.isOpen && pollingStatsModal.stats && (
        <PollingStatsModal
          isOpen={pollingStatsModal.isOpen}
          onClose={() =>
            setPollingStatsModal({
              isOpen: false,
              systemId: null,
              systemName: "",
              vendorType: "",
              status: null,
              stats: null,
            })
          }
          systemId={pollingStatsModal.systemId}
          systemName={pollingStatsModal.systemName}
          vendorType={pollingStatsModal.vendorType}
          status={pollingStatsModal.status}
          stats={pollingStatsModal.stats}
        />
      )}

      {/* System Settings Dialog */}
      <SystemSettingsDialog
        isOpen={settingsModal.isOpen}
        onClose={() => setSettingsDialog({ isOpen: false, system: null })}
        systemId={settingsModal.system?.systemId ?? null}
        vendorType={settingsModal.system?.vendor.type}
        metadata={settingsModal.system?.metadata}
        ownerClerkUserId={settingsModal.system?.owner.clerkId}
        isAdmin={true}
        onUpdate={updateSystem}
      />

      {/* Poll Now Modal */}
      {pollNowModal.isOpen && pollNowModal.systemId && (
        <PollNowModal
          systemId={pollNowModal.systemId}
          displayName={pollNowModal.displayName}
          vendorType={pollNowModal.vendorType}
          dryRun={pollNowModal.dryRun}
          onClose={closePollNowModal}
        />
      )}

      {/* View Data Modal */}
      {viewDataModal.isOpen &&
        viewDataModal.systemId &&
        viewDataModal.systemName &&
        viewDataModal.vendorType &&
        viewDataModal.vendorSiteId &&
        viewDataModal.timezoneOffsetMin !== null && (
          <ViewDataModal
            isOpen={viewDataModal.isOpen}
            onClose={() =>
              setViewDataModal({
                isOpen: false,
                systemId: null,
                systemName: null,
                vendorType: null,
                vendorSiteId: null,
                timezoneOffsetMin: null,
              })
            }
            systemId={viewDataModal.systemId}
            systemName={viewDataModal.systemName}
            vendorType={viewDataModal.vendorType}
            vendorSiteId={viewDataModal.vendorSiteId}
            timezoneOffsetMin={viewDataModal.timezoneOffsetMin}
          />
        )}

      {/* Poll All Modal */}
      <PollAllModal
        isOpen={pollAllModalOpen}
        onClose={closePollAllModal}
        sessionState={pollingState}
        onPollAgain={handlePollAll}
        isPolling={isPollingConnected}
      />
    </>
  );
}
