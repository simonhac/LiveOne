"use client";

import { useEffect, useState, useRef } from "react";
import {
  Database,
  Server,
  CheckCircle,
  XCircle,
  Info,
  AlertCircle,
  Globe,
  Shield,
  Download,
  X,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Check,
  RefreshCw,
} from "lucide-react";
import { formatDateTime } from "@/lib/fe-date-format";

interface DatabaseInfo {
  type: "development" | "production";
  provider: string;
  stats?: {
    tables: number;
    totalReadings: number;
    oldestReading: string;
    newestReading: string;
    diskSize?: string;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{
    isActive: boolean;
    message: string;
    progress: number;
    total: number;
  }>({ isActive: false, message: "", progress: 0, total: 0 });
  const [syncAbortController, setSyncAbortController] =
    useState<AbortController | null>(null);
  const [syncStages, setSyncStages] = useState<SyncStage[]>([]);
  const [showSyncDetails, setShowSyncDetails] = useState(true);
  const [scrollIndicators, setScrollIndicators] = useState({
    top: false,
    bottom: false,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [syncMetadata, setSyncMetadata] = useState(false);
  const [recordCounts, setRecordCounts] = useState<Record<string, number>>({});
  const lastDetailRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const checkScrollIndicators = () => {
    if (scrollContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } =
        scrollContainerRef.current;
      setScrollIndicators({
        top: scrollTop > 0,
        bottom: scrollTop + clientHeight < scrollHeight - 1, // -1 for rounding
      });
    }
  };

  const scrollUp = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({
        top: -100,
        behavior: "smooth",
      });
    }
  };

  const scrollDown = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({
        top: 100,
        behavior: "smooth",
      });
    }
  };

  const fetchSettings = async () => {
    try {
      const response = await fetch("/api/admin/storage");

      if (!response.ok) {
        throw new Error("Failed to fetch settings");
      }

      const data = await response.json();

      if (data.success) {
        setDatabaseInfo(data.database);
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

  const resetStagesAndCount = async () => {
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
        body: JSON.stringify({ syncMetadata, previewOnly: true }),
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
                setSyncProgress((prev) => ({
                  ...prev,
                  message: `Ready to sync ${totalRecords.toLocaleString()} records from last 7 days from production database`,
                }));
              } else if (update.type === "error") {
                console.error("[SYNC] Error from backend:", update.message);
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
  };

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
        body: JSON.stringify({ syncMetadata, previewOnly: false }),
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

  useEffect(() => {
    fetchSettings();
  }, []);

  // Update stages when syncMetadata checkbox changes (only if dialog is open and not started)
  useEffect(() => {
    if (
      syncProgress.isActive &&
      syncProgress.progress === 0 &&
      !syncAbortController
    ) {
      resetStagesAndCount();
    }
  }, [syncMetadata, syncProgress.isActive]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && syncProgress.isActive) {
        setSyncProgress({
          isActive: false,
          message: "",
          progress: 0,
          total: 0,
        });
        setSyncStages([]);
        setRecordCounts({});
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [syncProgress.isActive]);

  useEffect(() => {
    // Check scroll indicators when stages change or details toggle
    if (showSyncDetails) {
      setTimeout(checkScrollIndicators, 0); // Delay to ensure DOM is updated
    }
  }, [syncStages, showSyncDetails]);

  // Auto-scroll new messages into view
  useEffect(() => {
    if (!scrollContainerRef.current) return;

    // Find the last detail across all stages
    let lastStageId: string | null = null;
    let lastDetailIndex = -1;

    syncStages.forEach((stage) => {
      if (stage.details && stage.details.length > 0) {
        lastStageId = stage.id;
        lastDetailIndex = stage.details.length - 1;
      }
    });

    // Scroll the last detail into view
    if (lastStageId !== null && lastDetailIndex >= 0) {
      const lastDetailEl = lastDetailRefs.current.get(
        `${lastStageId}-${lastDetailIndex}`,
      );
      if (lastDetailEl) {
        lastDetailEl.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    }
  }, [syncStages]);

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
      {syncProgress.isActive && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-[752px] w-full mx-4">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-white">
                Sync Database
              </h3>
            </div>

            {(() => {
              // Find the current stage (in_progress or last non-pending)
              const currentStage =
                syncStages.find((s) => s.status === "in_progress") ||
                syncStages
                  .slice()
                  .reverse()
                  .find((s) => s.status !== "pending");

              // Find the most recent log message across all stages
              let latestMessage = "";
              for (let i = syncStages.length - 1; i >= 0; i--) {
                const stage = syncStages[i];
                if (stage.details && stage.details.length > 0) {
                  latestMessage = stage.details[stage.details.length - 1];
                  break;
                }
              }

              return (
                <div className="mb-4 space-y-1">
                  {currentStage && (
                    <p className="text-sm text-gray-400">
                      <span className="font-medium text-white">
                        {currentStage.name}
                      </span>
                    </p>
                  )}
                  {latestMessage && (
                    <p className="text-sm text-gray-400">{latestMessage}</p>
                  )}
                  {!currentStage && !latestMessage && syncProgress.message && (
                    <p
                      className={`text-sm ${syncProgress.message.startsWith("Error:") ? "text-red-400" : "text-gray-400"}`}
                    >
                      {syncProgress.message}
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Sync Metadata Checkbox */}
            <div className="mb-4">
              <label
                className={`flex items-center gap-2 ${syncAbortController || syncProgress.progress > 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={syncMetadata}
                  onChange={(e) => setSyncMetadata(e.target.checked)}
                  disabled={!!syncAbortController || syncProgress.progress > 0}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <span className="text-sm text-gray-300">
                  Sync metadata (destructive)
                </span>
              </label>
              <p className="text-xs text-gray-500 mt-1 ml-6">
                {syncMetadata
                  ? "Will sync systems, users, and point info (overwrites existing metadata)"
                  : "Will only sync readings and aggregations (preserves existing metadata)"}
              </p>
            </div>

            <div className="mb-4">
              <div className="bg-gray-900 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    syncProgress.progress === 100
                      ? "bg-green-500"
                      : "bg-blue-500"
                  }`}
                  style={{
                    width: `${(syncProgress.progress / syncProgress.total) * 100}%`,
                  }}
                />
              </div>
              <div className="mt-2 text-xs text-gray-500 text-right">
                {Math.round((syncProgress.progress / syncProgress.total) * 100)}
                %
              </div>
            </div>

            {/* Detailed Progress Table */}
            {syncStages.length > 0 && (
              <div className="mb-4">
                <button
                  onClick={() => setShowSyncDetails(!showSyncDetails)}
                  className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors mb-2"
                >
                  {showSyncDetails ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  Details
                </button>

                {showSyncDetails && (
                  <div className="bg-gray-900 rounded-lg p-3 h-[400px] overflow-hidden flex flex-col relative">
                    {/* Top scroll indicator with clickable chevron */}
                    {scrollIndicators.top && (
                      <>
                        <div className="absolute top-3 left-3 right-3 h-8 bg-gradient-to-b from-gray-900 via-gray-900/40 to-transparent pointer-events-none z-10" />
                        <button
                          onClick={scrollUp}
                          className="absolute top-3 left-1/2 -translate-x-1/2 z-20 hover:scale-110 transition-transform"
                          aria-label="Scroll up"
                        >
                          <ChevronUp className="w-4 h-4 text-gray-400 hover:text-gray-300 animate-pulse" />
                        </button>
                      </>
                    )}

                    <div
                      ref={scrollContainerRef}
                      className="overflow-y-auto flex-1"
                      onScroll={checkScrollIndicators}
                    >
                      <table className="w-full text-sm">
                        <tbody>
                          {syncStages.map((stage) => {
                            const count = recordCounts[stage.id];
                            const showCount = count !== undefined && count > 0;
                            return (
                              <tr
                                key={stage.id}
                                className="border-b border-gray-800 last:border-0"
                              >
                                <td className="py-2 pr-3 w-8 text-center align-top">
                                  {stage.status === "completed" ? (
                                    <Check className="w-4 h-4 text-green-500 inline" />
                                  ) : stage.status === "in_progress" ? (
                                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin inline-block" />
                                  ) : stage.status === "error" ? (
                                    <XCircle className="w-4 h-4 text-red-500 inline" />
                                  ) : (
                                    <div className="w-4 h-4" />
                                  )}
                                </td>
                                <td className="py-2 pr-3">
                                  <div className="font-medium text-white flex items-center gap-1.5">
                                    {stage.modifiesMetadata && (
                                      <span className="text-yellow-500">
                                        ⚠️
                                      </span>
                                    )}
                                    <span>{stage.name}</span>
                                    {showCount && (
                                      <span className="text-gray-500 font-normal">
                                        {count.toLocaleString()} records
                                      </span>
                                    )}
                                  </div>
                                  {stage.details &&
                                    Array.isArray(stage.details) &&
                                    stage.details.length > 0 && (
                                      <div className="text-xs text-gray-400 mt-0.5 space-y-0.5">
                                        {stage.details.map((detail, index) => (
                                          <div
                                            key={index}
                                            ref={(el) => {
                                              if (el) {
                                                lastDetailRefs.current.set(
                                                  `${stage.id}-${index}`,
                                                  el,
                                                );
                                              }
                                            }}
                                          >
                                            {detail}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                </td>
                                <td className="py-2 text-right text-gray-400 w-20 align-top">
                                  {stage.duration !== undefined
                                    ? `${stage.duration.toFixed(1)} s`
                                    : ""}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Bottom scroll indicator with clickable chevron */}
                    {scrollIndicators.bottom && (
                      <>
                        <div className="absolute bottom-3 left-3 right-3 h-8 bg-gradient-to-t from-gray-900 via-gray-900/40 to-transparent pointer-events-none z-10" />
                        <button
                          onClick={scrollDown}
                          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 hover:scale-110 transition-transform"
                          aria-label="Scroll down"
                        >
                          <ChevronDown className="w-4 h-4 text-gray-400 hover:text-gray-300 animate-pulse" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-2 justify-end">
              {syncAbortController ? (
                // Show Stop button when running
                <button
                  onClick={cancelSync}
                  className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors min-w-[120px]"
                >
                  Stop
                </button>
              ) : syncProgress.progress > 0 ||
                syncStages.some((s) => s.status !== "pending") ? (
                // Show Start Again button when completed/failed/stopped
                <button
                  onClick={startSync}
                  className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors min-w-[120px]"
                >
                  Start Again
                </button>
              ) : (
                // Show Start button when not started yet
                <button
                  onClick={startSync}
                  className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors min-w-[120px]"
                >
                  Start Sync
                </button>
              )}
              <button
                onClick={() => {
                  setSyncProgress({
                    isActive: false,
                    message: "",
                    progress: 0,
                    total: 0,
                  });
                  setSyncStages([]);
                  setRecordCounts({});
                }}
                disabled={!!syncAbortController}
                className={`px-6 py-2 rounded-lg transition-colors min-w-[120px] ${
                  syncAbortController
                    ? "bg-gray-500 text-gray-400 cursor-not-allowed"
                    : "bg-gray-600 hover:bg-gray-700 text-white"
                }`}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Database Information */}
      <div className="mb-8 -mx-2 sm:mx-0">
        <h2 className="text-xl font-semibold text-white mb-4 px-2 sm:px-0">
          Database
        </h2>

        <div className="bg-gray-800 border border-gray-700 sm:rounded-lg p-4 sm:p-6">
          {databaseInfo && (
            <div className="space-y-4">
              {/* Database Type Badge */}
              <div className="flex items-center gap-4">
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

              {/* Database Provider */}
              <div className="flex items-center gap-4">
                <span className="text-gray-400">Provider:</span>
                <span className="text-white font-medium">
                  {databaseInfo.provider}
                </span>
              </div>

              {/* Database Statistics */}
              {databaseInfo.stats && (
                <div className="mt-6 pt-6 border-t border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-400 mb-3">
                    Database Statistics
                  </h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-xs text-gray-500">Tables</p>
                      <p className="text-lg font-semibold text-white">
                        {databaseInfo.stats.tables}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Total Readings</p>
                      <p className="text-lg font-semibold text-white">
                        {databaseInfo.stats.totalReadings.toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Oldest Reading</p>
                      <div className="text-sm text-white">
                        {databaseInfo.stats.oldestReading === "No data" ? (
                          "No data"
                        ) : (
                          <>
                            <div>
                              {new Date(
                                databaseInfo.stats.oldestReading,
                              ).toLocaleDateString("en-AU", {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })}
                            </div>
                            <div className="text-xs text-gray-400">
                              {
                                formatDateTime(
                                  databaseInfo.stats.oldestReading,
                                  { includeSeconds: false },
                                ).time
                              }
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Newest Reading</p>
                      <div className="text-sm text-white">
                        {databaseInfo.stats.newestReading === "No data" ? (
                          "No data"
                        ) : (
                          <>
                            <div>
                              {new Date(
                                databaseInfo.stats.newestReading,
                              ).toLocaleDateString("en-AU", {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })}
                            </div>
                            <div className="text-xs text-gray-400">
                              {
                                formatDateTime(
                                  databaseInfo.stats.newestReading,
                                  { includeSeconds: false },
                                ).time
                              }
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    {databaseInfo.stats.diskSize && (
                      <div>
                        <p className="text-xs text-gray-500">Disk Size</p>
                        <p className="text-lg font-semibold text-white">
                          {databaseInfo.stats.diskSize}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Actions Section */}
              <div className="mt-6 pt-6 border-t border-gray-700">
                <h3 className="text-sm font-semibold text-gray-400 mb-3">
                  Actions
                </h3>
                <div className="flex flex-wrap gap-3">
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
                    className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Recreate Dailies
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Info Notice */}
      <div className="mt-8 -mx-2 sm:mx-0 bg-blue-900/20 border border-blue-700/50 sm:rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-300">
            <p className="font-semibold mb-1">Database Information</p>
            <p className="text-blue-200">
              {databaseInfo?.type === "production"
                ? "You are connected to the production Turso database. All changes will affect live data."
                : "You are connected to the local SQLite development database. Changes will not affect production."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
