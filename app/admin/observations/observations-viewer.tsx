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

interface PendingMessage {
  messageId: string;
  createdAt: number;
  retried: number;
  body: any;
}

interface DLQMessage {
  messageId: string;
  dlqId: string;
  topicName: string;
  url: string;
  body: string;
  createdAt: number;
  retried: number;
  maxRetries: number;
  responseStatus: number;
  responseBody: string;
}

export default function ObservationsViewer() {
  // Separate state for each section
  const [queueInfo, setQueueInfo] = useState<QueueInfo | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);

  const [messages, setMessages] = useState<PendingMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const [dlqMessages, setDlqMessages] = useState<DLQMessage[]>([]);
  const [dlqLoading, setDlqLoading] = useState(true);
  const [dlqError, setDlqError] = useState<string | null>(null);

  const [actionLoading, setActionLoading] = useState(false);

  const fetchQueueInfo = useCallback(async () => {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const response = await fetch("/api/admin/observations/info");
      if (!response.ok) throw new Error(`Failed: ${response.status}`);
      const result = await response.json();
      setQueueInfo(result);
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setQueueLoading(false);
    }
  }, []);

  const fetchMessages = useCallback(async () => {
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const response = await fetch("/api/admin/observations/messages");
      if (!response.ok) throw new Error(`Failed: ${response.status}`);
      const result = await response.json();
      setMessages(result.messages || []);
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  const fetchDlq = useCallback(async () => {
    setDlqLoading(true);
    setDlqError(null);
    try {
      const response = await fetch("/api/admin/observations/dlq");
      if (!response.ok) throw new Error(`Failed: ${response.status}`);
      const result = await response.json();
      setDlqMessages(result.messages || []);
    } catch (err) {
      setDlqError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDlqLoading(false);
    }
  }, []);

  const fetchAll = useCallback(() => {
    fetchQueueInfo();
    fetchMessages();
    fetchDlq();
  }, [fetchQueueInfo, fetchMessages, fetchDlq]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const performQueueAction = async (action: string) => {
    setActionLoading(true);
    try {
      const response = await fetch("/api/admin/observations/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(`Action failed: ${response.status}`);
      await fetchQueueInfo();
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const retryDlq = async () => {
    setActionLoading(true);
    try {
      const response = await fetch("/api/admin/observations/dlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry-all" }),
      });
      if (!response.ok) throw new Error(`Action failed: ${response.status}`);
      await fetchDlq();
    } catch (err) {
      setDlqError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const formatTimestamp = (ts: number) => {
    if (!ts) return "N/A";
    return formatDateTime(new Date(ts), { includeSeconds: false }).display;
  };

  const Spinner = () => (
    <div className="flex items-center justify-center py-8">
      <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header with queue count and action buttons */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-gray-400">
          {queueLoading ? (
            <span className="text-gray-500">Loading...</span>
          ) : queueInfo ? (
            <span>
              <span className="text-white font-medium">{queueInfo.lag}</span>{" "}
              queued messages
              {queueInfo.paused && (
                <span className="ml-2 text-yellow-500">(paused)</span>
              )}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {queueInfo?.paused ? (
            <button
              onClick={() => performQueueAction("resume")}
              disabled={actionLoading || queueLoading}
              className="flex items-center justify-center gap-2 w-[160px] py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              Resume Queue
            </button>
          ) : (
            <button
              onClick={() => performQueueAction("pause")}
              disabled={actionLoading || queueLoading}
              className="flex items-center justify-center gap-2 w-[160px] py-1.5 bg-yellow-700 hover:bg-yellow-600 rounded text-sm disabled:opacity-50"
            >
              <Pause className="w-4 h-4" />
              Pause Queue
            </button>
          )}
          <button
            onClick={fetchAll}
            disabled={queueLoading && messagesLoading && dlqLoading}
            className="flex items-center justify-center gap-2 w-[160px] py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-50"
          >
            <RefreshCw
              className={`w-4 h-4 ${queueLoading || messagesLoading || dlqLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Queue Info Error */}
      {queueError && (
        <div className="p-3 bg-red-900/20 border border-red-700 rounded text-red-400 text-sm">
          Queue info error: {queueError}
        </div>
      )}

      {/* Pending Messages Section */}
      <div>
        <h2 className="text-lg font-medium text-white mb-4">
          Pending{" "}
          {!messagesLoading && messages.length > 0 && (
            <span className="text-gray-500 font-normal text-sm">
              {messages.length} messages
            </span>
          )}
        </h2>

        {messagesLoading ? (
          <Spinner />
        ) : messagesError ? (
          <div className="p-3 bg-red-900/20 border border-red-700 rounded text-red-400 text-sm">
            {messagesError}
          </div>
        ) : messages.length === 0 ? (
          <p className="text-gray-500 text-sm">No messages</p>
        ) : (
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
                {messages.map((msg, idx) => (
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
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-white">
            DLQ{" "}
            {!dlqLoading && dlqMessages.length > 0 && (
              <span className="text-gray-500 font-normal text-sm">
                {dlqMessages.length} messages
              </span>
            )}
          </h2>
          {dlqMessages.length > 0 && (
            <button
              onClick={retryDlq}
              disabled={actionLoading}
              className="flex items-center gap-2 px-3 py-1.5 bg-orange-700 hover:bg-orange-600 rounded text-sm disabled:opacity-50"
            >
              <RotateCcw className="w-4 h-4" />
              Retry All
            </button>
          )}
        </div>

        {dlqLoading ? (
          <Spinner />
        ) : dlqError ? (
          <div className="p-3 bg-red-900/20 border border-red-700 rounded text-red-400 text-sm">
            {dlqError}
          </div>
        ) : dlqMessages.length === 0 ? (
          <p className="text-gray-500 text-sm">No messages</p>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="text-gray-400 text-left border-b border-gray-700">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Time</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium text-right">Retries</th>
                  <th className="pb-2 font-medium">ID</th>
                </tr>
              </thead>
              <tbody className="text-gray-300 align-top">
                {dlqMessages.map((msg, idx) => (
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
    </div>
  );
}
