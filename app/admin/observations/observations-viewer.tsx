"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  Play,
  Pause,
  RotateCcw,
  Trash2,
  Ticket,
  Radio,
  Database,
  Activity,
  AlertTriangle,
} from "lucide-react";
import { formatDateTime } from "@/lib/fe-date-format";
import SessionInfoModal from "@/components/SessionInfoModal";
import { QueueMessage } from "@/lib/observations/types";
import {
  Chart as ChartJS,
  BarElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Title,
  ChartOptions,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import "chartjs-adapter-date-fns";

ChartJS.register(BarElement, LinearScale, TimeScale, Tooltip, Legend, Title);

interface MinuteBucket {
  minute: string;
  count: number;
}

interface Stats {
  configured: boolean;
  now?: string;
  windowHours?: number;
  perMinute?: { raw: MinuteBucket[]; agg5m: MinuteBucket[] };
  summary?: {
    raw24h: number;
    agg5m24h: number;
    sessions24h: number;
    systems24h: number;
    lastIngestedAt: string | null;
  };
}

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
  body: QueueMessage | null;
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

const RAW_COLOR = "rgba(56, 189, 248, 0.75)"; // sky-400
const AGG_COLOR = "rgba(167, 139, 250, 0.75)"; // violet-400
const GRID_COLOR = "rgba(255, 255, 255, 0.06)";
const AXIS_COLOR = "#9ca3af";

type ObsChartData = {
  datasets: {
    label: string;
    data: { x: number; y: number }[];
    backgroundColor: string;
    stack: string;
    barPercentage: number;
    categoryPercentage: number;
    borderWidth: number;
  }[];
};

function relativeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTimestamp(ts: number): string {
  if (!ts) return "N/A";
  return formatDateTime(new Date(ts), { includeSeconds: false }).display;
}

export default function ObservationsViewer() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [messages, setMessages] = useState<PendingMessage[]>([]);
  const [dlqMessages, setDlqMessages] = useState<DLQMessage[]>([]);
  const [dlqCount, setDlqCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, infoRes, dlqRes, msgRes] = await Promise.all([
        fetch("/api/admin/observations/stats"),
        fetch("/api/admin/observations/info"),
        fetch("/api/admin/observations/dlq"),
        fetch("/api/admin/observations/messages"),
      ]);
      setStats(statsRes.ok ? await statsRes.json() : null);
      setQueue(infoRes.ok ? await infoRes.json() : null);
      setMessages(msgRes.ok ? ((await msgRes.json()).messages ?? []) : []);
      if (dlqRes.ok) {
        const d = await dlqRes.json();
        setDlqMessages(d.messages ?? []);
        setDlqCount(d.count ?? d.messages?.length ?? 0);
      } else {
        setDlqMessages([]);
        setDlqCount(null);
      }
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchAll, 60000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchAll]);

  const togglePause = async () => {
    if (!queue) return;
    setActionLoading(true);
    try {
      await fetch("/api/admin/observations/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: queue.paused ? "resume" : "pause" }),
      });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const setParallelism = async (n: number) => {
    setActionLoading(true);
    try {
      await fetch("/api/admin/observations/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-parallelism", parallelism: n }),
      });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
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
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const emptyDlq = async () => {
    setActionLoading(true);
    try {
      const response = await fetch("/api/admin/observations/dlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-all" }),
      });
      if (!response.ok) throw new Error(`Action failed: ${response.status}`);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  // Build a continuous 24h x 1-minute timeline, filling gaps with 0 so downtime
  // shows as a flat-zero stretch rather than a hidden gap.
  const chart = useMemo(() => {
    if (!stats?.configured || !stats.perMinute) return null;
    const nowMs = stats.now ? new Date(stats.now).getTime() : Date.now();
    const endMs = Math.floor(nowMs / 60000) * 60000;
    const startMs = endMs - 24 * 60 * 60 * 1000;
    const floorMin = (iso: string) =>
      Math.floor(new Date(iso).getTime() / 60000) * 60000;
    const rawMap = new Map(
      stats.perMinute.raw.map((b) => [floorMin(b.minute), b.count]),
    );
    const aggMap = new Map(
      stats.perMinute.agg5m.map((b) => [floorMin(b.minute), b.count]),
    );
    const rawData: { x: number; y: number }[] = [];
    const aggData: { x: number; y: number }[] = [];
    for (let t = startMs; t <= endMs; t += 60000) {
      rawData.push({ x: t, y: rawMap.get(t) ?? 0 });
      aggData.push({ x: t, y: aggMap.get(t) ?? 0 });
    }
    return { rawData, aggData };
  }, [stats]);

  const chartData = useMemo<ObsChartData | null>(
    () =>
      chart
        ? {
            datasets: [
              {
                label: "Raw",
                data: chart.rawData,
                backgroundColor: RAW_COLOR,
                stack: "obs",
                barPercentage: 1,
                categoryPercentage: 1,
                borderWidth: 0,
              },
              {
                label: "5-min agg",
                data: chart.aggData,
                backgroundColor: AGG_COLOR,
                stack: "obs",
                barPercentage: 1,
                categoryPercentage: 1,
                borderWidth: 0,
              },
            ],
          }
        : null,
    [chart],
  );

  const chartOptions: ChartOptions<"bar"> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "time",
          stacked: true,
          time: { unit: "hour", tooltipFormat: "MMM d, HH:mm" },
          ticks: { color: AXIS_COLOR, maxRotation: 0, autoSkip: true },
          grid: { color: GRID_COLOR },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { color: AXIS_COLOR, precision: 0 },
          grid: { color: GRID_COLOR },
          title: {
            display: true,
            text: "observations / min",
            color: AXIS_COLOR,
          },
        },
      },
      plugins: {
        legend: { labels: { color: "#d1d5db", boxWidth: 12 } },
        tooltip: { mode: "index", intersect: false },
      },
    }),
    [],
  );

  // Observations waiting in the queue. QStash only reports a message count (lag);
  // each message batches many observations, so we estimate from the sampled bodies
  // (the /messages endpoint returns up to 50). Exact when the whole backlog is sampled.
  const queued = useMemo(() => {
    const lag = queue?.lag ?? 0;
    if (lag === 0) return { value: 0, exact: true, perMsg: 0 };
    if (!messages.length) return null;
    let obs = 0;
    for (const m of messages) {
      obs += Array.isArray(m.body?.observations)
        ? m.body!.observations!.length
        : 0;
    }
    const perMsg = obs / messages.length;
    const exact = messages.length >= lag; // sampled the entire backlog
    return {
      value: exact ? obs : Math.round(perMsg * lag),
      exact,
      perMsg,
    };
  }, [messages, queue]);

  const summary = stats?.summary;
  const totalObs24h = summary ? summary.raw24h + summary.agg5m24h : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-sky-400" />
            Observations Pipeline
          </h1>
          <p className="text-sm text-gray-400">
            Live ingestion into Postgres
            {lastUpdated && (
              <span className="text-gray-500">
                {" "}
                · updated {relativeAgo(lastUpdated.toISOString())}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-sky-500"
            />
            Auto (60s)
          </label>
          {queue && (
            <label className="flex items-center gap-1.5 text-xs text-gray-400 select-none">
              Parallelism
              <select
                value={queue.parallelism}
                onChange={(e) => setParallelism(Number(e.target.value))}
                disabled={actionLoading}
                className="bg-gray-700 text-white rounded px-1.5 py-1 text-sm disabled:opacity-50"
                title="QStash queue parallelism — raise to drain a backlog faster (keep ≤ 8, under the Postgres pool max of 10)"
              >
                {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          {queue &&
            (queue.paused ? (
              <button
                onClick={togglePause}
                disabled={actionLoading}
                className="flex items-center justify-center gap-2 px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm disabled:opacity-50"
              >
                <Play className="w-4 h-4" />
                Resume
              </button>
            ) : (
              <button
                onClick={togglePause}
                disabled={actionLoading}
                className="flex items-center justify-center gap-2 px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 rounded text-sm disabled:opacity-50"
              >
                <Pause className="w-4 h-4" />
                Pause
              </button>
            ))}
          <button
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center justify-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-700 rounded text-red-400 text-sm">
          {error}
        </div>
      )}

      {stats && !stats.configured && (
        <div className="p-3 bg-amber-900/20 border border-amber-700 rounded text-amber-300 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Postgres isn&apos;t connected yet — set the database env vars and
            push the schema (<code>drizzle-kit push</code>). Queue health below
            still works; the ingestion chart populates once data starts flowing.
          </span>
        </div>
      )}

      <StatCards
        queue={queue}
        queued={queued}
        dlqCount={dlqCount}
        stats={stats}
        summary={summary}
        totalObs24h={totalObs24h}
      />

      <IngestionChart
        chartData={chartData}
        chartOptions={chartOptions}
        loading={loading}
        configured={stats?.configured}
      />

      <PendingTable
        messages={messages}
        loading={loading}
        onSelectSession={setSelectedSessionId}
      />

      <DlqTable
        dlqMessages={dlqMessages}
        loading={loading}
        actionLoading={actionLoading}
        onRetryAll={retryDlq}
        onEmpty={emptyDlq}
      />

      <SessionInfoModal
        isOpen={selectedSessionId !== null}
        onClose={() => setSelectedSessionId(null)}
        sessionId={selectedSessionId}
      />
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  valueClass = "text-white",
  hintClass = "text-gray-500",
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
  hintClass?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`text-2xl font-semibold mt-0.5 ${valueClass}`}>
        {value}
      </div>
      {hint && (
        <div className={`text-xs mt-0.5 truncate ${hintClass}`}>{hint}</div>
      )}
    </div>
  );
}

function StatCards({
  queue,
  queued,
  dlqCount,
  stats,
  summary,
  totalObs24h,
}: {
  queue: QueueInfo | null;
  queued: { value: number; exact: boolean; perMsg: number } | null;
  dlqCount: number | null;
  stats: Stats | null;
  summary: Stats["summary"];
  totalObs24h: number | null;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat
        label="Observations queued"
        value={
          queued
            ? queued.value.toLocaleString() + (queued.exact ? "" : " (est)")
            : "—"
        }
        hint={
          queued && queued.value > 0
            ? `~${queued.perMsg.toFixed(0)}/msg · ${(queue?.lag ?? 0).toLocaleString()} msgs`
            : queued
              ? "queue empty"
              : "no sample"
        }
        valueClass={queued && queued.value > 0 ? "text-sky-300" : "text-white"}
      />
      <Stat
        label="Queued messages"
        value={queue ? queue.lag.toLocaleString() : "—"}
        hint={
          queue?.paused
            ? "paused"
            : queue
              ? `parallelism ${queue.parallelism}`
              : "QStash unavailable"
        }
        hintClass={queue?.paused ? "text-orange-400" : "text-gray-500"}
      />
      <Stat
        label="Dead-letter"
        value={dlqCount === null ? "—" : dlqCount.toLocaleString()}
        hint={
          dlqCount && dlqCount >= 50 ? "showing first 50" : "failed deliveries"
        }
        hintClass={dlqCount && dlqCount > 0 ? "text-red-400" : "text-gray-500"}
      />
      <Stat
        label="Observations (24h)"
        value={totalObs24h === null ? "—" : totalObs24h.toLocaleString()}
        hint={
          summary
            ? `${summary.raw24h.toLocaleString()} raw · ${summary.agg5m24h.toLocaleString()} 5m`
            : ""
        }
      />
      <Stat
        label="Last ingested"
        value={summary ? relativeAgo(summary.lastIngestedAt) : "—"}
        hint={
          summary?.lastIngestedAt
            ? formatDateTime(new Date(summary.lastIngestedAt), {
                includeSeconds: true,
              }).display
            : ""
        }
      />
      <Stat
        label="Sessions (24h)"
        value={summary ? summary.sessions24h.toLocaleString() : "—"}
        hint="polls recorded"
      />
      <Stat
        label="Systems active (24h)"
        value={summary ? summary.systems24h.toLocaleString() : "—"}
        hint="distinct systems"
      />
      <Stat
        label="Queue"
        value={queue ? (queue.paused ? "Paused" : "Running") : "—"}
        hint={queue ? queue.name : ""}
        valueClass={
          queue
            ? queue.paused
              ? "text-orange-400"
              : "text-green-400"
            : undefined
        }
      />
      <Stat
        label="Postgres"
        value={stats ? (stats.configured ? "Connected" : "Not set") : "—"}
        hint={stats?.configured ? "receiving" : "configure env"}
        valueClass={
          stats
            ? stats.configured
              ? "text-green-400"
              : "text-amber-400"
            : undefined
        }
      />
    </div>
  );
}

function IngestionChart({
  chartData,
  chartOptions,
  loading,
  configured,
}: {
  chartData: ObsChartData | null;
  chartOptions: ChartOptions<"bar">;
  loading: boolean;
  configured?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Database className="w-4 h-4 text-gray-400" />
        <h2 className="text-sm font-medium text-gray-200">
          Observations ingested per minute · last 24h
        </h2>
      </div>
      <div className="h-[360px]">
        {chartData ? (
          <Bar data={chartData} options={chartOptions} />
        ) : (
          <div className="h-full flex items-center justify-center text-gray-500 text-sm">
            {loading
              ? "Loading…"
              : configured === false
                ? "Postgres not connected yet."
                : "No observations ingested in the last 24 hours."}
          </div>
        )}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Bucketed by Postgres insert time (point_readings.created_at) — the true
        ingestion rate. Raw readings and 5-minute aggregates stacked.
      </p>
    </div>
  );
}

function PendingTable({
  messages,
  loading,
  onSelectSession,
}: {
  messages: PendingMessage[];
  loading: boolean;
  onSelectSession: (id: string) => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-medium text-white mb-4">
        Pending{" "}
        {messages.length > 0 && (
          <span className="text-gray-500 font-normal text-sm">
            {messages.length} messages
          </span>
        )}
      </h2>

      {loading && messages.length === 0 ? (
        <Spinner />
      ) : messages.length === 0 ? (
        <p className="text-gray-500 text-sm">No messages</p>
      ) : (
        <div className="overflow-x-auto">
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
              {messages.map((msg, idx) => {
                const obsCount = msg.body?.observations?.length ?? 0;
                return (
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
                        const session = msg.body?.session;
                        // Session-only message
                        if (obs.length === 0 && session) {
                          return (
                            <span className="inline-flex items-center gap-1">
                              <Ticket className="w-3 h-3 text-gray-500" />
                              <button
                                onClick={() =>
                                  onSelectSession(session.sessionId)
                                }
                                className="font-mono hover:underline cursor-pointer"
                              >
                                {session.sessionLabel}
                              </button>
                            </span>
                          );
                        }
                        // Normal observations message
                        const topicCounts: Record<string, number> = {};
                        for (const o of obs) {
                          const topicName = o.topic.split("/").slice(-1)[0];
                          topicCounts[topicName] =
                            (topicCounts[topicName] || 0) + 1;
                        }
                        const entries = Object.entries(topicCounts).slice(0, 5);
                        const remaining = Object.keys(topicCounts).length - 5;
                        return (
                          <span className="inline-flex items-center gap-1">
                            <Radio className="w-3 h-3 text-gray-500" />
                            {entries
                              .map(([name, count]) =>
                                count > 1 ? `${name} (${count})` : name,
                              )
                              .join(", ") +
                              (remaining > 0 ? ` +${remaining} more` : "")}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-1.5 pr-4 text-right font-mono align-top">
                      {obsCount > 0 ? obsCount : ""}
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DlqTable({
  dlqMessages,
  loading,
  actionLoading,
  onRetryAll,
  onEmpty,
}: {
  dlqMessages: DLQMessage[];
  loading: boolean;
  actionLoading: boolean;
  onRetryAll: () => void;
  onEmpty: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-white">
          DLQ{" "}
          {dlqMessages.length > 0 && (
            <span className="text-gray-500 font-normal text-sm">
              {dlqMessages.length} messages
            </span>
          )}
        </h2>
        {dlqMessages.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={onRetryAll}
              disabled={actionLoading}
              className="flex items-center justify-center gap-2 w-[160px] py-1.5 bg-blue-700 hover:bg-blue-600 rounded text-sm disabled:opacity-50"
            >
              <RotateCcw className="w-4 h-4" />
              Retry All
            </button>
            <button
              onClick={onEmpty}
              disabled={actionLoading}
              className="flex items-center justify-center gap-2 w-[160px] py-1.5 bg-blue-700 hover:bg-blue-600 rounded text-sm disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              Empty DLQ
            </button>
          </div>
        )}
      </div>

      {loading && dlqMessages.length === 0 ? (
        <Spinner />
      ) : dlqMessages.length === 0 ? (
        <p className="text-gray-500 text-sm">No messages</p>
      ) : (
        <div className="overflow-x-auto">
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
  );
}
