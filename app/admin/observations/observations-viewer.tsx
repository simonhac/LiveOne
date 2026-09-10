"use client";

import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  Play,
  Pause,
  RotateCcw,
  Trash2,
  Activity,
  AlertTriangle,
} from "lucide-react";
import { formatDateTime } from "@/lib/fe-date-format";
import IngestionChart, { type IngestionSeries } from "./IngestionChart";

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
    devices24h: number;
    lastIngestedAt: string | null;
  };
}

/** One flow-control lane, as `/api/v4/queue` reports it. Mirrors `LaneState` + `stuck`. */
interface Lane {
  lane: string;
  key: string;
  waiting: number;
  inFlight: number;
  parallelism: number;
  pinned: boolean;
  paused: boolean;
  idle: boolean;
  stuck: boolean;
  error?: string;
}

/** The ingest path aggregate — `GET /api/v4/queue`, the same shape `liveone queue status` reads. */
interface IngestState {
  name: string;
  globalParallelism: { max: number; inFlight: number } | null;
  waiting: number;
  inFlight: number;
  pausedLanes: string[];
  lanes: Lane[];
  lastIngestedAt: string | null;
  stalledMinutes: number | null;
  stalled: boolean;
  paused: boolean;
}

/** One delivered/failed batch — `GET /api/v4/queue/timing`. Mirrors `MessageTiming`. */
interface Batch {
  messageId: string;
  lane: string | null;
  transport: string;
  createdAt: number | null;
  waitMs: number | null;
  durationMs: number | null;
  occupancyMs: number | null;
  attempts: { state: string; durationMs: number | null }[];
  state: string;
  settled: boolean;
  observations: number | null;
  systemId: number | null;
  error?: string;
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

interface ObservationsData {
  stats: Stats | null;
  ingest: IngestState | null;
  batches: Batch[];
  batchesTruncated: boolean;
  dlqMessages: DLQMessage[];
  dlqCount: number | null;
}

/**
 * The four reads behind this page.
 *
 * 🛑 The ingest path is read through `/api/v4/queue` — the SAME endpoint `liveone queue status`
 * calls, deliberately. It replaced a pair of admin-only twins (`observations/info`, `.../messages`)
 * that asked QStash their own slightly different questions; keeping one aggregate is what stops the
 * browser and the terminal disagreeing about whether ingest is healthy.
 */
async function fetchObservations(): Promise<ObservationsData> {
  const [statsRes, ingestRes, dlqRes, timingRes] = await Promise.all([
    fetch("/api/admin/observations/stats"),
    fetch("/api/v4/queue"),
    fetch("/api/admin/observations/dlq"),
    fetch("/api/v4/queue/timing?last=15m"),
  ]);
  const data: ObservationsData = {
    stats: statsRes.ok ? await statsRes.json() : null,
    ingest: ingestRes.ok ? await ingestRes.json() : null,
    batches: [],
    batchesTruncated: false,
    dlqMessages: [],
    dlqCount: null,
  };
  if (timingRes.ok) {
    const t = await timingRes.json();
    data.batches = t.messages ?? [];
    data.batchesTruncated = t.truncated ?? false;
  }
  if (dlqRes.ok) {
    const d = await dlqRes.json();
    data.dlqMessages = d.messages ?? [];
    data.dlqCount = d.count ?? d.messages?.length ?? 0;
  }
  return data;
}

export default function ObservationsViewer() {
  const queryClient = useQueryClient();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data,
    isPending,
    isError,
    error: queryError,
    dataUpdatedAt,
    refetch,
  } = useQuery({
    queryKey: ["admin", "observations"],
    queryFn: fetchObservations,
    refetchInterval: autoRefresh ? 60000 : false,
  });

  const stats = data?.stats ?? null;
  const ingest = data?.ingest ?? null;
  // Stable identity for the empty fallback so the downstream useMemo doesn't churn each render.
  const batches = useMemo(() => data?.batches ?? [], [data]);
  const dlqMessages = data?.dlqMessages ?? [];
  const dlqCount = data?.dlqCount ?? null;
  const loading = isPending;
  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null;
  const error =
    actionError ??
    (isError
      ? queryError instanceof Error
        ? queryError.message
        : "Failed to load"
      : null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "observations"] });

  /**
   * PATCH the ingest path, surfacing the server's own refusal text.
   *
   * 🛑 The route reports a refusal as `{ error }` and it is always a SENTENCE, not a code — "the
   * SUM across lanes would be 12, over the Postgres pool of 10". Swallowing it for a generic
   * "Action failed" is how an operator ends up retrying a write the server has already explained.
   */
  const patchIngest = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/v4/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res
        .json()
        .then((j) => j?.error as string | undefined)
        .catch(() => undefined);
      throw new Error(detail ?? `Action failed: ${res.status}`);
    }
  };

  const togglePauseMutation = useMutation({
    // No lane: pause/resume has always meant the whole path, and the route defaults it to `all`.
    mutationFn: (paused: boolean) => patchIngest({ paused: !paused }),
    onSuccess: invalidate,
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : "Action failed"),
  });

  const setParallelismMutation = useMutation({
    // 🛑 A lane is REQUIRED here — the cap is per-lane, and the route refuses an unscoped write so
    // one lane's number can never be applied fleet-wide by accident.
    mutationFn: ({ lane, n }: { lane: string; n: number }) =>
      patchIngest({ lane, parallelism: n }),
    onSuccess: invalidate,
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : "Action failed"),
  });

  const retryDlqMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/observations/dlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry-all" }),
      });
      if (!response.ok) throw new Error(`Action failed: ${response.status}`);
    },
    onSuccess: invalidate,
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : "Action failed"),
  });

  const emptyDlqMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/observations/dlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-all" }),
      });
      if (!response.ok) throw new Error(`Action failed: ${response.status}`);
    },
    onSuccess: invalidate,
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : "Action failed"),
  });

  const actionLoading =
    togglePauseMutation.isPending ||
    setParallelismMutation.isPending ||
    retryDlqMutation.isPending ||
    emptyDlqMutation.isPending;

  const togglePause = () => {
    if (!ingest) return;
    setActionError(null);
    togglePauseMutation.mutate(ingest.paused);
  };

  const setParallelism = (lane: string, n: number) => {
    setActionError(null);
    setParallelismMutation.mutate({ lane, n });
  };

  const retryDlq = () => {
    setActionError(null);
    retryDlqMutation.mutate();
  };

  const emptyDlq = () => {
    setActionError(null);
    emptyDlqMutation.mutate();
  };

  // Build a continuous 24h x 1-minute timeline, filling gaps with 0 so downtime
  // shows as a flat-zero stretch rather than a hidden gap.
  const ingestion = useMemo<IngestionSeries | null>(() => {
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
    const timestamps: Date[] = [];
    const raw: number[] = [];
    const agg: number[] = [];
    for (let t = startMs; t <= endMs; t += 60000) {
      timestamps.push(new Date(t));
      raw.push(rawMap.get(t) ?? 0);
      agg.push(aggMap.get(t) ?? 0);
    }
    return { timestamps, raw, agg };
  }, [stats]);

  // Observations waiting across the lanes. QStash reports a MESSAGE count per lane; each message
  // batches many observations, so we scale by the mean batch size of the recent window. It is an
  // estimate and says so — a waiting message's body is not readable from the flow-control API.
  const queued = useMemo(() => {
    if (!ingest) return null; // not loaded yet — show "—", not a misleading 0
    const waiting = ingest.waiting;
    if (waiting === 0) return { value: 0, exact: true, perMsg: 0 };
    const sizes = batches
      .map((b) => b.observations)
      .filter((n): n is number => n !== null);
    if (!sizes.length) return null;
    const perMsg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    return { value: Math.round(perMsg * waiting), exact: false, perMsg };
  }, [batches, ingest]);

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
          {ingest &&
            (ingest.paused ? (
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
                title="Pauses every lane. Publishing continues — messages accumulate in the wait list."
              >
                <Pause className="w-4 h-4" />
                Pause
              </button>
            ))}
          <button
            onClick={() => refetch()}
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
        ingest={ingest}
        queued={queued}
        dlqCount={dlqCount}
        stats={stats}
        summary={summary}
        totalObs24h={totalObs24h}
      />

      <LaneTable
        ingest={ingest}
        loading={loading}
        actionLoading={actionLoading}
        onSetParallelism={setParallelism}
      />

      <IngestionChart
        series={ingestion}
        loading={loading}
        configured={stats?.configured}
      />

      <BatchTable
        batches={batches}
        truncated={data?.batchesTruncated ?? false}
        loading={loading}
      />

      <DlqTable
        dlqMessages={dlqMessages}
        loading={loading}
        actionLoading={actionLoading}
        onRetryAll={retryDlq}
        onEmpty={emptyDlq}
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
  loading = false,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
  hintClass?: string;
  // When the underlying value isn't known yet, show a sweeping shimmer
  // skeleton instead of a placeholder number/dash.
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
      <div className="text-xs text-gray-400">{label}</div>
      {loading ? (
        <div aria-hidden className="mt-1.5 space-y-1.5">
          <div className="shimmer h-6 w-20 rounded" />
          {hint && <div className="shimmer h-3 w-28 rounded" />}
        </div>
      ) : (
        <>
          <div className={`text-2xl font-semibold mt-0.5 ${valueClass}`}>
            {value}
          </div>
          {hint && (
            <div className={`text-xs mt-0.5 truncate ${hintClass}`}>{hint}</div>
          )}
        </>
      )}
    </div>
  );
}

function StatCards({
  ingest,
  queued,
  dlqCount,
  stats,
  summary,
  totalObs24h,
}: {
  ingest: IngestState | null;
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
            ? `~${queued.perMsg.toFixed(0)}/msg · ${(ingest?.waiting ?? 0).toLocaleString()} msgs`
            : queued
              ? "queue empty"
              : "no sample"
        }
        valueClass={queued && queued.value > 0 ? "text-sky-300" : "text-white"}
        loading={queued === null}
      />
      <Stat
        label="Waiting / in flight"
        value={
          ingest
            ? `${ingest.waiting.toLocaleString()} / ${ingest.inFlight.toLocaleString()}`
            : "—"
        }
        loading={!ingest}
        hint={
          ingest?.paused
            ? "paused"
            : ingest
              ? `across ${ingest.lanes.length} lanes`
              : "QStash unavailable"
        }
        hintClass={ingest?.paused ? "text-orange-400" : "text-gray-500"}
      />
      <Stat
        label="Dead-letter"
        value={dlqCount === null ? "—" : dlqCount.toLocaleString()}
        hint={
          dlqCount && dlqCount >= 50 ? "showing first 50" : "failed deliveries"
        }
        hintClass={dlqCount && dlqCount > 0 ? "text-red-400" : "text-gray-500"}
        loading={dlqCount === null}
      />
      <Stat
        label="Observations (24h)"
        value={totalObs24h === null ? "—" : totalObs24h.toLocaleString()}
        loading={totalObs24h === null}
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
        loading={!summary}
      />
      <Stat
        label="Sessions (24h)"
        value={summary ? summary.sessions24h.toLocaleString() : "—"}
        hint="polls recorded"
        loading={!summary}
      />
      <Stat
        label="Systems active (24h)"
        value={summary ? summary.devices24h.toLocaleString() : "—"}
        hint="distinct systems"
        loading={!summary}
      />
      {/*
        🛑 `stalledMinutes`, not a queue depth. A rising backlog is ambiguous — a busy path and a
        blocked one both grow — but "nothing has landed for N minutes" is not. This is the field
        that would have been unambiguous from minute one of the 2026-09-09 stall.
      */}
      <Stat
        label="Ingest"
        value={
          ingest
            ? ingest.paused
              ? "Paused"
              : ingest.stalled
                ? "Stalled"
                : "Running"
            : "—"
        }
        hint={
          ingest?.stalledMinutes != null
            ? `${ingest.stalledMinutes} min since last write`
            : (ingest?.name ?? "")
        }
        valueClass={
          ingest
            ? ingest.paused || ingest.stalled
              ? "text-orange-400"
              : "text-green-400"
            : undefined
        }
        loading={!ingest}
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
        loading={!stats}
      />
    </div>
  );
}

/** ms → a compact "just how long was that" string. `null` renders as an em dash, never a zero. */
function ms(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
}

/**
 * The lanes, and the one control that changes them.
 *
 * 🛑 The lane list is enumerated by the server, never by "what QStash knows about" — a flow-control
 * key with nothing in flight may not exist at all, so building this from QStash's own key list
 * would render a TOTALLY STOPPED fleet as an empty table and read as healthy.
 */
function LaneTable({
  ingest,
  loading,
  actionLoading,
  onSetParallelism,
}: {
  ingest: IngestState | null;
  loading: boolean;
  actionLoading: boolean;
  onSetParallelism: (lane: string, n: number) => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-medium text-white mb-4">
        Lanes{" "}
        {ingest?.globalParallelism && (
          <span className="text-gray-500 font-normal text-sm">
            account-wide in flight {ingest.globalParallelism.inFlight}/
            {ingest.globalParallelism.max} — a cap here holds down every lane at
            once
          </span>
        )}
      </h2>

      {loading && !ingest ? (
        <Spinner />
      ) : !ingest ? (
        <p className="text-gray-500 text-sm">Ingest path unavailable</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-gray-400 text-left border-b border-gray-700">
              <tr>
                <th className="pb-2 pr-4 font-medium">Lane</th>
                <th className="pb-2 pr-4 font-medium text-right">Waiting</th>
                <th className="pb-2 pr-4 font-medium text-right">In flight</th>
                <th className="pb-2 pr-4 font-medium">Parallelism</th>
                <th className="pb-2 pr-4 font-medium">State</th>
                <th className="pb-2 font-medium">Key</th>
              </tr>
            </thead>
            <tbody className="text-gray-300">
              {ingest.lanes.map((lane, idx) => (
                <tr
                  key={lane.lane}
                  className={idx % 2 === 0 ? "bg-gray-800/30" : ""}
                >
                  <td className="py-1.5 pr-4 whitespace-nowrap">{lane.lane}</td>
                  <td className="py-1.5 pr-4 text-right font-mono">
                    {lane.waiting.toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-4 text-right font-mono">
                    {lane.inFlight.toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-4">
                    <select
                      value={lane.parallelism}
                      onChange={(e) =>
                        onSetParallelism(lane.lane, Number(e.target.value))
                      }
                      disabled={actionLoading}
                      className="bg-gray-700 text-white rounded px-1.5 py-0.5 text-sm disabled:opacity-50"
                      title="Pins this lane's cap. The SUM across lanes must stay within the Postgres pool (10) — every in-flight delivery holds a connection."
                    >
                      {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    {lane.pinned && (
                      <span className="ml-1.5 text-xs text-amber-400">
                        pinned
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 whitespace-nowrap">
                    {lane.error ? (
                      <span className="text-red-400" title={lane.error}>
                        unreadable
                      </span>
                    ) : lane.stuck ? (
                      <span className="text-red-400">STUCK</span>
                    ) : lane.paused ? (
                      <span className="text-orange-400">paused</span>
                    ) : lane.idle ? (
                      <span className="text-gray-500">idle</span>
                    ) : (
                      <span className="text-green-400">ok</span>
                    )}
                  </td>
                  <td className="py-1.5 text-gray-500 font-mono text-xs">
                    {lane.key}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {ingest.lanes.some((l) => l.error) && (
            <p className="mt-2 text-xs text-red-400">
              A lane marked <em>unreadable</em> shows zeros because QStash could
              not be asked — that is the absence of a reading, never a clean
              bill of health.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Recent batches, newest first — the browser's view of `liveone queue timing`.
 *
 * 🛑 Read `wait` and `duration` as a PAIR. A long wait with a short duration means something AHEAD
 * of this batch held the delivery slot; a long duration is the batch's own work. Conflating them is
 * how 2026-09-09 was misdiagnosed twice — those batches committed in ~4s each and still stalled the
 * fleet for 2h20m, because each one burned its whole retry schedule holding a FIFO slot.
 */
function BatchTable({
  batches,
  truncated,
  loading,
}: {
  batches: Batch[];
  truncated: boolean;
  loading: boolean;
}) {
  return (
    <div>
      <h2 className="text-lg font-medium text-white mb-4">
        Recent batches{" "}
        <span className="text-gray-500 font-normal text-sm">
          last 15 min
          {batches.length > 0 && ` · ${batches.length}`}
        </span>
      </h2>

      {loading && batches.length === 0 ? (
        <Spinner />
      ) : batches.length === 0 ? (
        <p className="text-gray-500 text-sm">No deliveries in the window</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-gray-400 text-left border-b border-gray-700">
              <tr>
                <th className="pb-2 pr-4 font-medium">Time</th>
                <th className="pb-2 pr-4 font-medium">Lane</th>
                <th className="pb-2 pr-4 font-medium text-right">System</th>
                <th className="pb-2 pr-4 font-medium text-right">Obs</th>
                <th className="pb-2 pr-4 font-medium text-right">Wait</th>
                <th className="pb-2 pr-4 font-medium text-right">Duration</th>
                <th className="pb-2 pr-4 font-medium text-right">Tries</th>
                <th className="pb-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="text-gray-300">
              {batches.map((b, idx) => (
                <tr
                  key={b.messageId}
                  className={idx % 2 === 0 ? "bg-gray-800/30" : ""}
                >
                  <td className="py-1.5 pr-4 text-gray-400 whitespace-nowrap">
                    {b.createdAt ? formatTimestamp(b.createdAt) : "—"}
                  </td>
                  <td className="py-1.5 pr-4 whitespace-nowrap">
                    {b.lane ?? <span className="text-gray-500">unlaned</span>}
                  </td>
                  <td className="py-1.5 pr-4 text-right font-mono text-gray-400">
                    {b.systemId ?? "—"}
                  </td>
                  <td className="py-1.5 pr-4 text-right font-mono">
                    {b.observations ?? "—"}
                  </td>
                  <td className="py-1.5 pr-4 text-right font-mono">
                    {ms(b.waitMs)}
                  </td>
                  <td className="py-1.5 pr-4 text-right font-mono">
                    {ms(b.durationMs)}
                  </td>
                  <td className="py-1.5 pr-4 text-right font-mono text-gray-500">
                    {b.attempts.length}
                  </td>
                  <td
                    className={`py-1.5 whitespace-nowrap ${
                      b.state === "DELIVERED"
                        ? "text-green-400"
                        : b.settled
                          ? "text-red-400"
                          : "text-gray-400"
                    }`}
                    title={b.error}
                  >
                    {b.state}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {truncated && (
            <p className="mt-2 text-xs text-amber-400">
              TRUNCATED — the read budget ran out before the window did. Every
              count above is an undercount.
            </p>
          )}
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
