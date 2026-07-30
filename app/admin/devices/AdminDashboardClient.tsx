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
import DeviceInfoTooltip from "@/components/DeviceInfoTooltip";
import DeviceActionsMenu from "@/components/DeviceActionsMenu";
import PollingStatsModal from "@/components/PollingStatsModal";
import TestConnectionModal from "@/components/TestConnectionModal";
import DeviceSettingsDialog from "@/components/DeviceSettingsDialog";
import PollNowModal from "@/components/PollNowModal";
import ViewDataModal from "@/components/ViewDataModal";
import { PollAllModal } from "@/components/PollAllModal";
import { formatDateTime, formatTime } from "@/lib/fe-date-format";
import type { DeviceData as ServerDeviceData } from "@/lib/admin/get-devices-data";
import { usePollingState } from "@/hooks/usePollingState";

interface DeviceInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface DeviceData {
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
  status: "active" | "disabled" | "removed"; // Device status
  location?: any; // Location data
  metadata?: any; // Vendor-specific metadata
  timezoneOffsetMin: number; // Timezone offset in minutes
  deviceInfo?: DeviceInfo | null;
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
  initialDevices: ServerDeviceData[];
  latestValuesIncluded: boolean;
}

export default function AdminDashboardClient({
  initialDevices,
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
    deviceName: string;
    vendorType: string;
    status: "active" | "disabled" | "removed" | null;
    stats: DeviceData["polling"] | null;
  }>({
    isOpen: false,
    systemId: null,
    deviceName: "",
    vendorType: "",
    status: null,
    stats: null,
  });
  const [settingsModal, setSettingsDialog] = useState<{
    isOpen: boolean;
    device: DeviceData | null;
  }>({
    isOpen: false,
    device: null,
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
    deviceName: string | null;
    vendorType: string | null;
    vendorSiteId: string | null;
    timezoneOffsetMin: number | null;
  }>({
    isOpen: false,
    systemId: null,
    deviceName: null,
    vendorType: null,
    vendorSiteId: null,
    timezoneOffsetMin: null,
  });

  const [pollAllModalOpen, setPollAllModalOpen] = useState(false);

  // Hook for managing polling state via SSE
  const {
    state: pollingState,
    devices: pollingDevices,
    isConnected: isPollingConnected,
    isComplete: isPollingComplete,
    startPolling,
    disconnect: disconnectPolling,
    reset: resetPolling,
  } = usePollingState();

  const openTestModal = (device: DeviceData) => {
    setTestModal({
      isOpen: true,
      systemId: device.systemId,
      displayName: device.displayName,
      vendorType: device.vendor.type,
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

  const openPollNowModal = (device: DeviceData, dryRun: boolean = false) => {
    setPollNowModal({
      isOpen: true,
      systemId: device.systemId,
      displayName: device.displayName,
      vendorType: device.vendor.type,
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
    // Refresh devices list after poll
    refetchDevices();
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

  // Auto-refreshing devices list (30s), seeded from server-rendered data. The poll
  // is paused while any modal is open (refetchInterval false) so an open dialog
  // isn't disturbed by a background refresh — matching the legacy interval logic.
  const { data: devicesData, error: queryError } = useQuery({
    queryKey: ["admin", "systems"],
    queryFn: async () => {
      const response = await fetch("/api/admin/devices");

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

      return (data.devices || []) as DeviceData[];
    },
    initialData: initialDevices as unknown as DeviceData[],
    refetchInterval: modalOpen ? false : 30000,
    refetchOnWindowFocus: false,
  });

  const devices = devicesData ?? [];
  const fetchError = queryError
    ? queryError instanceof Error &&
      queryError.message !== "Failed to fetch systems"
      ? queryError.message
      : "Failed to connect to server"
    : null;
  const displayError = fetchError;

  const refetchDevices = useCallback(() => {
    if (isAnyModalOpen()) {
      console.log("[AdminDashboard] Skipping fetch - modal is open");
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["admin", "systems"] });
  }, [isAnyModalOpen, queryClient]);

  const updateDeviceStatus = async (
    systemId: number,
    newStatus: "active" | "disabled" | "removed",
  ) => {
    try {
      const response = await fetch(`/api/admin/devices/${systemId}/status`, {
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

      // Optimistically patch the cached devices list (matches the legacy local update)
      queryClient.setQueryData<DeviceData[]>(["admin", "systems"], (prev) =>
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

  const updateDevice = async () => {
    // Refetch devices after update
    refetchDevices();
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

          {/* Devices Table */}
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
                    Active Devices
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
                      Device
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
                  {devices
                    .filter((device) =>
                      activeTab === "active"
                        ? device.status === "active" ||
                          device.status === "disabled"
                        : device.status === "removed",
                    )
                    .map((device, index, filteredDevices) => (
                      <tr
                        key={device.systemId}
                        className={`${
                          index % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"
                        } hover:bg-gray-700/50 transition-colors border-b border-gray-700 relative ${
                          device.status === "disabled" ? "opacity-40" : ""
                        }`}
                        style={
                          device.status === "removed"
                            ? {
                                backgroundImage:
                                  "repeating-linear-gradient(135deg, transparent, transparent 10px, rgba(251,146,60,0.15) 10px, rgba(251,146,60,0.15) 20px)",
                              }
                            : undefined
                        }
                      >
                        <td className="w-5 align-top pt-3 text-center">
                          <DeviceActionsMenu
                            systemId={device.systemId}
                            deviceName={device.displayName}
                            status={device.status}
                            vendorType={device.vendor.type}
                            supportsPolling={device.vendor.supportsPolling}
                            onTest={() => openTestModal(device)}
                            onPollNow={(dryRun) =>
                              openPollNowModal(device, dryRun)
                            }
                            onStatusChange={(newStatus) =>
                              updateDeviceStatus(device.systemId, newStatus)
                            }
                            onPollingStats={() => {
                              setPollingStatsModal({
                                isOpen: true,
                                systemId: device.systemId,
                                deviceName: device.displayName,
                                vendorType: device.vendor.type,
                                status: device.status,
                                stats: device.polling,
                              });
                            }}
                            onSettings={() => {
                              setSettingsDialog({
                                isOpen: true,
                                device: device,
                              });
                            }}
                            onViewData={() => {
                              setViewDataModal({
                                isOpen: true,
                                systemId: device.systemId,
                                deviceName: device.displayName,
                                vendorType: device.vendor.type,
                                vendorSiteId: device.vendor.siteId,
                                timezoneOffsetMin: device.timezoneOffsetMin,
                              });
                            }}
                          />
                        </td>
                        <td className="px-1.5 md:px-1.5 py-4 whitespace-nowrap align-top">
                          <Link
                            href={`/device/${device.systemId}`}
                            className="block group"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">
                                {device.displayName}
                              </span>
                              {device.shortName && (
                                <span className="text-sm text-gray-400">
                                  ({device.shortName})
                                </span>
                              )}
                              <span className="text-sm text-gray-500">
                                ID: {device.systemId}
                              </span>
                              {device.status === "disabled" && (
                                <div className="relative group/pause">
                                  <PauseCircle className="w-4 h-4 text-orange-400" />
                                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover/pause:opacity-100 pointer-events-none transition-opacity z-10 border border-gray-700">
                                    Device Disabled
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-gray-400 group-hover:text-blue-400 transition-colors">
                                  {`${device.vendor.type}/${device.vendor.siteId}`}
                                </span>
                                {device.deviceInfo && (
                                  <div onClick={(e) => e.preventDefault()}>
                                    <DeviceInfoTooltip
                                      deviceInfo={device.deviceInfo}
                                      systemNumber={device.vendor.siteId}
                                    />
                                  </div>
                                )}
                              </div>
                              {device.vendor.userId && (
                                <span className="text-xs text-gray-500">
                                  {device.vendor.userId}
                                </span>
                              )}
                            </div>
                          </Link>
                        </td>
                        <td className="px-2 md:px-6 py-4 whitespace-nowrap align-top">
                          <div className="text-sm">
                            <div className="text-gray-300">
                              {device.owner.userName ||
                                device.owner.clerkId ||
                                "unknown"}
                              {(device.owner.firstName ||
                                device.owner.lastName) && (
                                <span className="text-gray-400 hidden xl:inline">
                                  {" "}
                                  ({device.owner.firstName || ""}
                                  {device.owner.firstName &&
                                  device.owner.lastName
                                    ? " "
                                    : ""}
                                  {device.owner.lastName || ""})
                                </span>
                              )}
                            </div>
                            {(device.owner.firstName ||
                              device.owner.lastName) && (
                              <div className="text-xs text-gray-400 xl:hidden">
                                {device.owner.firstName || ""}
                                {device.owner.firstName && device.owner.lastName
                                  ? " "
                                  : ""}
                                {device.owner.lastName || ""}
                              </div>
                            )}
                            {device.owner.email && (
                              <a
                                href={`mailto:${device.owner.email}`}
                                className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                              >
                                {device.owner.email}
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-2 md:px-6 py-4 whitespace-nowrap">
                          {device.data &&
                          (device.data.solarPower != null ||
                            device.data.loadPower != null ||
                            device.data.batterySOC != null) ? (
                            <div className="text-sm">
                              <div className="flex flex-col items-start gap-1 xl:flex-row xl:items-center xl:gap-0">
                                {/* Solar - fixed width */}
                                <div className="min-w-[70px] xl:min-w-[75px]">
                                  {device.data.solarPower != null ? (
                                    <div className="flex items-center gap-1.5">
                                      <Sun className="w-3.5 h-3.5 text-yellow-400" />
                                      <span className="text-yellow-400">
                                        {(
                                          device.data.solarPower / 1000
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
                                  {device.data.loadPower != null ? (
                                    <div className="flex items-center gap-1.5">
                                      <Home className="w-3.5 h-3.5 text-blue-400" />
                                      <span className="text-blue-400">
                                        {(device.data.loadPower / 1000).toFixed(
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
                                  {device.data.batterySOC != null ? (
                                    <div className="flex items-center gap-1.5">
                                      <Battery className="w-3.5 h-3.5 text-green-400" />
                                      <span className="text-green-400">
                                        {device.data.batterySOC.toFixed(1)}%
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
                              {!device.polling.isActive ? (
                                <div>
                                  <span className="text-sm text-red-400">
                                    Polling disabled
                                  </span>
                                </div>
                              ) : device.polling.lastPollTime ? (
                                <div className="text-xs text-gray-400">
                                  <div>
                                    <Clock className="w-3 h-3 inline mr-1" />
                                    {(() => {
                                      const result = formatDateTime(
                                        device.polling.lastPollTime,
                                      );
                                      if (result.isToday) {
                                        return result.time;
                                      } else {
                                        const pollDate = new Date(
                                          device.polling.lastPollTime,
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
                                      device.polling.lastPollTime,
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
                              {device.polling.lastError && (
                                <p
                                  className="text-xs text-red-400 mt-1 max-w-xs truncate"
                                  title={device.polling.lastError}
                                >
                                  {device.polling.lastError}
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
              deviceName: "",
              vendorType: "",
              status: null,
              stats: null,
            })
          }
          systemId={pollingStatsModal.systemId}
          deviceName={pollingStatsModal.deviceName}
          vendorType={pollingStatsModal.vendorType}
          status={pollingStatsModal.status}
          stats={pollingStatsModal.stats}
        />
      )}

      {/* Device Settings Dialog */}
      <DeviceSettingsDialog
        isOpen={settingsModal.isOpen}
        onClose={() => setSettingsDialog({ isOpen: false, device: null })}
        systemId={settingsModal.device?.systemId ?? null}
        vendorType={settingsModal.device?.vendor.type}
        metadata={settingsModal.device?.metadata}
        ownerClerkUserId={settingsModal.device?.owner.clerkId}
        isAdmin={true}
        onUpdate={updateDevice}
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
        viewDataModal.deviceName &&
        viewDataModal.vendorType &&
        viewDataModal.vendorSiteId &&
        viewDataModal.timezoneOffsetMin !== null && (
          <ViewDataModal
            isOpen={viewDataModal.isOpen}
            onClose={() =>
              setViewDataModal({
                isOpen: false,
                systemId: null,
                deviceName: null,
                vendorType: null,
                vendorSiteId: null,
                timezoneOffsetMin: null,
              })
            }
            systemId={viewDataModal.systemId}
            deviceName={viewDataModal.deviceName}
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
