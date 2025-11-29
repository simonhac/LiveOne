"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useModalContext } from "@/contexts/ModalContext";
import { triggerDashboardRefresh } from "@/hooks/useDashboardRefresh";
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
} from "lucide-react";
import { formatDateTime, formatDuration } from "@/lib/fe-date-format";
import JsonViewer from "@/components/JsonViewer";
import { PollTimeline } from "@/components/PollTimeline";
import type { PollStage } from "@/lib/vendors/types";

interface PollNowModalProps {
  systemId: number;
  displayName: string | null;
  vendorType?: string | null;
  dryRun?: boolean;
  onClose: () => void;
}

interface PollResult {
  systemId: number;
  displayName?: string;
  vendorType?: string;
  status: "polled" | "skipped" | "error" | "polling";
  recordsProcessed?: number;
  skipReason?: string;
  error?: string;
  rawResponse?: any;
  nextPollTimeMs?: number;
  sessionLabel?: string;
  sessionId?: number;
  stages?: PollStage[];
  startMs?: number;
  endMs?: number;
  durationMs?: number;
}

export default function PollNowModal({
  systemId,
  displayName,
  vendorType,
  dryRun = false,
  onClose,
}: PollNowModalProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PollResult | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sessionStartMs, setSessionStartMs] = useState<number>(Date.now());
  const [sessionEndMs, setSessionEndMs] = useState<number>(Date.now());
  const hasInitiatedPoll = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    // Use ref to ensure poll only happens once, even in StrictMode
    if (!hasInitiatedPoll.current) {
      hasInitiatedPoll.current = true;
      pollNow(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array means this runs once on mount

  const pollNow = useCallback(
    async (isRefresh: boolean = false) => {
      // Abort any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      if (isRefresh) {
        setIsRefreshing(true);
      } else {
        setLoading(true);
        setResult(null);
      }

      const startTime = Date.now();
      setSessionStartMs(startTime);
      setSessionEndMs(startTime);

      // Set initial polling state
      setResult({
        systemId,
        displayName: displayName ?? undefined,
        vendorType: vendorType ?? undefined,
        status: "polling",
        startMs: startTime,
      });

      try {
        const dryRunParam = dryRun ? "&dryRun=true" : "";
        const response = await fetch(
          `/api/cron/minutely?systemId=${systemId}&force=true&includeRaw=true&realTime=true${dryRunParam}`,
          { signal: abortControllerRef.current.signal },
        );

        if (!response.ok) {
          throw new Error(`Failed to poll: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE messages
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));

                if (data.type === "start") {
                  // Update session start time
                  setSessionStartMs(data.data.sessionStartMs);
                } else if (data.type === "progress") {
                  // Update with progress data
                  const progressData = data.data;
                  setSessionEndMs(Date.now());
                  setResult((prev) => ({
                    ...prev,
                    systemId: progressData.systemId,
                    displayName: progressData.displayName || prev?.displayName,
                    vendorType: progressData.vendorType || prev?.vendorType,
                    status: progressData.inProgress ? "polling" : "polled",
                    sessionLabel: progressData.sessionLabel,
                    sessionId: progressData.sessionId,
                    stages: progressData.stages,
                    startMs: progressData.startMs,
                    endMs: progressData.endMs,
                    recordsProcessed: progressData.recordsProcessed,
                    durationMs: progressData.durationMs,
                  }));
                } else if (data.type === "complete") {
                  // Final result
                  const completeData = data.data;
                  setSessionEndMs(completeData.sessionEndMs);

                  // Find the result for our system
                  const systemResult = completeData.results?.find(
                    (r: any) => r.systemId === systemId,
                  );

                  if (systemResult) {
                    setResult({
                      systemId: systemResult.systemId,
                      displayName: systemResult.displayName,
                      vendorType: systemResult.vendorType,
                      status: systemResult.action?.toLowerCase() || "error",
                      sessionLabel: systemResult.sessionLabel,
                      sessionId: systemResult.sessionId,
                      stages: systemResult.stages,
                      startMs: systemResult.startMs,
                      endMs: systemResult.endMs,
                      recordsProcessed: systemResult.recordsProcessed,
                      durationMs: systemResult.durationMs,
                      nextPollTimeMs: systemResult.nextPollTimeMs,
                      rawResponse: systemResult.rawResponse,
                      skipReason: systemResult.reason,
                      error: systemResult.error,
                    });
                  }
                } else if (data.type === "error") {
                  setResult({
                    systemId,
                    displayName: displayName ?? undefined,
                    vendorType: vendorType ?? undefined,
                    status: "error",
                    error: data.error,
                  });
                }
              } catch (parseErr) {
                console.error("Failed to parse SSE data:", parseErr);
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return; // Ignore abort errors
        }
        console.error("Poll now error:", err);
        setResult({
          systemId,
          displayName: displayName ?? undefined,
          vendorType: vendorType ?? undefined,
          status: "error",
          error: err instanceof Error ? err.message : "Failed to poll system",
        });
      } finally {
        setLoading(false);
        setIsRefreshing(false);
        // Notify dashboard cards that new data may be available
        if (!dryRun) {
          triggerDashboardRefresh();
        }
      }
    },
    [systemId, displayName, vendorType, dryRun],
  );

  const refreshPoll = () => {
    pollNow(true);
  };

  // Get status color
  const getStatusColor = (status: string) => {
    switch (status) {
      case "polled":
        return "text-green-400";
      case "skipped":
        return "text-yellow-400";
      case "error":
        return "text-red-400";
      case "polling":
        return "text-blue-400";
      default:
        return "text-gray-400";
    }
  };

  // Get status icon
  const getStatusIcon = (status: string) => {
    switch (status) {
      case "polled":
        return <Check className="w-6 h-6 text-green-500" />;
      case "skipped":
        return <AlertCircle className="w-6 h-6 text-yellow-500" />;
      case "error":
        return <AlertCircle className="w-6 h-6 text-red-500" />;
      case "polling":
        return (
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        );
      default:
        return null;
    }
  };

  const isPolling = result?.status === "polling";

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-white">
            Poll {displayName || "System"}{" "}
            <span className="text-gray-500">ID: {systemId}</span> —{" "}
            {vendorType || result?.vendorType || "System"}
            {result?.sessionLabel && (
              <span className="ml-2 text-gray-500 font-mono text-sm">
                {result.sessionLabel}
              </span>
            )}
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

        {/* Timeline Section - Show during polling and after completion */}
        {result?.stages && result.stages.length > 0 && (
          <div className="mb-4 bg-gray-900 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4 text-gray-500" />
              <span className="text-xs text-gray-500">Timeline</span>
              {isPolling && (
                <span className="text-xs text-blue-400 ml-auto">
                  {formatDuration(Date.now() - sessionStartMs)}
                </span>
              )}
            </div>
            <div className="h-8">
              <PollTimeline
                stages={result.stages}
                sessionStartMs={sessionStartMs}
                sessionEndMs={isPolling ? Date.now() : sessionEndMs}
                isLive={isPolling}
              />
            </div>
          </div>
        )}

        {/* Loading State - Initial (before we have stages) */}
        {loading && !result?.stages?.length && (
          <div className="text-center py-8">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-gray-400">Polling system...</p>
          </div>
        )}

        {/* Data Display */}
        {result && result.status !== "polling" && (
          <div className="relative">
            {/* Refreshing Overlay */}
            {isRefreshing && (
              <div className="absolute inset-0 flex items-center justify-center z-10">
                <div className="bg-gray-800/90 rounded-lg p-4 flex items-center gap-3">
                  <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-gray-300">Polling again...</span>
                </div>
              </div>
            )}

            <div
              className={`space-y-4 transition-opacity ${isRefreshing ? "opacity-40" : ""}`}
            >
              {/* Error or Skip Reason Section - Only show if there's an error or skip */}
              {(result.status === "skipped" || result.status === "error") && (
                <div className="bg-gray-900 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    {getStatusIcon(result.status)}
                    <div className="flex-1">
                      <p
                        className={`font-semibold ${getStatusColor(result.status)}`}
                      >
                        {result.status === "skipped" && "Skipped"}
                        {result.status === "error" && "Error"}
                      </p>
                      {result.status === "skipped" && result.skipReason && (
                        <p className="text-sm text-gray-400">
                          {result.skipReason}
                        </p>
                      )}
                      {result.status === "error" && result.error && (
                        <p className="text-sm text-gray-400">{result.error}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Poll Metrics */}
              <div className="bg-gray-900 rounded-lg p-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="flex items-start gap-2">
                    <FileJson className="w-4 h-4 text-gray-500 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-500">Status</p>
                      <p
                        className={`text-sm font-medium capitalize ${getStatusColor(result.status)}`}
                      >
                        {result.status}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    <Hash className="w-4 h-4 text-gray-500 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-500">Records</p>
                      <p className="text-sm font-medium text-white">
                        {result.recordsProcessed !== undefined
                          ? result.recordsProcessed
                          : "—"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    <Activity className="w-4 h-4 text-gray-500 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-500">Duration</p>
                      <p className="text-sm font-medium text-white">
                        {result.durationMs !== undefined
                          ? formatDuration(result.durationMs)
                          : "—"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    <Clock className="w-4 h-4 text-gray-500 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-500">Next Poll</p>
                      <p className="text-sm font-medium text-white">
                        {result.nextPollTimeMs
                          ? formatDateTime(new Date(result.nextPollTimeMs), {
                              includeSeconds: true,
                            }).time
                          : "—"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Raw Response Section */}
              {result.rawResponse && <JsonViewer data={result.rawResponse} />}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6 flex gap-3 justify-end">
          {result && result.status !== "polling" && (
            <button
              onClick={refreshPoll}
              disabled={isRefreshing}
              className="flex items-center justify-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg transition-colors w-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`}
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
