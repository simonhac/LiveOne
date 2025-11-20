"use client";

import React, { useState, useEffect } from "react";
import { X, Activity, CheckCircle, AlertCircle } from "lucide-react";
import {
  formatDateTime as formatDateTimeFE,
  formatDuration,
} from "@/lib/fe-date-format";
import JsonViewer from "@/components/JsonViewer";

interface PollingStats {
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
}

interface PollingStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  systemId: number | null;
  systemName: string;
  vendorType: string;
  status: "active" | "disabled" | "removed" | null;
  stats: PollingStats;
}

export default function PollingStatsModal({
  isOpen,
  onClose,
  systemId,
  systemName,
  vendorType,
  status,
  stats,
}: PollingStatsModalProps) {
  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const formatDateTime = (dateTimeStr: string | null) => {
    if (!dateTimeStr) return null;
    return formatDateTimeFE(dateTimeStr).display;
  };

  const getTimeSince = (dateTimeStr: string | null) => {
    if (!dateTimeStr) return null;
    const then = new Date(dateTimeStr).getTime();
    const now = new Date().getTime();
    return formatDuration(now - then);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-white">
            Statistics for {systemName}{" "}
            <span className="text-gray-500">ID: {systemId}</span> — {vendorType}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Metrics Grid */}
        <div className="bg-gray-900/50 rounded-lg p-4 mb-4">
          <div className="grid grid-cols-4 gap-4">
            <div>
              <div className="text-sm text-gray-400 mb-1">Status</div>
              <div
                className={`text-lg font-bold ${
                  status === "active"
                    ? "text-green-400"
                    : status === "disabled"
                      ? "text-orange-400"
                      : status === "removed"
                        ? "text-red-400"
                        : "text-gray-400"
                }`}
              >
                {status
                  ? status.charAt(0).toUpperCase() + status.slice(1)
                  : "Unknown"}
              </div>
            </div>

            <div>
              <div className="text-sm text-gray-400 mb-1">Total Polls</div>
              <div className="text-lg font-bold text-white">
                {stats.totalPolls.toLocaleString()}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                <span className="text-green-400">
                  {stats.successfulPolls.toLocaleString()}
                </span>{" "}
                ok,{" "}
                <span
                  className={
                    stats.failedPolls > 0 ? "text-red-400" : "text-gray-400"
                  }
                >
                  {stats.failedPolls.toLocaleString()}
                </span>{" "}
                failed
              </div>
            </div>

            <div>
              <div className="text-sm text-gray-400 mb-1">Success Rate</div>
              <div
                className={`text-lg font-bold ${
                  stats.successRate >= 95
                    ? "text-green-400"
                    : stats.successRate >= 80
                      ? "text-yellow-400"
                      : "text-red-400"
                }`}
              >
                {stats.successRate.toFixed(1)}%
              </div>
              {stats.consecutiveErrors > 0 && (
                <div className="text-xs text-yellow-400 mt-1">
                  {stats.consecutiveErrors} consecutive errors
                </div>
              )}
            </div>

            <div>
              <div className="text-sm text-gray-400 mb-1">Last Success</div>
              <div className="text-white">
                {stats.lastSuccessTime ? (
                  <>
                    {formatDateTime(stats.lastSuccessTime)}
                    <div className="text-xs text-gray-400 mt-1">
                      {getTimeSince(stats.lastSuccessTime)} ago
                    </div>
                  </>
                ) : (
                  <span className="text-gray-400">Never</span>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4 mt-4">
            <div>
              <div className="text-sm text-gray-400 mb-1">Last Error</div>
              <div className="text-white">
                {stats.lastErrorTime ? (
                  <>
                    {formatDateTime(stats.lastErrorTime)}
                    {stats.lastError && (
                      <div className="text-xs text-red-400 mt-1">
                        {stats.lastError.length > 50
                          ? stats.lastError.substring(0, 50) + "..."
                          : stats.lastError}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-gray-400">No errors</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Raw Comms Section */}
        {stats.lastResponse && (
          <div className="mb-4">
            <JsonViewer data={stats.lastResponse} />
          </div>
        )}

        {/* Close Button */}
        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
