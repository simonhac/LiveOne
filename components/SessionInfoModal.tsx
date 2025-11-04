"use client";

import { formatDateTime } from "@/lib/fe-date-format";
import { AlertCircle, X } from "lucide-react";
import { JsonView, darkStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

interface Session {
  id: number;
  sessionLabel?: string;
  systemId: number;
  vendorType: string;
  systemName: string;
  cause: string;
  started: string;
  duration: number;
  successful: boolean;
  errorCode?: string;
  error?: string;
  response?: any;
  numRows: number;
  createdAt: string;
}

interface SessionInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
}

// Helper function to format duration
const formatDuration = (durationMs: number): string => {
  if (durationMs >= 2000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  return `${durationMs}ms`;
};

const getCauseColor = (cause: string) => {
  switch (cause) {
    case "POLL":
      return "text-blue-400";
    case "PUSH":
      return "text-green-400";
    case "USER":
      return "text-yellow-400";
    case "ADMIN":
      return "text-purple-400";
    default:
      return "text-gray-400";
  }
};

export default function SessionInfoModal({
  isOpen,
  onClose,
  session,
}: SessionInfoModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto">
        {session && (
          <>
            {/* Header */}
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-lg font-semibold text-white">
                Session with{" "}
                <a
                  href={`/dashboard/${session.systemId}`}
                  className="hover:text-blue-400 hover:underline transition-colors"
                >
                  {session.systemName}{" "}
                  <span className="text-gray-500">ID: {session.systemId}</span>
                </a>{" "}
                — {session.vendorType}
              </h3>
              <button
                onClick={() => {
                  onClose();
                  // Remove focus from any button
                  if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                  }
                }}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Session Metrics - 4 core metrics in one row */}
              <div className="bg-gray-900/50 rounded-lg p-4">
                <div className="grid grid-cols-4 gap-4">
                  <div>
                    <p className="text-sm text-gray-400 mb-1">Time</p>
                    <p className="text-lg font-bold text-white">
                      {formatDateTime(session.started).display}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      Duration: {formatDuration(session.duration)}
                    </p>
                  </div>

                  <div>
                    <p className="text-sm text-gray-400 mb-1">Cause</p>
                    <p
                      className={`text-lg font-bold ${getCauseColor(session.cause)}`}
                    >
                      {session.cause}
                    </p>
                  </div>

                  <div>
                    <p className="text-sm text-gray-400 mb-1">Session ID</p>
                    <p className="text-lg font-bold text-white">
                      {session.sessionLabel ? (
                        <span className="font-mono">
                          {session.sessionLabel}
                        </span>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </p>
                  </div>

                  <div>
                    <p className="text-sm text-gray-400 mb-1">Status</p>
                    <p
                      className={`text-lg font-bold ${session.successful ? "text-green-400" : "text-red-400"}`}
                    >
                      {session.successful ? "Success" : "Failed"}
                      {session.errorCode && ` (${session.errorCode})`}
                    </p>
                    {session.numRows > 0 && (
                      <p className="text-xs text-gray-400 mt-1">
                        {session.numRows} rows
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Error details if present */}
              {session.error && (
                <div className="bg-red-900/20 border border-red-700 rounded-lg p-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-red-400 mb-1">
                        Error Details
                      </p>
                      <p className="text-sm text-red-300">{session.error}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Response data */}
              {session.response && (
                <div>
                  <div className="text-sm text-gray-400 mb-3">Raw Comms</div>
                  <div className="bg-gray-950 border border-gray-700 rounded-lg">
                    <div className="overflow-x-auto font-mono text-sm">
                      <JsonView
                        data={session.response}
                        shouldExpandNode={(level) => level < 3}
                        style={darkStyles}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="mt-6">
              <button
                onClick={() => {
                  onClose();
                  if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                  }
                }}
                className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
