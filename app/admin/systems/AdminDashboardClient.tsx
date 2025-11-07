"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import {
  Clock,
  Wifi,
  WifiOff,
  Battery,
  Home,
  PauseCircle,
  Sun,
} from "lucide-react";
import SystemInfoTooltip from "@/components/SystemInfoTooltip";
import SystemActionsMenu from "@/components/SystemActionsMenu";
import PollingStatsModal from "@/components/PollingStatsModal";
import TestConnectionModal from "@/components/TestConnectionModal";
import SystemSettingsDialog from "@/components/SystemSettingsDialog";
import PollNowModal from "@/components/PollNowModal";
import ViewDataModal from "@/components/ViewDataModal";
import { formatDateTime, formatTime } from "@/lib/fe-date-format";

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
    dataStore?: "readings" | "point_readings";
  };
  status: "active" | "disabled" | "removed"; // System status
  location?: any; // Location data
  metadata?: any; // Vendor-specific metadata (e.g., composite system configuration)
  compositeSourceSystems?: Array<{ id: number; shortName: string | null }>; // Only present for composite systems
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

/**
 * Format composite source systems for display
 * Uses shortnames where available, falls back to "ID: X" format
 * - "(drawn from kinkora)"
 * - "(drawn from kinkora and hawthorn)"
 * - "(drawn from kinkora, hawthorn and ID: 3)"
 */
function formatCompositeSourceSystems(
  systems: Array<{ id: number; shortName: string | null }> | undefined,
): string {
  if (!systems || systems.length === 0) return "(no systems)";

  // Format each system: use shortname if available, otherwise "ID: X"
  const formatted = systems.map((s) => s.shortName || `ID: ${s.id}`);

  if (formatted.length === 1) return `(drawn from ${formatted[0]})`;
  if (formatted.length === 2)
    return `(drawn from ${formatted[0]} and ${formatted[1]})`;

  // Three or more: "(drawn from kinkora, hawthorn and ID: 3)"
  const allButLast = formatted.slice(0, -1).join(", ");
  const last = formatted[formatted.length - 1];
  return `(drawn from ${allButLast} and ${last})`;
}

export default function AdminDashboardClient() {
  const [systems, setSystems] = useState<SystemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  }>({
    isOpen: false,
    systemId: null,
    displayName: null,
    vendorType: null,
  });
  const [viewDataModal, setViewDataModal] = useState<{
    isOpen: boolean;
    systemId: number | null;
    systemName: string | null;
    vendorType: string | null;
    vendorSiteId: string | null;
  }>({
    isOpen: false,
    systemId: null,
    systemName: null,
    vendorType: null,
    vendorSiteId: null,
  });

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

  const openPollNowModal = (system: SystemData) => {
    setPollNowModal({
      isOpen: true,
      systemId: system.systemId,
      displayName: system.displayName,
      vendorType: system.vendor.type,
    });
  };

  const closePollNowModal = () => {
    setPollNowModal({
      isOpen: false,
      systemId: null,
      displayName: null,
      vendorType: null,
    });
  };

  // Track if any modal is open
  const isAnyModalOpen = () => {
    return (
      testModal.isOpen ||
      pollingStatsModal.isOpen ||
      settingsModal.isOpen ||
      pollNowModal.isOpen ||
      viewDataModal.isOpen
    );
  };

  const fetchSystems = async () => {
    // Skip fetch if any modal is open
    if (isAnyModalOpen()) {
      console.log("[AdminDashboard] Skipping fetch - modal is open");
      return;
    }

    try {
      const response = await fetch("/api/admin/systems");

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = "/sign-in";
          return;
        }
        throw new Error("Failed to fetch systems");
      }

      const data = await response.json();

      if (data.success) {
        setSystems(data.systems || []);
        setError(null);
      } else {
        setError(data.error || "Failed to load systems");
      }
    } catch (err) {
      console.error("Error fetching systems:", err);
      setError("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  };

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

      // Update local state
      setSystems((prevSystems) =>
        prevSystems.map((sys) =>
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

  const updateSystem = async (
    systemId: number,
    updates: { displayName?: string; shortName?: string | null },
  ) => {
    try {
      const response = await fetch(`/api/admin/systems/${systemId}/settings`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update system");
      }

      const result = await response.json();

      // Update the system in the local state
      setSystems((prev) =>
        prev.map((s) => (s.systemId === systemId ? { ...s, ...updates } : s)),
      );

      // Update the settings dialog state if it's the same system
      setSettingsDialog((prev) =>
        prev.system?.systemId === systemId
          ? { ...prev, system: { ...prev.system, ...updates } }
          : prev,
      );

      return result;
    } catch (err) {
      console.error("Error updating system:", err);
      throw err; // Re-throw to be handled by the dialog
    }
  };

  // Use ref to store interval ID so we can access it in cleanup
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchSystems();
    intervalRef.current = setInterval(fetchSystems, 30000); // Refresh every 30 seconds

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  // Pause/resume fetching based on modal state
  useEffect(() => {
    if (isAnyModalOpen()) {
      // Modal opened - clear interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        console.log("[AdminDashboard] Paused auto-refresh - modal opened");
      }
    } else {
      // No modals open - restart interval if it's not running
      if (!intervalRef.current) {
        fetchSystems(); // Fetch immediately
        intervalRef.current = setInterval(fetchSystems, 30000);
        console.log("[AdminDashboard] Resumed auto-refresh - modals closed");
      }
    }
  }, [
    testModal.isOpen,
    pollingStatsModal.isOpen,
    settingsModal.isOpen,
    pollNowModal.isOpen,
    viewDataModal.isOpen,
  ]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading admin dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col">
        <div className="px-0 md:px-6 pt-3 pb-0 flex flex-col">
          {error && (
            <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          {/* Systems Table */}
          <div className="bg-gray-800 border-t md:border border-gray-700 md:rounded-t overflow-hidden flex flex-col">
            <div className="border-b border-gray-700">
              <div className="flex items-end -mb-px">
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
                            dataStore={system.vendor.dataStore}
                            onTest={() => openTestModal(system)}
                            onPollNow={() => openPollNowModal(system)}
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
                                  {system.vendor.type === "composite" &&
                                  system.compositeSourceSystems
                                    ? formatCompositeSourceSystems(
                                        system.compositeSourceSystems,
                                      )
                                    : `${system.vendor.type}/${system.vendor.siteId}`}
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
                          {system.data ? (
                            <div className="text-sm">
                              <div className="flex flex-col items-start gap-1 xl:flex-row xl:items-center xl:gap-4">
                                <div className="flex items-center gap-1.5">
                                  <Sun className="w-3.5 h-3.5 text-yellow-400" />
                                  <span className="text-yellow-400">
                                    {(system.data.solarPower / 1000).toFixed(1)}{" "}
                                    kW
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Home className="w-3.5 h-3.5 text-blue-400" />
                                  <span className="text-blue-400">
                                    {(system.data.loadPower / 1000).toFixed(1)}{" "}
                                    kW
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Battery className="w-3.5 h-3.5 text-green-400" />
                                  <span className="text-green-400">
                                    {system.data.batterySOC.toFixed(1)}%
                                  </span>
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
                                        return pollDate.toLocaleDateString(
                                          undefined,
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
        system={
          settingsModal.system
            ? {
                systemId: settingsModal.system.systemId,
                displayName: settingsModal.system.displayName,
                shortName: settingsModal.system.shortName,
                vendorType: settingsModal.system.vendor.type,
                metadata: settingsModal.system.metadata,
              }
            : null
        }
        isAdmin={true}
        onUpdate={updateSystem}
      />

      {/* Poll Now Modal */}
      {pollNowModal.isOpen && pollNowModal.systemId && (
        <PollNowModal
          systemId={pollNowModal.systemId}
          displayName={pollNowModal.displayName}
          vendorType={pollNowModal.vendorType}
          onClose={closePollNowModal}
        />
      )}

      {/* View Data Modal */}
      {viewDataModal.isOpen &&
        viewDataModal.systemId &&
        viewDataModal.systemName &&
        viewDataModal.vendorType &&
        viewDataModal.vendorSiteId && (
          <ViewDataModal
            isOpen={viewDataModal.isOpen}
            onClose={() =>
              setViewDataModal({
                isOpen: false,
                systemId: null,
                systemName: null,
                vendorType: null,
                vendorSiteId: null,
              })
            }
            systemId={viewDataModal.systemId}
            systemName={viewDataModal.systemName}
            vendorType={viewDataModal.vendorType}
            vendorSiteId={viewDataModal.vendorSiteId}
          />
        )}
    </>
  );
}
