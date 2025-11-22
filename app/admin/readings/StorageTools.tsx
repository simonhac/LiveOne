"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Server, AlertCircle, Globe, Download, RefreshCw } from "lucide-react";
import { formatDateTime, formatDate } from "@/lib/fe-date-format";
import SyncModal from "./SyncModal";

interface TableStat {
  name: string;
  count: number;
  createdAtMinTime?: string;
  createdAtMaxTime?: string;
  updatedAtMinTime?: string;
  updatedAtMaxTime?: string;
  earliestTime?: string;
  latestTime?: string;
  recordsPerDay?: number | null;
  dataSizeMb?: number | null;
  indexSizeMb?: number | null;
}

interface CacheInfo {
  systemsManagerLoadedTime: string | null;
  pointManagerLoadedTime: string | null;
  dbSizesCachedTime?: string | null;
}

interface DatabaseInfo {
  type: "development" | "production";
  provider: string;
  hasSyncStatus?: boolean;
  stats?: {
    tableStats: TableStat[];
  };
}

interface SyncStage {
  id: string;
  name: string;
  details?: string[];
  status: "pending" | "in_progress" | "completed" | "error";
  startTime?: number;
  endTime?: number;
  duration?: number;
  modifiesMetadata?: boolean;
}

interface InitialStage {
  id: string;
  name: string;
  modifiesMetadata: boolean;
}

interface StorageToolsProps {
  initialStages: InitialStage[];
}

export default function StorageTools({ initialStages }: StorageToolsProps) {
  const [databaseInfo, setDatabaseInfo] = useState<DatabaseInfo | null>(null);
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReloadingCaches, setIsReloadingCaches] = useState(false);
  const [isRefreshingDbStats, setIsRefreshingDbStats] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{
    isActive: boolean;
    message: string;
    progress: number;
    total: number;
  }>({ isActive: false, message: "", progress: 0, total: 0 });
  const [syncAbortController, setSyncAbortController] =
    useState<AbortController | null>(null);
  const [syncStages, setSyncStages] = useState<SyncStage[]>([]);
  const [syncMetadata, setSyncMetadata] = useState(false);
  const [daysToSync, setDaysToSync] = useState(1);
  const [recordCounts, setRecordCounts] = useState<Record<string, number>>({});
  const initialDefaultSet = useRef(false);

  const fetchSettings = async () => {
    try {
      const response = await fetch("/api/admin/storage");

      if (!response.ok) {
        throw new Error("Failed to fetch settings");
      }

      const data = await response.json();

      if (data.success) {
        setDatabaseInfo(data.database);
        setCacheInfo(data.cacheInfo || null);
        setError(null);
      } else {
        setError(data.error || "Failed to load settings");
      }
    } catch (err) {
      console.error("Error fetching settings:", err);
      setError("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  };

  const resetStagesAndCount = useCallback(async () => {
    // Filter stages based on syncMetadata checkbox
    const filteredStages = syncMetadata
      ? initialStages
      : initialStages.filter((stage) => !stage.modifiesMetadata);

    // Reset stages to pending
    setSyncStages(
      filteredStages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        status: "pending" as const,
        details: undefined,
        startTime: undefined,
        endTime: undefined,
        duration: undefined,
        modifiesMetadata: stage.modifiesMetadata,
      })),
    );

    setSyncProgress((prev) => ({
      ...prev,
      message: "Counting records to sync...",
      progress: 0,
    }));

    // Run count preview
    try {
      const response = await fetch("/api/admin/sync-database", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ syncMetadata, daysToSync, previewOnly: true }),
      });

      if (!response.ok) {
        console.error("Failed to run count preview");
        setSyncProgress((prev) => ({
          ...prev,
          message: "Ready to sync from production database",
        }));
        return;
      }

      // Handle streaming response
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n").filter((line) => line.trim());

          for (const line of lines) {
            try {
              const update = JSON.parse(line);
              if (update.type === "record-counts") {
                const counts = update.counts || {};
                setRecordCounts(counts);

                // Calculate total records
                const totalRecords = Object.values(counts).reduce(
                  (sum: number, count: any) => sum + (count || 0),
                  0,
                );
                const periodText =
                  daysToSync === -1
                    ? "automatic (since last sync)"
                    : daysToSync === 0.25
                      ? "last 6 hours"
                      : daysToSync === 1
                        ? "last 1 day"
                        : `last ${daysToSync} days`;
                setSyncProgress((prev) => ({
                  ...prev,
                  message: `Ready to sync ${totalRecords.toLocaleString()} records from ${periodText} from production database`,
                }));
              } else if (update.type === "error") {
                console.error("[SYNC] Error from backend:", update.message);
                // Display error in the UI
                setSyncProgress((prev) => ({
                  ...prev,
                  message: `Error: ${update.message}`,
                }));
              }
            } catch (e) {
              // Silently ignore JSON parse errors
            }
          }
        }
      }

      // Only set default message if we didn't get record counts
      setSyncProgress((prev) => {
        if (prev.message === "Counting records to sync...") {
          return { ...prev, message: "Ready to sync from production database" };
        }
        return prev;
      });
    } catch (err) {
      console.error("Error running count preview:", err);
      setSyncProgress((prev) => ({
        ...prev,
        message: "Ready to sync from production database",
      }));
    }
  }, [syncMetadata, daysToSync, initialStages]);

  const openSyncDialog = () => {
    setSyncProgress({
      isActive: true,
      message: "Counting records to sync...",
      progress: 0,
      total: 100,
    });
    resetStagesAndCount();
  };

  const recreateDailies = async () => {
    if (
      !confirm(
        "This will regenerate all daily aggregations. This may take a while. Continue?",
      )
    ) {
      return;
    }

    try {
      const response = await fetch("/api/cron/daily", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "regenerate" }),
      });

      const data = await response.json();

      // Always log the response to console for debugging
      console.log("[Recreate Dailies] Server response:", data);

      if (data.success) {
        const systemCount = data.systems ? data.systems.length : 0;
        alert(
          `Successfully regenerated daily aggregations for ${systemCount} systems`,
        );
      } else {
        console.error("[Recreate Dailies] Error from server:", data);
        alert(
          `Error: ${data.error || "Failed to regenerate daily aggregations"}`,
        );
      }
    } catch (err) {
      console.error("[Recreate Dailies] Error regenerating dailies:", err);
      alert("Failed to regenerate daily aggregations");
    }
  };

  const startSync = async () => {
    const controller = new AbortController();
    setSyncAbortController(controller);
    setSyncProgress((prev) => ({
      ...prev,
      message: "Initialising sync...",
      progress: 0,
      total: 100,
    }));

    // Reset all stages to pending at start, but mark first stage as in_progress
    setSyncStages((prevStages) =>
      prevStages.map((stage, index) => ({
        ...stage,
        status: index === 0 ? "in_progress" : "pending",
        details: undefined,
        startTime: index === 0 ? Date.now() : undefined,
        endTime: undefined,
        duration: undefined,
      })),
    );

    try {
      const response = await fetch("/api/admin/sync-database", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ syncMetadata, daysToSync, previewOnly: false }),
      });

      if (!response.ok) {
        throw new Error("Sync failed");
      }

      // Handle streaming response for progress updates
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n").filter((line) => line.trim());

          for (const line of lines) {
            try {
              const update = JSON.parse(line);
              if (update.type === "stages-init") {
                // Initialize all stages at once
                setSyncStages((prevStages) => {
                  return update.stages.map((backendStage: any) => {
                    // Find existing stage to preserve metadata flag
                    const existingStage = prevStages.find(
                      (s: SyncStage) => s.id === backendStage.id,
                    );
                    return {
                      id: backendStage.id,
                      name: backendStage.name,
                      details: backendStage.detail
                        ? [backendStage.detail]
                        : undefined,
                      status:
                        backendStage.status === "running"
                          ? "in_progress"
                          : backendStage.status === "completed"
                            ? "completed"
                            : backendStage.status === "error"
                              ? "error"
                              : "pending",
                      startTime: backendStage.startTime,
                      duration: backendStage.duration,
                      modifiesMetadata: existingStage?.modifiesMetadata, // Preserve from existing
                    };
                  });
                });
              } else if (update.type === "stage-update") {
                // Update a single stage
                const stageUpdate = update.stage;
                setSyncStages((prevStages) => {
                  const newStages = prevStages.map((stage) => {
                    if (stage.id !== stageUpdate.id) return stage;

                    // Append detail if it's new and different from last detail
                    const existingDetails = stage.details || [];
                    const newDetails =
                      stageUpdate.detail &&
                      stageUpdate.detail !==
                        existingDetails[existingDetails.length - 1]
                        ? [...existingDetails, stageUpdate.detail]
                        : existingDetails;

                    return {
                      ...stage,
                      name: stageUpdate.name,
                      details: newDetails,
                      status: (stageUpdate.status === "running"
                        ? "in_progress"
                        : stageUpdate.status === "completed"
                          ? "completed"
                          : stageUpdate.status === "error"
                            ? "error"
                            : "pending") as
                        | "pending"
                        | "in_progress"
                        | "completed"
                        | "error",
                      startTime: stageUpdate.startTime,
                      duration: stageUpdate.duration,
                      modifiesMetadata: stage.modifiesMetadata, // Preserve metadata flag
                    };
                  });

                  // Log the update
                  const updatedStage = newStages.find(
                    (s) => s.id === stageUpdate.id,
                  );
                  if (updatedStage) {
                    console.log("[SYNC]", {
                      stage: updatedStage.name,
                      status: updatedStage.status,
                      details: updatedStage.details || undefined,
                    });
                  }

                  return newStages;
                });
              } else if (update.type === "progress") {
                setSyncProgress({
                  isActive: true,
                  message: update.message || "Syncing...",
                  progress: update.progress || 0,
                  total: update.total || 100,
                });
              } else if (update.type === "record-counts") {
                // Update record counts
                setRecordCounts(update.counts || {});
              } else if (update.type === "mappings") {
                // Display mapping tables in console
                if (update.clerkMappings && update.clerkMappings.length > 0) {
                  console.log("[SYNC] Clerk ID Mappings:");
                  console.table(update.clerkMappings);
                }
                if (update.systemMappings && update.systemMappings.length > 0) {
                  console.log("[SYNC] System ID Mappings:");
                  console.table(update.systemMappings);
                }
              } else if (update.type === "complete") {
                // Calculate total duration from all completed stages and update message
                setSyncStages((prevStages) => {
                  const totalDuration = prevStages.reduce(
                    (sum, stage) => sum + (stage.duration || 0),
                    0,
                  );
                  const durationStr =
                    totalDuration > 0
                      ? ` in ${totalDuration.toFixed(1)} seconds`
                      : "";

                  setSyncProgress((prev) => ({
                    ...prev,
                    message: `Sync completed successfully${durationStr}!`,
                    progress: 100,
                    total: 100,
                  }));

                  return prevStages; // Return unchanged stages
                });
                // Refresh the page data
                await fetchSettings();
                // Don't auto-dismiss - user must close manually
              } else if (update.type === "error") {
                // Handle error without logging to console
                setSyncProgress((prev) => ({
                  ...prev,
                  message: `Error: ${update.message || "Sync failed"}`,
                }));
                // Mark current in-progress stage as error
                setSyncStages((prevStages) =>
                  prevStages.map((stage) =>
                    stage.status === "in_progress"
                      ? {
                          ...stage,
                          status: "error" as const,
                          details: update.message || "Failed",
                          endTime: Date.now(),
                          duration: stage.startTime
                            ? (Date.now() - stage.startTime) / 1000
                            : undefined,
                        }
                      : stage,
                  ),
                );
                // Stop the sync
                setSyncAbortController(null);
                break; // Exit the loop
              }
            } catch (e) {
              // Silently ignore JSON parse errors for incomplete chunks
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        setSyncProgress((prev) => ({
          ...prev,
          message: "Sync cancelled",
        }));
        // Mark current in-progress stage as error
        setSyncStages((prevStages) =>
          prevStages.map((stage) =>
            stage.status === "in_progress"
              ? { ...stage, status: "error", details: ["Cancelled"] }
              : stage,
          ),
        );
      } else {
        // Handle sync error without logging to console
        setSyncProgress((prev) => ({
          ...prev,
          message: `Error: ${err.message || "Failed to sync database"}`,
        }));
        // Mark current in-progress stage as error
        setSyncStages((prevStages) =>
          prevStages.map((stage) =>
            stage.status === "in_progress"
              ? {
                  ...stage,
                  status: "error",
                  details: [err.message || "Failed"],
                }
              : stage,
          ),
        );
      }
    } finally {
      setSyncAbortController(null);
    }
  };

  const cancelSync = () => {
    if (syncAbortController) {
      syncAbortController.abort();
      setSyncAbortController(null);
      // Mark current in-progress stage as interrupted
      setSyncStages((prevStages) =>
        prevStages.map((stage) =>
          stage.status === "in_progress"
            ? {
                ...stage,
                status: "error" as const,
                details: ["Interrupted"],
                endTime: Date.now(),
                duration: stage.startTime
                  ? (Date.now() - stage.startTime) / 1000
                  : undefined,
              }
            : stage,
        ),
      );
      setSyncProgress((prev) => ({
        ...prev,
        message: "Sync stopped",
      }));
    }
  };

  const forceReloadCaches = async () => {
    setIsReloadingCaches(true);
    const startTime = Date.now();

    try {
      const response = await fetch("/api/admin/storage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "force-reload-caches" }),
      });

      const data = await response.json();

      if (data.success) {
        // Immediately fetch fresh settings to show updated cache status
        await fetchSettings();
      } else {
        console.error("Failed to reload caches:", data.error);
        alert(`Error: ${data.error || "Failed to reload caches"}`);
      }
    } catch (err) {
      console.error("Error reloading caches:", err);
      alert("Failed to reload caches");
    } finally {
      // Ensure wait state is shown for at least 500ms
      const elapsedTime = Date.now() - startTime;
      const remainingTime = Math.max(0, 500 - elapsedTime);

      setTimeout(() => {
        setIsReloadingCaches(false);
      }, remainingTime);
    }
  };

  const refreshDbStats = async () => {
    setIsRefreshingDbStats(true);
    const startTime = Date.now();

    try {
      const response = await fetch("/api/cron/db-stats", {
        method: "POST",
      });

      const data = await response.json();

      if (data.success) {
        // Immediately fetch fresh settings to show updated stats
        await fetchSettings();
      } else {
        console.error("Failed to refresh DB stats:", data.error);
        alert(`Error: ${data.error || "Failed to refresh DB stats"}`);
      }
    } catch (err) {
      console.error("Error refreshing DB stats:", err);
      alert("Failed to refresh DB stats");
    } finally {
      // This can take 2+ minutes, so we show wait state until complete
      setIsRefreshingDbStats(false);
    }
  };

  useEffect(() => {
    fetchSettings();

    // Auto-refresh cache info every 10 seconds
    const intervalId = setInterval(() => {
      fetchSettings();
    }, 10000);

    return () => clearInterval(intervalId);
  }, []);

  // Set default daysToSync based on hasSyncStatus when databaseInfo loads (only once)
  useEffect(() => {
    if (databaseInfo && !initialDefaultSet.current) {
      // Only update on initial load, not when user changes the value
      if (databaseInfo.hasSyncStatus) {
        setDaysToSync(-1);
      }
      initialDefaultSet.current = true;
    }
  }, [databaseInfo]);

  // Update stages when syncMetadata or daysToSync changes (only if dialog is open and not started)
  useEffect(() => {
    if (
      syncProgress.isActive &&
      syncProgress.progress === 0 &&
      !syncAbortController
    ) {
      resetStagesAndCount();
    }
  }, [
    syncMetadata,
    daysToSync,
    syncProgress.isActive,
    syncProgress.progress,
    syncAbortController,
    resetStagesAndCount,
  ]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 sm:px-6 py-4 sm:py-8">
      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
          <AlertCircle className="w-5 h-5" />
          {error}
        </div>
      )}

      {/* Sync Progress Modal */}
      <SyncModal
        isOpen={syncProgress.isActive}
        syncProgress={syncProgress}
        syncStages={syncStages}
        syncAbortController={syncAbortController}
        daysToSync={daysToSync}
        syncMetadata={syncMetadata}
        recordCounts={recordCounts}
        hasSyncStatus={databaseInfo?.hasSyncStatus}
        onDaysToSyncChange={setDaysToSync}
        onSyncMetadataChange={setSyncMetadata}
        onStartSync={startSync}
        onCancelSync={cancelSync}
        onClose={() => {
          setSyncProgress({
            isActive: false,
            message: "",
            progress: 0,
            total: 0,
          });
          setSyncStages([]);
          setRecordCounts({});
        }}
      />

      {/* Database Tables */}
      {databaseInfo && databaseInfo.stats && databaseInfo.stats.tableStats && (
        <div className="mb-8 -mx-2 sm:mx-0">
          <div className="bg-gray-800 border border-gray-700 sm:rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  {/* Group headers */}
                  <tr>
                    <th className="px-4 py-1 text-left border-b border-gray-700"></th>
                    <th className="px-4 py-1 text-right border-b border-gray-700"></th>
                    <th
                      colSpan={2}
                      className="px-4 py-1 text-center text-xs font-medium text-gray-400 uppercase tracking-wider border-b border-gray-600"
                    >
                      Created
                    </th>
                    <th
                      colSpan={2}
                      className="px-4 py-1 text-center text-xs font-medium text-gray-400 uppercase tracking-wider border-b border-gray-600"
                    >
                      Updated
                    </th>
                    <th
                      colSpan={2}
                      className="px-4 py-1 text-center text-xs font-medium text-gray-400 uppercase tracking-wider border-b border-gray-600"
                    >
                      Size (MB)
                    </th>
                    <th className="px-4 py-1 text-right border-b border-gray-700"></th>
                  </tr>
                  {/* Column headers */}
                  <tr className="border-b border-gray-700">
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Table
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Records
                    </th>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 tracking-wider">
                      Earliest
                    </th>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 tracking-wider">
                      Latest
                    </th>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 tracking-wider">
                      Earliest
                    </th>
                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 tracking-wider">
                      Latest
                    </th>
                    <th className="px-2 py-2 text-right text-xs font-medium text-gray-500 tracking-wider">
                      Data
                    </th>
                    <th className="px-2 py-2 text-right text-xs font-medium text-gray-500 tracking-wider">
                      Indexes
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Per Day
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {databaseInfo.stats.tableStats.map((table, index) => (
                    <tr
                      key={table.name}
                      className={`${index % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"}`}
                    >
                      <td className="px-4 py-2 text-xs text-gray-300 font-mono">
                        {table.name}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-300 text-right">
                        {table.count.toLocaleString()}
                      </td>
                      {/* Created Range - Earliest */}
                      <td className="px-2 py-2 text-xs text-gray-300">
                        {table.createdAtMinTime ? (
                          formatDateTime(table.createdAtMinTime).display
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      {/* Created Range - Latest */}
                      <td className="px-2 py-2 text-xs text-gray-300">
                        {table.createdAtMaxTime ? (
                          formatDateTime(table.createdAtMaxTime).display
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      {/* Updated Range - Earliest */}
                      <td className="px-2 py-2 text-xs text-gray-300">
                        {table.updatedAtMinTime ? (
                          formatDateTime(table.updatedAtMinTime).display
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      {/* Updated Range - Latest */}
                      <td className="px-2 py-2 text-xs text-gray-300">
                        {table.updatedAtMaxTime ? (
                          formatDateTime(table.updatedAtMaxTime).display
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      {/* Size - Data */}
                      <td className="px-2 py-2 text-xs text-right">
                        {table.dataSizeMb !== undefined &&
                        table.dataSizeMb !== null ? (
                          table.dataSizeMb < 1 ? (
                            <span className="text-gray-500">{"< 1"}</span>
                          ) : (
                            <span className="text-gray-300">
                              {Math.round(table.dataSizeMb)}
                            </span>
                          )
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      {/* Size - Indexes */}
                      <td className="px-2 py-2 text-xs text-right">
                        {table.indexSizeMb !== undefined &&
                        table.indexSizeMb !== null ? (
                          table.indexSizeMb < 1 ? (
                            <span className="text-gray-500">{"< 1"}</span>
                          ) : (
                            <span className="text-gray-300">
                              {Math.round(table.indexSizeMb)}
                            </span>
                          )
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-right">
                        {table.recordsPerDay !== undefined &&
                        table.recordsPerDay !== null ? (
                          table.recordsPerDay < 1 ? (
                            <span className="text-gray-500">{"< 1"}</span>
                          ) : (
                            <span className="text-gray-300">
                              {Math.round(table.recordsPerDay).toLocaleString()}
                            </span>
                          )
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Environment Info and Actions - Single Line */}
      {databaseInfo && (
        <div className="mb-8 -mx-2 sm:mx-0 flex items-center justify-between gap-6 text-sm">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-gray-400">Environment:</span>
              <span
                className={`inline-flex items-center gap-1 px-3 py-1 text-sm font-medium border rounded-full ${
                  databaseInfo.type === "production"
                    ? "bg-green-900/50 text-green-300 border-green-700"
                    : "bg-yellow-900/50 text-yellow-300 border-yellow-700"
                }`}
              >
                {databaseInfo.type === "production" ? (
                  <Globe className="w-4 h-4" />
                ) : (
                  <Server className="w-4 h-4" />
                )}
                {databaseInfo.type === "production"
                  ? "Production"
                  : "Development"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-gray-400">Provider:</span>
              <span className="text-white font-medium">
                {databaseInfo.provider}
              </span>
            </div>
          </div>

          {/* Actions - Right Aligned */}
          <div className="flex items-center gap-3">
            {databaseInfo.type === "development" && (
              <button
                onClick={openSyncDialog}
                disabled={syncProgress.isActive}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg transition-colors text-sm"
              >
                <Download className="w-4 h-4" />
                Sync from Production…
              </button>
            )}
            <button
              onClick={recreateDailies}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm w-[180px]"
            >
              <RefreshCw className="w-4 h-4" />
              Recreate Dailies
            </button>
          </div>
        </div>
      )}

      {/* Cache Refresh Times */}
      {cacheInfo && (
        <div className="mt-8 -mx-2 sm:mx-0">
          <h3 className="text-sm font-medium text-gray-400 mb-3">
            Cache Status
          </h3>
          <div className="bg-gray-800 border border-gray-700 sm:rounded-lg p-4 mb-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-gray-400">SystemsManager Cache:</span>
                <span className="ml-2">
                  {cacheInfo.systemsManagerLoadedTime ? (
                    <span className="text-white">
                      {
                        formatDateTime(cacheInfo.systemsManagerLoadedTime)
                          .display
                      }
                    </span>
                  ) : (
                    <span className="text-gray-500 italic">Not yet loaded</span>
                  )}
                </span>
              </div>
              <div>
                <span className="text-gray-400">PointManager Cache:</span>
                <span className="ml-2">
                  {cacheInfo.pointManagerLoadedTime ? (
                    <span className="text-white">
                      {formatDateTime(cacheInfo.pointManagerLoadedTime).display}
                    </span>
                  ) : (
                    <span className="text-gray-500 italic">Not yet loaded</span>
                  )}
                </span>
              </div>
              <div>
                <span className="text-gray-400">DB Sizes Cache:</span>
                <span className="ml-2">
                  {cacheInfo.dbSizesCachedTime ? (
                    <>
                      <span className="text-white">
                        {formatDateTime(cacheInfo.dbSizesCachedTime).display}
                      </span>
                      {(() => {
                        const cacheAge =
                          Date.now() -
                          new Date(cacheInfo.dbSizesCachedTime).getTime();
                        const hoursOld = cacheAge / (1000 * 60 * 60);
                        if (hoursOld > 25) {
                          return (
                            <span className="ml-2 px-2 py-0.5 text-xs bg-yellow-600/20 text-yellow-400 border border-yellow-600/30 rounded">
                              Stale
                            </span>
                          );
                        }
                        return null;
                      })()}
                    </>
                  ) : (
                    <span className="text-gray-500 italic">Not yet loaded</span>
                  )}
                </span>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={refreshDbStats}
              disabled={isRefreshingDbStats}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-wait text-white rounded-lg transition-colors text-sm w-[180px]"
              style={{ cursor: isRefreshingDbStats ? "wait" : "pointer" }}
              title="Recalculate database sizes (takes ~2 minutes)"
            >
              <RefreshCw className="w-4 h-4" />
              {isRefreshingDbStats ? "Calculating..." : "Refresh DB Sizes"}
            </button>
            <button
              onClick={forceReloadCaches}
              disabled={isReloadingCaches}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-wait text-white rounded-lg transition-colors text-sm w-[180px]"
              style={{ cursor: isReloadingCaches ? "wait" : "pointer" }}
            >
              <RefreshCw className="w-4 h-4" />
              Invalidate Caches
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
