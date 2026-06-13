"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const PAGE_SIZE = 10;

interface RunEvent {
  date: string;
  startTime: string;
  endTime: string | null;
  running?: boolean;
  durationSeconds?: number | null;
  startTimeISO?: string;
  energyKwh: number;
}

interface RunPeriodsPage {
  events: RunEvent[];
  hasMore?: boolean;
  running?: boolean;
}

/** Format a duration in seconds as "2h 30m" / "45m" / "3h". */
function formatDuration(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * A compact dashboard panel listing a device's most recent generator runs, paged 10 at a time.
 * Shown on dashboards whose system has an enabled generator tracker (see lib/dashboard/cards.ts
 * "generator-runs"). Reads the bounded, paged run-periods API.
 */
export default function GeneratorRunsCard({ systemId }: { systemId: number }) {
  const [offset, setOffset] = useState(0);

  const { data, isPending, isError } = useQuery<RunPeriodsPage | null>({
    queryKey: ["system", systemId, "run-periods", "generator", "page", offset],
    queryFn: async () => {
      const res = await fetch(
        `/api/system/${systemId}/run-periods?role=generator&limit=${PAGE_SIZE}&offset=${offset}`,
        { credentials: "same-origin" },
      );
      return res.ok ? ((await res.json()) as RunPeriodsPage) : null;
    },
    staleTime: 60_000,
    placeholderData: (prev) => prev, // keep the current page visible while the next loads
    enabled: !!systemId,
  });

  const events = data?.events ?? [];
  const hasMore = !!data?.hasMore;
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  const th = "px-4 py-2 text-xs font-medium text-gray-200";
  const td = "px-4 py-2 text-sm";

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          Generator runs
          {data?.running && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              running
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            className="p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            title="Newer"
            aria-label="Newer runs"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs text-gray-400 tabular-nums px-1">
            {page}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={!hasMore}
            className="p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            title="Older"
            aria-label="Older runs"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isPending && !data ? (
        <div className="px-4 py-6 text-sm text-gray-400">Loading…</div>
      ) : isError ? (
        <div className="px-4 py-6 text-sm text-red-400">
          Failed to load generator runs
        </div>
      ) : events.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400">
          No generator runs recorded
        </div>
      ) : (
        <table className="w-full">
          <thead className="bg-gray-700">
            <tr>
              <th className={`${th} text-left`}>Date</th>
              <th className={`${th} text-left`}>Time</th>
              <th className={`${th} text-right`}>Duration</th>
              <th className={`${th} text-right`}>Energy (kWh)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {events.map((e, i) => {
              const durationSec =
                e.running && e.startTimeISO
                  ? (Date.now() - Date.parse(e.startTimeISO)) / 1000
                  : (e.durationSeconds ?? null);
              return (
                <tr
                  key={i}
                  className="text-gray-100 odd:bg-gray-800 even:bg-gray-750"
                >
                  <td className={td}>{e.date}</td>
                  <td className={td}>
                    {e.running
                      ? `${e.startTime} – now`
                      : e.endTime === null || e.startTime === e.endTime
                        ? e.startTime
                        : `${e.startTime} - ${e.endTime}`}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {durationSec != null ? formatDuration(durationSec) : "—"}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {e.energyKwh.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
