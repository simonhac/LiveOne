"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useModalContext } from "@/contexts/ModalContext";
import { invalidateSystem } from "@/lib/queries";
import {
  X,
  Check,
  AlertCircle,
  RefreshCw,
  Activity,
  FileJson,
  Clock,
  Hash,
  Tag,
  ChevronRight,
} from "lucide-react";
import { formatDateTime, formatDuration } from "@/lib/fe-date-format";
import JsonViewer from "@/components/JsonViewer";
import { PollTimeline } from "@/components/PollTimeline";
import { usePollingState } from "@/hooks/usePollingState";

interface PollNowModalProps {
  systemId: number;
  displayName: string | null;
  vendorType?: string | null;
  dryRun?: boolean;
  onClose: () => void;
}

export default function PollNowModal({
  systemId,
  displayName,
  vendorType,
  dryRun = false,
  onClose,
}: PollNowModalProps) {
  const hasInitiatedPoll = useRef(false);
  const queryClient = useQueryClient();

  // Use shared polling state manager
  const {
    state: pollingState,
    isConnected,
    isComplete,
    startPolling,
    disconnect,
    reset,
  } = usePollingState();

  // Get system-specific state from the polling session
  const systemState = pollingState.systems.get(systemId);

  // Register this modal with the global modal context
  const { registerModal, unregisterModal } = useModalContext();
  useEffect(() => {
    registerModal("poll-now-modal");
    return () => unregisterModal("poll-now-modal");
  }, [registerModal, unregisterModal]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
      reset();
      hasInitiatedPoll.current = false;
    };
  }, [disconnect, reset]);

  // Refresh the dashboard's queries when polling completes (replaces the old event bus).
  useEffect(() => {
    if (isComplete && !dryRun) {
      invalidateSystem(queryClient, systemId);
    }
  }, [isComplete, dryRun, queryClient, systemId]);

  // Start polling on mount
  useEffect(() => {
    if (!hasInitiatedPoll.current) {
      hasInitiatedPoll.current = true;
      const dryRunParam = dryRun ? "&dryRun=true" : "";
      startPolling(
        `/api/cron/minutely?systemId=${systemId}&force=true&includeRaw=true&realTime=true${dryRunParam}`,
      );
    }
  }, [systemId, dryRun, startPolling]);

  const refreshPoll = () => {
    reset();
    const dryRunParam = dryRun ? "&dryRun=true" : "";
    startPolling(
      `/api/cron/minutely?systemId=${systemId}&force=true&includeRaw=true&realTime=true${dryRunParam}`,
    );
  };

  // Derive status from system state
  const status = systemState?.status || (isConnected ? "polling" : "pending");
  const isPolling = status === "polling" || status === "pending";

  // Get status color
  const getStatusColor = (s: string) => {
    switch (s) {
      case "completed":
        return "text-green-400";
      case "skipped":
        return "text-yellow-400";
      case "error":
        return "text-red-400";
      case "polling":
      case "pending":
        return "text-blue-400";
      default:
        return "text-gray-400";
    }
  };

  // Get status icon
  const getStatusIcon = (s: string) => {
    switch (s) {
      case "completed":
        return <Check className="w-6 h-6 text-green-500" />;
      case "skipped":
        return <AlertCircle className="w-6 h-6 text-yellow-500" />;
      case "error":
        return <AlertCircle className="w-6 h-6 text-red-500" />;
      case "polling":
      case "pending":
        return (
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        );
      default:
        return null;
    }
  };

  // Display status text (map internal status to user-friendly)
  const displayStatus = status === "completed" ? "polled" : status;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-white">
            Poll {displayName || "System"}{" "}
            <span className="text-gray-500">ID: {systemId}</span> —{" "}
            {vendorType || systemState?.vendorType || "System"}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dry Run Banner */}
        {dryRun && (
          <div className="mb-4 bg-blue-500/20 border border-blue-500/50 rounded-lg p-3 flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            <div>
              <p className="text-blue-300 font-semibold text-sm">
                🧪 DRY RUN MODE
              </p>
              <p className="text-blue-400 text-xs">
                No data will be written to the database
              </p>
            </div>
          </div>
        )}

        {/* Timeline Section - Always visible */}
        <div className="mb-4 bg-gray-900 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-gray-500" />
            <span className="text-xs text-gray-500">Timeline</span>
          </div>
          <div className="h-8">
            {systemState?.stages && systemState.stages.length > 0 ? (
              <PollTimeline sessionState={pollingState} systemId={systemId} />
            ) : (
              <div className="h-full bg-gray-800 rounded animate-pulse" />
            )}
          </div>
        </div>

        {/* Poll Metrics - Always visible */}
        <div className="mb-4 bg-gray-900 rounded-lg p-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div className="flex items-start gap-2">
              <Tag className="w-4 h-4 text-gray-500 mt-0.5" />
              <div>
                <p className="text-xs text-gray-500">Session</p>
                <p className="text-sm font-medium text-white font-mono">
                  {systemState?.sessionLabel || "—"}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <FileJson className="w-4 h-4 text-gray-500 mt-0.5" />
              <div>
                <p className="text-xs text-gray-500">Status</p>
                <p
                  className={`text-sm font-medium capitalize ${getStatusColor(status)}`}
                >
                  {displayStatus}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <Hash className="w-4 h-4 text-gray-500 mt-0.5" />
              <div>
                <p className="text-xs text-gray-500">Records</p>
                <p className="text-sm font-medium text-white">
                  {systemState?.recordsProcessed !== undefined
                    ? systemState.recordsProcessed
                    : "—"}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <Activity className="w-4 h-4 text-gray-500 mt-0.5" />
              <div>
                <p className="text-xs text-gray-500">Duration</p>
                <p className="text-sm font-medium text-white">
                  {systemState?.durationMs !== undefined
                    ? formatDuration(systemState.durationMs)
                    : "—"}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <Clock className="w-4 h-4 text-gray-500 mt-0.5" />
              <div>
                <p className="text-xs text-gray-500">Next Poll</p>
                <p className="text-sm font-medium text-white">
                  {systemState?.nextPollTime
                    ? formatDateTime(systemState.nextPollTime, {
                        includeSeconds: true,
                      }).time
                    : "—"}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Error/Skip Section - Only show after completion with error/skip */}
        {!isPolling && (status === "skipped" || status === "error") && (
          <div className="mb-4 bg-gray-900 rounded-lg p-4">
            <div className="flex items-center gap-3">
              {getStatusIcon(status)}
              <div className="flex-1">
                <p className={`font-semibold ${getStatusColor(status)}`}>
                  {status === "skipped" && "Skipped"}
                  {status === "error" && "Error"}
                </p>
                {status === "skipped" && systemState?.reason && (
                  <p className="text-sm text-gray-400">{systemState.reason}</p>
                )}
                {status === "error" && systemState?.error && (
                  <p className="text-sm text-gray-400">{systemState.error}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Raw Comms Section - Always visible, disabled when no data */}
        {systemState?.rawResponse ? (
          <JsonViewer data={systemState.rawResponse} />
        ) : (
          <div className="flex items-center gap-2 text-sm text-gray-600 cursor-not-allowed">
            <ChevronRight className="w-4 h-4" />
            Raw Comms
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6 flex gap-3 justify-end">
          {!isPolling && (
            <button
              onClick={refreshPoll}
              disabled={isConnected}
              className="flex items-center justify-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg transition-colors w-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${isConnected ? "animate-spin" : ""}`}
              />
              {dryRun ? "Dry Run Again" : "Poll Again"}
            </button>
          )}

          <button
            onClick={onClose}
            className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors w-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
