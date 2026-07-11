"use client";

/**
 * The usher inspector — one generalised console for every source the usher manages. A source list
 * (health / running / last push / last error / cadence), each row expandable to its live detail:
 *   • fusher → site power flow + SOC + per-inverter + recent minutely reports
 *   • musher → the full register read (generic all-values table)
 * Fed by the SSE stream at /api/usher/stream (2 s cadence).
 */

import { useEffect, useState } from "react";

// ── loose view types (mirror state/view.ts; kept local so no server code enters the client bundle) ──
interface TickState {
  lastTickAt?: string;
  lastCount?: number | null;
  running: boolean;
  pushOk?: boolean;
  lastError?: string;
  lastErrorAt?: string;
}
interface SourceView {
  siteId: string;
  name: string;
  intervalSec: number;
  activeIntervalSec?: number;
  tick?: TickState;
  snapshot?: any;
}
interface UsherView {
  at: string;
  started: boolean;
  sources: SourceView[];
}

export default function Home() {
  const [view, setView] = useState<UsherView | null>(null);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const es = new EventSource("/api/usher/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        setView(JSON.parse(e.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
  }, []);

  return (
    <main className="min-h-screen p-6 max-w-4xl mx-auto">
      <header className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-semibold">usher</h1>
        <span className="text-sm opacity-60">
          {connected ? "● live" : "○ connecting…"}
          {view?.at ? ` · ${new Date(view.at).toLocaleTimeString()}` : ""}
        </span>
      </header>

      {!view || !view.started ? (
        <p className="opacity-70">
          {view && !view.started
            ? "No sources running — the usher hasn't started (missing/invalid usher.yaml?)."
            : "Connecting to the usher…"}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {view.sources.map((s) => (
            <SourceCard
              key={s.siteId}
              source={s}
              open={!!expanded[s.siteId]}
              onToggle={() =>
                setExpanded((m) => ({ ...m, [s.siteId]: !m[s.siteId] }))
              }
            />
          ))}
        </div>
      )}
    </main>
  );
}

// ── source card ─────────────────────────────────────────────────────────────

function SourceCard({
  source,
  open,
  onToggle,
}: {
  source: SourceView;
  open: boolean;
  onToggle: () => void;
}) {
  const health = healthOf(source);
  return (
    <section className="rounded-lg border border-black/10 dark:border-white/15 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${health.dot}`}
          title={health.label}
        />
        <span className="font-medium">{source.name}</span>
        <span className="opacity-60">{source.siteId}</span>
        {source.tick?.running && (
          <span className="text-xs rounded px-1.5 py-0.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            running
          </span>
        )}
        <span className="ml-auto text-sm opacity-70">
          {cadenceLabel(source)} · {tickLabel(source.tick)}
        </span>
        <span className="opacity-40">{open ? "▲" : "▼"}</span>
      </button>

      {source.tick?.lastError && (
        <div className="px-4 pb-2 text-sm text-red-600 dark:text-red-400">
          {source.tick.lastError}
          {source.tick.lastErrorAt
            ? ` (${new Date(source.tick.lastErrorAt).toLocaleTimeString()})`
            : ""}
        </div>
      )}

      {open && (
        <div className="px-4 py-3 border-t border-black/10 dark:border-white/10">
          {source.name === "fusher" ? (
            <FusherDetail snapshot={source.snapshot} />
          ) : source.name === "musher" ? (
            <MusherDetail snapshot={source.snapshot} />
          ) : (
            <Json value={source.snapshot} />
          )}
        </div>
      )}
    </section>
  );
}

// ── fusher detail ────────────────────────────────────────────────────────────

function FusherDetail({ snapshot }: { snapshot: any }) {
  const site = snapshot?.latestSiteMetrics?.site;
  const devices: any[] = snapshot?.site?.devices ?? [];
  const minutely: any[] = snapshot?.minutely ?? [];
  if (!site && devices.length === 0) {
    return (
      <p className="opacity-60 text-sm">Waiting for the first inverter read…</p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {site && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Solar" value={fmtW(site.solar?.powerW)} />
          <Stat
            label="Battery"
            value={fmtW(site.battery?.powerW)}
            sub={
              site.battery?.soc != null
                ? `${round(site.battery.soc, 1)}%`
                : undefined
            }
          />
          <Stat label="Grid" value={fmtW(site.grid?.powerW)} />
          <Stat label="Load" value={fmtW(site.load?.powerW)} />
        </div>
      )}

      {devices.length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wide opacity-50 mb-1">
            Inverters
          </h3>
          <ul className="text-sm flex flex-col gap-1">
            {devices.map((d) => (
              <li key={d.serialNumber} className="flex gap-2">
                <span className="font-medium">{d.name || d.serialNumber}</span>
                {d.isMaster && <span className="opacity-50">master</span>}
                <span className="opacity-60">{d.ip}</span>
                {d.faultCode != null && (
                  <span className="text-red-500">
                    fault {String(d.faultCode)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {minutely.length > 0 && (
        <MinutelyTable rows={minutely.slice(-8).reverse()} />
      )}
    </div>
  );
}

function MinutelyTable({ rows }: { rows: any[] }) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide opacity-50 mb-1">
        Recent minutely
      </h3>
      <div className="overflow-x-auto">
        <table className="text-sm w-full">
          <thead className="opacity-50 text-left">
            <tr>
              <th className="pr-3 font-normal">time</th>
              <th className="pr-3 font-normal">solar</th>
              <th className="pr-3 font-normal">load</th>
              <th className="pr-3 font-normal">battery</th>
              <th className="pr-3 font-normal">grid</th>
              <th className="pr-3 font-normal">soc</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.sequence ?? i}>
                <td className="pr-3">{shortTime(r.timestamp)}</td>
                <td className="pr-3">{fmtW(r.solarW)}</td>
                <td className="pr-3">{fmtW(r.loadW)}</td>
                <td className="pr-3">{fmtW(r.batteryW)}</td>
                <td className="pr-3">{fmtW(r.gridW)}</td>
                <td className="pr-3">
                  {r.batterySOC != null ? `${round(r.batterySOC, 1)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── musher detail (generic all-values table) ──────────────────────────────────

function MusherDetail({ snapshot }: { snapshot: any }) {
  const values: Record<string, unknown> | null = snapshot?.values ?? null;
  if (!values) {
    return (
      <p className="opacity-60 text-sm">Waiting for the first register read…</p>
    );
  }
  const keys = Object.keys(values).sort();
  return (
    <div>
      <div className="text-xs opacity-50 mb-1">
        {snapshot?.at ? `read ${shortTime(snapshot.at)}` : ""}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
        {keys.map((k) => (
          <div
            key={k}
            className="flex justify-between gap-2 border-b border-black/5 dark:border-white/5 py-0.5"
          >
            <span className="opacity-60">{k}</span>
            <span className="font-mono">{fmtVal(values[k])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── bits ─────────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2">
      <div className="text-xs uppercase tracking-wide opacity-50">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs opacity-60">{sub}</div>}
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="text-xs overflow-x-auto opacity-70">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function healthOf(s: SourceView): { dot: string; label: string } {
  const t = s.tick;
  if (!t?.lastTickAt) return { dot: "bg-gray-400", label: "no data yet" };
  if (t.lastCount === null || t.pushOk === false)
    return { dot: "bg-red-500", label: "last tick errored" };
  const ageSec = (Date.now() - Date.parse(t.lastTickAt)) / 1000;
  const stale = ageSec > s.intervalSec * 2 + 30;
  return stale
    ? { dot: "bg-amber-500", label: "stale" }
    : { dot: "bg-emerald-500", label: "healthy" };
}

function cadenceLabel(s: SourceView): string {
  const idle = `${s.intervalSec}s`;
  return s.activeIntervalSec && s.activeIntervalSec !== s.intervalSec
    ? `${idle}/${s.activeIntervalSec}s`
    : idle;
}

function tickLabel(t?: TickState): string {
  if (!t?.lastTickAt) return "never";
  const n = t.lastCount;
  const pushed = n == null ? "err" : `${n} pt`;
  return `${pushed} · ${shortTime(t.lastTickAt)}`;
}

function fmtW(w: unknown): string {
  if (w == null || typeof w !== "number" || Number.isNaN(w)) return "—";
  const kw = w / 1000;
  return `${kw >= 0 ? "" : ""}${round(kw, kw >= 10 || kw <= -10 ? 1 : 2)} kW`;
}

function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return round(v, 2).toString();
  return String(v);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function shortTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString();
}
