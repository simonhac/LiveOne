"use client";

import { useEffect, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Check, AlertCircle, Ban } from "lucide-react";
import { PollTimeline } from "./PollTimeline";
import { formatDuration } from "@/lib/fe-date-format";
import { useModalContext } from "@/contexts/ModalContext";
import SessionInfoModal from "./SessionInfoModal";
import type {
  PollingSessionState,
  SystemPollingState,
} from "@/lib/polling-state-manager";

interface PollAllModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionState: PollingSessionState;
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
 * and final duration when complete.
 */
function TimeCell({ system }: { system: SystemPollingState }) {
  const [, setTick] = useState(0);

  // Check if this system is in progress
  const isInProgress =
    system.status === "polling" ||
    (system.stages &&
      system.stages.length > 0 &&
      system.stages.length < 3 &&
      system.status !== "completed" &&
      system.status !== "error" &&
      system.status !== "skipped");

  // Get the start time from first stage
  const startMs = system.stages?.[0]?.startMs;

  // Trigger re-renders while in progress
  useEffect(() => {
    if (!isInProgress || !startMs) return;

    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 100);

    return () => clearInterval(interval);
  }, [isInProgress, startMs]);

  // Show final duration if available
  if (system.durationMs !== undefined) {
    return <>{formatDuration(system.durationMs)}</>;
  }

  // Show live elapsed time if in progress
  if (isInProgress && startMs) {
    return <>{formatDuration(Date.now() - startMs)}</>;
  }

  // Not started yet
  return <>-</>;
}

export function PollAllModal({
  isOpen,
  onClose,
  sessionState,
  onPollAgain,
  isPolling = false,
}: PollAllModalProps) {
  const { registerModal, unregisterModal } = useModalContext();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [errorTooltip, setErrorTooltip] = useState<ErrorTooltipState | null>(
    null,
  );

  // Convert systems Map to array for rendering
  const systems = useMemo(
    () => Array.from(sessionState.systems.values()),
    [sessionState.systems],
  );

  useEffect(() => {
    registerModal("poll-all");
    return () => unregisterModal("poll-all");
  }, [registerModal, unregisterModal]);

  // Clear error tooltip when polling starts
  useEffect(() => {
    if (isPolling) {
      setErrorTooltip(null);
    }
  }, [isPolling]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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

  const handleSessionClick = (sessionId: string) => {
    setSelectedSessionId(sessionId);
  };

  if (!isOpen) return null;

  // Calculate totals
  const totalRowsInserted = systems.reduce((sum, sys) => {
    return sum + (sys.recordsProcessed || 0);
  }, 0);

  const totalDuration = systems.reduce((sum, sys) => {
    return sum + (sys.durationMs || 0);
  }, 0);

  // Minimum number of empty rows to show when no data
  const minEmptyRows = 5;
  const emptyRowsNeeded = Math.max(0, minEmptyRows - systems.length);

  const getStatusText = (system: SystemPollingState) => {
    // Check if waiting to start (no stages yet)
    if (
      (!system.stages || system.stages.length === 0) &&
      system.status === "pending"
    ) {
      return <span className="text-gray-500">-</span>;
    }

    // Check if in progress
    if (system.status === "polling") {
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
      if (system.sessionLabel && system.sessionId) {
        return (
          <button
            onClick={() => handleSessionClick(system.sessionId!)}
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

    switch (system.status) {
      case "completed":
        return (
          <StatusContent className="inline-flex items-center gap-1 text-green-400">
            <>
              <Check className="w-4 h-4" />
              <span className="status-text">ok</span>
            </>
          </StatusContent>
        );
      case "error":
        return (
          <StatusContent
            className="inline-flex items-center gap-1 text-red-400 cursor-help"
            onMouseEnter={(e) => {
              if (system.error) {
                const rect = e.currentTarget.getBoundingClientRect();
                setErrorTooltip({
                  error: system.error,
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
      case "skipped":
        return <span className="text-yellow-400">skipped</span>;
      default:
        return <span className="text-gray-500">-</span>;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-lg p-6 max-w-7xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto mobile-modal mobile-container">
        {/* Header */}
        <div className="flex justify-between items-start mb-4 mobile-header">
          <h3 className="text-lg font-semibold text-white">
            Polling All Systems
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
                {systems.map((system, index) => (
                  <tr
                    key={system.systemId}
                    className={`${index % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"} hover:bg-gray-700 transition-colors`}
                  >
                    <td className="px-4 py-2.5 text-sm">
                      <div>
                        <span className="text-gray-300">
                          {system.displayName || `System ${system.systemId}`}
                        </span>
                        <span className="text-gray-500">
                          {"\u00A0"}
                          ID:{"\u00A0"}
                          {system.systemId}
                        </span>
                      </div>
                    </td>
                    <td className="vendor-col px-4 py-2.5 text-sm text-gray-400">
                      {system.vendorType}
                    </td>
                    <td className="px-4 py-2.5 text-sm">
                      {getStatusText(system)}
                    </td>
                    <td className="session-col px-4 py-2.5 text-sm">
                      {system.sessionLabel && system.sessionId ? (
                        <button
                          onClick={() => handleSessionClick(system.sessionId!)}
                          className="font-mono text-xs text-gray-400 hover:text-gray-200 hover:underline transition-colors"
                        >
                          {system.sessionLabel}
                        </button>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-300 text-right">
                      {system.recordsProcessed !== undefined
                        ? system.recordsProcessed
                        : "-"}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-300 text-right">
                      <TimeCell system={system} />
                    </td>
                    <td className="px-4 py-2.5 text-sm h-12">
                      <div className="h-6">
                        {system.stages && system.stages.length > 0 ? (
                          <PollTimeline
                            sessionState={sessionState}
                            systemId={system.systemId}
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
                    className={`${(systems.length + index) % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"}`}
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
            :global(.mobile-container) th,
            :global(.mobile-container) td {
              padding-left: 10px !important;
              padding-right: 10px !important;
            }
            .status-text {
              display: none;
            }
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

      {/* Session Info Modal */}
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
