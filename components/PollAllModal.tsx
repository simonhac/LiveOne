"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check, AlertCircle, Ban } from "lucide-react";
import { PollTimeline } from "./PollTimeline";
import { formatDuration } from "@/lib/fe-date-format";
import type { PollingResult } from "@/lib/vendors/types";
import { useModalContext } from "@/contexts/ModalContext";
import SessionInfoModal from "./SessionInfoModal";

interface PollAllResponse {
  success: boolean;
  sessionId: string;
  timestamp: string;
  durationMs: number;
  sessionStartMs: number;
  sessionEndMs: number;
  summary: {
    total: number;
    successful: number;
    failed: number;
    skipped: number;
  };
  results: PollingResult[];
}

interface PollAllModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: PollAllResponse | null;
  onPollAgain?: () => void;
  isPolling?: boolean;
}

interface ErrorTooltipState {
  error: string;
  x: number;
  y: number;
}

/**
 * TimeCell component that shows live elapsed time during polling
 * and final duration when complete. Prevents flashing by computing
 * elapsed time inline on first render.
 */
function TimeCell({ result }: { result: PollingResult }) {
  const [tick, setTick] = useState(0);

  // Check if this system is in progress (has stages but not complete)
  const isInProgress =
    result.stages &&
    result.stages.length > 0 &&
    result.stages.length < 3 &&
    result.action === "POLLED";

  // Get the start time from first stage
  const startMs = result.stages?.[0]?.startMs;

  // Trigger re-renders while in progress (tick is just a counter to force updates)
  useEffect(() => {
    if (!isInProgress || !startMs) return;

    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 100);

    return () => clearInterval(interval);
  }, [isInProgress, startMs]);

  // Show final duration if available
  if (result.durationMs !== undefined) {
    return <>{formatDuration(result.durationMs)}</>;
  }

  // Show live elapsed time if in progress - compute inline to avoid flash
  if (isInProgress && startMs) {
    return <>{formatDuration(Date.now() - startMs)}</>;
  }

  // Not started yet
  return <>-</>;
}

export function PollAllModal({
  isOpen,
  onClose,
  data,
  onPollAgain,
  isPolling = false,
}: PollAllModalProps) {
  const { registerModal, unregisterModal } = useModalContext();
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(
    null,
  );
  const [elapsedTime, setElapsedTime] = useState(0);
  const [errorTooltip, setErrorTooltip] = useState<ErrorTooltipState | null>(
    null,
  );

  useEffect(() => {
    registerModal("poll-all");
    return () => unregisterModal("poll-all");
  }, [registerModal, unregisterModal]);

  // Update elapsed time every 100ms when polling
  useEffect(() => {
    if (!isPolling || !data) return;

    const interval = setInterval(() => {
      setElapsedTime(Date.now() - data.sessionStartMs);
    }, 100);

    return () => clearInterval(interval);
  }, [isPolling, data]);

  // Set final elapsed time when polling completes
  useEffect(() => {
    if (!isPolling && data) {
      setElapsedTime(data.durationMs);
    }
  }, [isPolling, data]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Close session modal first if it's open, otherwise close poll all modal
        if (selectedSessionId) {
          setSelectedSessionId(null);
        } else {
          onClose();
        }
      }
    };
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, selectedSessionId]);

  const handleSessionClick = (sessionId: number) => {
    setSelectedSessionId(sessionId);
  };

  if (!isOpen) return null;

  // Calculate total rows inserted
  const totalRowsInserted =
    data?.results.reduce((sum, result) => {
      return sum + (result.recordsProcessed || 0);
    }, 0) || 0;

  // Calculate total duration (sum of all individual system durations)
  const totalDuration =
    data?.results.reduce((sum, result) => {
      return sum + (result.durationMs || 0);
    }, 0) || 0;

  // Minimum number of empty rows to show when no data
  const minEmptyRows = 5;
  const displayResults = data?.results || [];
  const emptyRowsNeeded = Math.max(0, minEmptyRows - displayResults.length);

  const getStatusText = (result: PollingResult) => {
    // Check if waiting to start (no stages yet)
    if (
      (!result.stages || result.stages.length === 0) &&
      result.action === "POLLED"
    ) {
      return <span className="text-gray-500">-</span>;
    }

    // Check if in progress
    const isInProgress =
      result.stages && result.stages.length < 3 && result.action === "POLLED";

    if (isInProgress) {
      return (
        <span className="inline-flex items-center gap-1 text-blue-400">
          <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          polling
        </span>
      );
    }

    const StatusContent = ({
      children,
      className,
      onMouseEnter,
      onMouseLeave,
    }: {
      children: React.ReactNode;
      className: string;
      onMouseEnter?: (e: React.MouseEvent) => void;
      onMouseLeave?: () => void;
    }) => {
      if (result.sessionLabel && result.sessionId) {
        return (
          <button
            onClick={() => handleSessionClick(result.sessionId!)}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            className={`${className} session-col-narrow-link`}
          >
            {children}
          </button>
        );
      }
      return (
        <span
          className={className}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          {children}
        </span>
      );
    };

    switch (result.action) {
      case "POLLED":
        return (
          <StatusContent className="inline-flex items-center gap-1 text-green-400">
            <>
              <Check className="w-4 h-4" />
              <span className="status-text">ok</span>
            </>
          </StatusContent>
        );
      case "ERROR":
        return (
          <StatusContent
            className="inline-flex items-center gap-1 text-red-400 cursor-help"
            onMouseEnter={(e) => {
              if (result.error) {
                const rect = e.currentTarget.getBoundingClientRect();
                setErrorTooltip({
                  error: result.error,
                  x: rect.left,
                  y: rect.bottom + 4,
                });
              }
            }}
            onMouseLeave={() => setErrorTooltip(null)}
          >
            <X className="w-4 h-4" />
            <span className="status-text">error</span>
          </StatusContent>
        );
      case "SKIPPED":
        return <span className="text-yellow-400">skipped</span>;
    }
  };

  const getActionBadge = (result: PollingResult) => {
    // Check if in progress (has stages but not all 3 complete, and not an error)
    const isInProgress =
      result.stages && result.stages.length < 3 && result.action === "POLLED";

    if (isInProgress) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-blue-500/20 text-blue-400">
          <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          In Progress
        </span>
      );
    }

    switch (result.action) {
      case "POLLED":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-green-500/20 text-green-400">
            <Check className="w-3 h-3" />
            Success
          </span>
        );
      case "ERROR":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-red-500/20 text-red-400">
            <AlertCircle className="w-3 h-3" />
            Failed
          </span>
        );
      case "SKIPPED":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-yellow-500/20 text-yellow-400">
            <Ban className="w-3 h-3" />
            Skipped
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-lg p-6 max-w-7xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto mobile-modal mobile-container">
        {/* Header */}
        <div className="flex justify-between items-start mb-4 mobile-header">
          <h3 className="text-lg font-semibold text-white">
            Polling All Systems{" "}
            {data && (
              <span className="text-gray-500">Session: {data.sessionId}</span>
            )}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* System Details Table */}
        <div className="bg-gray-800 border border-gray-700 rounded overflow-hidden">
          {/* Header - fixed */}
          <div className="overflow-hidden">
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ minWidth: "175px", width: "25%" }} />
                <col
                  className="vendor-col"
                  style={{ minWidth: "70px", width: "10%" }}
                />
                <col style={{ minWidth: "60px", width: "10%" }} />
                <col
                  className="session-col"
                  style={{ minWidth: "84px", width: "12%" }}
                />
                <col style={{ minWidth: "46px", width: "8%" }} />
                <col style={{ minWidth: "60px", width: "10%" }} />
                <col style={{ minWidth: "175px", width: "25%" }} />
              </colgroup>
              <thead className="bg-gray-800">
                <tr className="border-b border-gray-700">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    System
                  </th>
                  <th className="vendor-col px-4 py-2.5 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Vendor
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="session-col px-4 py-2.5 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Session
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Rows
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Timeline
                  </th>
                </tr>
              </thead>
            </table>
          </div>

          {/* Scrollable body */}
          <div
            className="overflow-y-auto"
            style={{ maxHeight: "calc(90vh - 250px)", minHeight: "160px" }}
          >
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ minWidth: "175px", width: "25%" }} />
                <col
                  className="vendor-col"
                  style={{ minWidth: "70px", width: "10%" }}
                />
                <col style={{ minWidth: "60px", width: "10%" }} />
                <col
                  className="session-col"
                  style={{ minWidth: "84px", width: "12%" }}
                />
                <col style={{ minWidth: "46px", width: "8%" }} />
                <col style={{ minWidth: "60px", width: "10%" }} />
                <col style={{ minWidth: "175px", width: "25%" }} />
              </colgroup>
              <tbody>
                {displayResults.map((result, index) => (
                  <tr
                    key={`${result.systemId}-${index}`}
                    className={`${index % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"} hover:bg-gray-700 transition-colors`}
                  >
                    <td className="px-4 py-2.5 text-sm">
                      <div>
                        <span className="text-gray-300">
                          {result.displayName || `System ${result.systemId}`}
                        </span>
                        <span className="text-gray-500">
                          {"\u00A0"}
                          ID:{"\u00A0"}
                          {result.systemId}
                        </span>
                      </div>
                    </td>
                    <td className="vendor-col px-4 py-2.5 text-sm text-gray-400">
                      {result.vendorType}
                    </td>
                    <td className="px-4 py-2.5 text-sm">
                      {getStatusText(result)}
                    </td>
                    <td className="session-col px-4 py-2.5 text-sm">
                      {result.sessionLabel && result.sessionId ? (
                        <button
                          onClick={() => handleSessionClick(result.sessionId!)}
                          className="font-mono text-xs text-gray-400 hover:text-gray-200 hover:underline transition-colors"
                        >
                          {result.sessionLabel}
                        </button>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-300 text-right">
                      {result.recordsProcessed !== undefined
                        ? result.recordsProcessed
                        : "-"}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-300 text-right">
                      <TimeCell result={result} />
                    </td>
                    <td className="px-4 py-2.5 text-sm h-12">
                      <div className="h-6">
                        {result.stages && result.stages.length > 0 && data ? (
                          <PollTimeline
                            stages={result.stages}
                            sessionStartMs={data.sessionStartMs}
                            sessionEndMs={data.sessionEndMs}
                            isLive={
                              result.stages.length < 3 &&
                              result.action === "POLLED"
                            }
                          />
                        ) : (
                          <span className="text-gray-600">-</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {/* Add empty rows to maintain minimum height */}
                {Array.from({ length: emptyRowsNeeded }).map((_, index) => (
                  <tr
                    key={`empty-${index}`}
                    className={`${(displayResults.length + index) % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"}`}
                  >
                    <td className="px-4 py-2.5 text-sm h-12">&nbsp;</td>
                    <td className="vendor-col px-4 py-2.5 text-sm h-12">
                      &nbsp;
                    </td>
                    <td className="px-4 py-2.5 text-sm h-12">&nbsp;</td>
                    <td className="session-col px-4 py-2.5 text-sm h-12">
                      &nbsp;
                    </td>
                    <td className="px-4 py-2.5 text-sm h-12">&nbsp;</td>
                    <td className="px-4 py-2.5 text-sm h-12">&nbsp;</td>
                    <td className="px-4 py-2.5 text-sm h-12">&nbsp;</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Summary Row - fixed at bottom */}
          <div className="overflow-hidden">
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ minWidth: "175px", width: "25%" }} />
                <col
                  className="vendor-col"
                  style={{ minWidth: "70px", width: "10%" }}
                />
                <col style={{ minWidth: "60px", width: "10%" }} />
                <col
                  className="session-col"
                  style={{ minWidth: "84px", width: "12%" }}
                />
                <col style={{ minWidth: "46px", width: "8%" }} />
                <col style={{ minWidth: "60px", width: "10%" }} />
                <col style={{ minWidth: "175px", width: "25%" }} />
              </colgroup>
              <tbody>
                <tr className="border-t-2 border-gray-600 bg-gray-900 font-semibold">
                  <td className="px-4 py-3 text-sm text-gray-300">Total</td>
                  <td className="vendor-col px-4 py-3 text-sm"></td>
                  <td className="px-4 py-3 text-sm"></td>
                  <td className="session-col px-4 py-3 text-sm"></td>
                  <td className="px-4 py-3 text-sm text-white text-right">
                    {totalRowsInserted.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-white text-right">
                    {formatDuration(totalDuration)}
                  </td>
                  <td className="px-4 py-3 text-sm"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <style jsx>{`
          @media (max-width: 1200px) {
            .vendor-col {
              display: none;
            }
            .session-col {
              display: none;
            }
            .session-col-narrow-link {
              /* Make status clickable on narrow screens - always underlined */
              cursor: pointer;
              text-decoration: underline;
              text-underline-offset: 2px;
            }
            .session-col-narrow-link:hover {
              opacity: 0.8;
            }
          }
          @media (min-width: 1201px) {
            .session-col-narrow-link {
              /* On wide screens, status is not clickable */
              pointer-events: none;
              cursor: default;
              text-decoration: none;
            }
          }
          @media (max-width: 640px) {
            :global(.mobile-container) {
              margin-left: 0 !important;
              margin-right: 0 !important;
              padding-left: 0 !important;
              padding-right: 0 !important;
              padding-top: 10px !important;
              padding-bottom: 10px !important;
              border-radius: 0 !important;
              max-height: 100vh !important;
              border-left: none !important;
              border-right: none !important;
            }
            :global(.mobile-modal) .bg-gray-800.border {
              border-left: none !important;
              border-right: none !important;
            }
            .mobile-header {
              margin-left: 10px;
              margin-right: 10px;
            }
            /* Reduce cell padding on mobile */
            :global(.mobile-container) th,
            :global(.mobile-container) td {
              padding-left: 10px !important;
              padding-right: 10px !important;
            }
            /* Hide status text (ok/error) on mobile, keep only icons */
            .status-text {
              display: none;
            }
            /* Reduce system name column width by 20px */
            :global(.mobile-container) col:first-child {
              min-width: 155px !important;
            }
          }
        `}</style>

        {/* Poll Again Button */}
        {onPollAgain && (
          <div className="flex justify-end mt-4">
            <button
              onClick={onPollAgain}
              disabled={isPolling}
              style={{ width: "140px" }}
              className="px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded transition-colors"
            >
              Poll Again
            </button>
          </div>
        )}
      </div>

      {/* Session Info Modal (z-60, appears above this modal) */}
      <SessionInfoModal
        isOpen={selectedSessionId !== null}
        onClose={() => setSelectedSessionId(null)}
        sessionId={selectedSessionId}
      />

      {/* Error Tooltip Portal */}
      {errorTooltip &&
        createPortal(
          <div
            className="fixed bg-gray-900 text-white text-xs px-3 py-2 rounded shadow-lg border border-gray-700 max-w-sm break-words"
            style={{
              left: `${errorTooltip.x}px`,
              top: `${errorTooltip.y}px`,
              zIndex: 70,
            }}
          >
            {errorTooltip.error}
          </div>,
          document.body,
        )}
    </div>
  );
}
