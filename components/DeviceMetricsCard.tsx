"use client";

import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import Tile from "@/components/Tile";
import { formatValueWithUnit } from "@/lib/point/format-value";
import { latestReadingsQuery } from "@/lib/queries";
import { useModalContext } from "@/contexts/ModalContext";

/**
 * Generic device-metrics card — a single device's numeric points, rendered straight from their own
 * `point_info` metadata with NO energy-flow role required (battery voltage, engine rpm, coolant temp,
 * oil pressure, …). This is the role-free surface for device instrumentation the role-shaped tile
 * catalog can't represent (e.g. a DeepSea generator).
 *
 * Two presentations via `variant`:
 *  - `grid` (default): a responsive grid of gauge <Tile>s.
 *  - `table`: a compact two-column list (metric name → formatted value) — the "all values" panel the
 *    device view leads with, for every device.
 *
 * It reuses the generic data path — `latestReadingsQuery` (`/api/data?include=readings`) enumerates
 * ALL of the device's active points merged with the cached latest values; an active-but-uncached point
 * (e.g. an engine-off sensor with no reading yet) comes back with no value and renders "n/a". Values
 * go through the shared `formatValueWithUnit`, so this never diverges from the raw-readings table.
 * Purely presentational beyond its own read; no per-device API.
 */
export default function DeviceMetricsCard({
  systemId,
  staleThresholdSeconds,
  variant = "grid",
}: {
  systemId: number;
  staleThresholdSeconds: number;
  variant?: "grid" | "table";
}) {
  const { isAnyModalOpen } = useModalContext();
  const { data, isPending } = useQuery(
    latestReadingsQuery(systemId, { paused: isAnyModalOpen }),
  );

  // Keep points with a logical path (drop stale/invalid entries) and skip JSON blobs (locations) —
  // everything else (numeric / boolean / text) renders fine through formatValueWithUnit.
  const rows = (data?.values ?? []).filter(
    (v) => v.logicalPath && v.metricUnit !== "json",
  );

  if (variant === "table") {
    if (isPending && rows.length === 0) {
      return (
        <div className="mx-1 h-48 animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30" />
      );
    }
    if (rows.length === 0) {
      return (
        <div className="mx-1 rounded-lg border border-gray-700/50 bg-gray-900/30 px-4 py-6 text-center text-sm text-gray-400">
          No device metrics available.
        </div>
      );
    }
    const nowMs = Date.now();
    return (
      <div className="mx-1 overflow-hidden rounded-lg border border-gray-700/50 bg-gray-900/30">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-800">
            {rows.map((row, i) => {
              const formatted =
                row.value != null
                  ? formatValueWithUnit(row.value, row.metricUnit)
                  : "n/a";
              const value = typeof formatted === "string" ? formatted : "n/a";
              const ageSec = row.measurementTime
                ? (nowMs - new Date(row.measurementTime).getTime()) / 1000
                : null;
              const isStale = ageSec != null && ageSec > staleThresholdSeconds;
              const missing = row.value == null;
              return (
                <tr
                  key={
                    row.pointReference ??
                    row.logicalPath ??
                    `${row.physicalPath}-${i}`
                  }
                  className="hover:bg-gray-800/40"
                >
                  <td className="px-3 py-1.5 text-gray-300">{row.pointName}</td>
                  <td
                    className={`px-3 py-1.5 text-right font-mono tabular-nums ${
                      missing || isStale ? "text-gray-500" : "text-white"
                    }`}
                    title={
                      isStale && row.measurementTime
                        ? `Last updated ${new Date(row.measurementTime).toLocaleString()}`
                        : undefined
                    }
                  >
                    {value}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const gridClass =
    "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1";

  if (isPending && rows.length === 0) {
    return (
      <div className={gridClass}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="min-h-[110px] animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30"
          />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-700/50 bg-gray-900/30 px-4 py-6 text-center text-sm text-gray-400">
        No device metrics available.
      </div>
    );
  }

  return (
    <div className={gridClass}>
      {rows.map((row, i) => {
        const formatted =
          row.value != null
            ? formatValueWithUnit(row.value, row.metricUnit)
            : "n/a";
        // The only ReactElement case (json) is filtered out above, so `formatted` is a string here;
        // guard belt-and-suspenders to satisfy Tile's `value: string` contract.
        const value = typeof formatted === "string" ? formatted : "n/a";
        return (
          <Tile
            key={
              row.pointReference ??
              row.logicalPath ??
              `${row.physicalPath}-${i}`
            }
            title={row.pointName}
            value={value}
            icon={<Gauge className="w-6 h-6" />}
            iconColor="text-slate-400"
            bgColor="bg-slate-800/40"
            borderColor="border-slate-700"
            staleThresholdSeconds={staleThresholdSeconds}
            measurementTime={
              row.measurementTime ? new Date(row.measurementTime) : undefined
            }
          />
        );
      })}
    </div>
  );
}
