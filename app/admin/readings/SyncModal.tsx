"use client";

import { useRef, useState, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Check,
  XCircle,
} from "lucide-react";

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

interface SyncProgress {
  isActive: boolean;
  message: string;
  progress: number;
  total: number;
}

interface SyncModalProps {
  isOpen: boolean;
  syncProgress: SyncProgress;
  syncStages: SyncStage[];
  syncAbortController: AbortController | null;
  daysToSync: number;
  syncMetadata: boolean;
  recordCounts: Record<string, number>;
  hasSyncStatus?: boolean;
  onDaysToSyncChange: (days: number) => void;
  onSyncMetadataChange: (checked: boolean) => void;
  onStartSync: () => void;
  onCancelSync: () => void;
  onClose: () => void;
}

export default function SyncModal({
  isOpen,
  syncProgress,
  syncStages,
  syncAbortController,
  daysToSync,
  syncMetadata,
  recordCounts,
  hasSyncStatus = false,
  onDaysToSyncChange,
  onSyncMetadataChange,
  onStartSync,
  onCancelSync,
  onClose,
}: SyncModalProps) {
  const [showSyncDetails, setShowSyncDetails] = useState(true);
  const [scrollIndicators, setScrollIndicators] = useState({
    top: false,
    bottom: false,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
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

  // Auto-scroll to latest detail when stages update
  useEffect(() => {
    if (scrollContainerRef.current && syncStages.length > 0) {
      // Find the last stage with details
      for (let i = syncStages.length - 1; i >= 0; i--) {
        const stage = syncStages[i];
        if (stage.details && stage.details.length > 0) {
          const lastDetailKey = `${stage.id}-${stage.details.length - 1}`;
          const lastDetailEl = lastDetailRefs.current.get(lastDetailKey);
          if (lastDetailEl) {
            lastDetailEl.scrollIntoView({
              behavior: "smooth",
              block: "nearest",
            });
            break;
          }
        }
      }
      // Recheck scroll indicators after potential scroll
      setTimeout(checkScrollIndicators, 100);
    }
  }, [syncStages]);

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        if (!syncAbortController) {
          onClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, syncAbortController, onClose]);

  if (!isOpen) return null;

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
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-[50px] overflow-y-auto">
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-[752px] w-full h-fit max-h-[1000px] overflow-y-auto">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-white">Sync Database</h3>
        </div>

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

        {/* Period Dropdown */}
        <div className="mb-3 flex items-center gap-3">
          <label className="text-sm text-gray-300">Period:</label>
          <select
            value={daysToSync}
            onChange={(e) => onDaysToSyncChange(Number(e.target.value))}
            disabled={!!syncAbortController}
            className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value={-1} disabled={!hasSyncStatus}>
              automatic{!hasSyncStatus ? " (requires previous sync)" : ""}
            </option>
            <option value={0.25}>last 6 hours</option>
            <option value={1}>last 1 day</option>
            <option value={3}>last 3 days</option>
            <option value={7}>last 7 days</option>
            <option value={14}>last 14 days</option>
          </select>
        </div>

        {/* Sync Metadata Checkbox */}
        <div className="mb-4">
          <label
            className={`flex items-center gap-2 ${syncAbortController ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              checked={syncMetadata}
              onChange={(e) => onSyncMetadataChange(e.target.checked)}
              disabled={!!syncAbortController}
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

        {/* Progress bar - show once sync has started */}
        {(syncAbortController ||
          syncStages.some((s) => s.status !== "pending")) && (
          <div className="mb-4">
            <div className="bg-gray-900 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  syncProgress.progress === 100 ? "bg-green-500" : "bg-blue-500"
                }`}
                style={{
                  width: `${(syncProgress.progress / syncProgress.total) * 100}%`,
                }}
              />
            </div>
            <div className="mt-2 text-xs text-gray-500 text-right">
              {Math.round((syncProgress.progress / syncProgress.total) * 100)}%
            </div>
          </div>
        )}

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
                                  <span className="text-yellow-500">⚠️</span>
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
              onClick={onCancelSync}
              className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors min-w-[130px]"
            >
              Stop
            </button>
          ) : syncProgress.progress > 0 ||
            syncStages.some((s) => s.status !== "pending") ? (
            // Show Sync Again button when completed/failed/stopped
            <button
              onClick={onStartSync}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors min-w-[130px]"
            >
              Sync Again
            </button>
          ) : (
            // Show Start button when not started yet
            <button
              onClick={onStartSync}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors min-w-[130px]"
            >
              Start Sync
            </button>
          )}
          <button
            onClick={onClose}
            disabled={!!syncAbortController}
            className={`px-6 py-2 rounded-lg transition-colors min-w-[130px] ${
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
  );
}
