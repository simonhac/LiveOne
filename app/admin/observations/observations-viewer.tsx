"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Play, Pause, RotateCcw } from "lucide-react";
import { formatDateTime } from "@/lib/fe-date-format";

interface QueueInfo {
  name: string;
  paused: boolean;
  lag: number;
  parallelism: number;
}

interface DLQMessage {
  messageId: string;
  topicName: string;
  url: string;
  body: string;
  createdAt: number;
  retried: number;
  maxRetries: number;
  responseStatus: number;
  responseBody: string;
}

interface DLQInfo {
  count: number;
  messages: DLQMessage[];
}

interface ObservationsData {
  queue: QueueInfo;
  pendingMessages: any[];
  dlq: DLQInfo;
}

export default function ObservationsViewer() {
  const [data, setData] = useState<ObservationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/observations?limit=100");
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const performAction = async (action: string) => {
    setActionLoading(true);
    try {
      const response = await fetch("/api/admin/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        throw new Error(`Action failed: ${response.status}`);
      }
      // Refresh data after action
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const formatTimestamp = (ts: number) => {
    if (!ts) return "N/A";
    return formatDateTime(new Date(ts), { includeSeconds: false }).display;
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-400">Loading...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-4 bg-red-900/20 border border-red-700 rounded-lg">
        <p className="text-red-400">Error: {error}</p>
        <button
          onClick={fetchData}
          className="mt-2 px-3 py-1 bg-red-700 hover:bg-red-600 rounded text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2">
        {data?.queue?.paused ? (
          <button
            onClick={() => performAction("resume")}
            disabled={actionLoading}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm disabled:opacity-50"
          >
            <Play className="w-4 h-4" />
            Resume Queue
          </button>
        ) : (
          <button
            onClick={() => performAction("pause")}
            disabled={actionLoading}
            className="flex items-center gap-2 px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 rounded text-sm disabled:opacity-50"
          >
            <Pause className="w-4 h-4" />
            Pause Queue
          </button>
        )}
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Pending Messages Section */}
      <div>
        <h2 className="text-lg font-medium text-white mb-4">
          Pending{" "}
          {data?.pendingMessages?.length ? (
            <span className="text-gray-500 font-normal text-sm">
              {data.pendingMessages.length} messages
            </span>
          ) : null}
        </h2>
        {!data?.pendingMessages?.length && (
          <p className="text-gray-500 text-sm">No messages</p>
        )}
        {data?.pendingMessages && data.pendingMessages.length > 0 && (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="text-gray-400 text-left border-b border-gray-700">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Time</th>
                  <th className="pb-2 pr-4 font-medium">System</th>
                  <th className="pb-2 pr-4 font-medium">Topics</th>
                  <th className="pb-2 pr-4 font-medium text-right">Obs</th>
                  <th className="pb-2 pr-4 font-medium text-right">Retries</th>
                  <th className="pb-2 font-medium">ID</th>
                </tr>
              </thead>
              <tbody className="text-gray-300 align-top">
                {data.pendingMessages.map((msg: any, idx: number) => (
                  <tr
                    key={msg.messageId}
                    className={idx % 2 === 0 ? "bg-gray-800/30" : ""}
                  >
                    <td className="py-1.5 pr-4 text-gray-400 whitespace-nowrap align-top">
                      {formatTimestamp(msg.createdAt)}
                    </td>
                    <td className="py-1.5 pr-4 whitespace-nowrap align-top">
                      {msg.body?.systemName || "Unknown"}{" "}
                      <span className="text-gray-500">
                        ID:{msg.body?.systemId}
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 text-gray-400 text-xs align-top">
                      {(() => {
                        const obs = msg.body?.observations || [];
                        // Count occurrences of each topic
                        const topicCounts: Record<string, number> = {};
                        for (const o of obs) {
                          const topicName = o.topic.split("/").slice(-1)[0];
                          topicCounts[topicName] =
                            (topicCounts[topicName] || 0) + 1;
                        }
                        const entries = Object.entries(topicCounts).slice(0, 5);
                        const remaining = Object.keys(topicCounts).length - 5;
                        return (
                          entries
                            .map(([name, count]) =>
                              count > 1 ? `${name} (${count})` : name,
                            )
                            .join(", ") +
                          (remaining > 0 ? ` +${remaining} more` : "")
                        );
                      })()}
                    </td>
                    <td className="py-1.5 pr-4 text-right font-mono align-top">
                      {msg.body?.observations?.length || 0}
                    </td>
                    <td className="py-1.5 pr-4 text-right font-mono text-gray-500 align-top">
                      {msg.retried || 0}
                    </td>
                    <td
                      className="py-1.5 text-gray-500 font-mono text-[10px] max-w-[250px] truncate direction-rtl text-left align-top"
                      dir="rtl"
                    >
                      {msg.messageId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* DLQ Section */}
      {data?.dlq && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-white">
              DLQ{" "}
              {data.dlq.count > 0 && (
                <span className="text-gray-500 font-normal text-sm">
                  {data.dlq.count} messages
                </span>
              )}
            </h2>
            {data.dlq.count > 0 && (
              <button
                onClick={() => performAction("retry-dlq")}
                disabled={actionLoading}
                className="flex items-center gap-2 px-3 py-1.5 bg-orange-700 hover:bg-orange-600 rounded text-sm disabled:opacity-50"
              >
                <RotateCcw className="w-4 h-4" />
                Retry All
              </button>
            )}
          </div>

          {data.dlq.count === 0 && (
            <p className="text-gray-500 text-sm">No messages</p>
          )}
          {data.dlq.count > 0 && (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-gray-400 text-left border-b border-gray-700">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Time</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium text-right">
                      Retries
                    </th>
                    <th className="pb-2 font-medium">ID</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300 align-top">
                  {data.dlq.messages.map((msg, idx) => (
                    <tr
                      key={msg.messageId}
                      className={idx % 2 === 0 ? "bg-gray-800/30" : ""}
                    >
                      <td className="py-1.5 pr-4 text-gray-400 whitespace-nowrap align-top">
                        {formatTimestamp(msg.createdAt)}
                      </td>
                      <td className="py-1.5 pr-4 font-mono text-red-400 align-top">
                        {msg.responseStatus}
                      </td>
                      <td className="py-1.5 pr-4 text-right font-mono text-gray-500 align-top">
                        {msg.retried}/{msg.maxRetries}
                      </td>
                      <td
                        className="py-1.5 text-gray-500 font-mono text-[10px] max-w-[250px] truncate direction-rtl text-left align-top"
                        dir="rtl"
                      >
                        {msg.messageId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
