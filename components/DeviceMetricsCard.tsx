"use client";

import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import Tile from "@/components/Tile";
import {
  formatValueWithUnit,
  formatValueParts,
} from "@/lib/point/format-value";
import { latestReadingsQuery } from "@/lib/queries";
import { useModalContext } from "@/contexts/ModalContext";
import { TILE_GRID_CONTAINER, tileGridClass } from "@/lib/dashboard/tile-grid";
import { SKELETON_CLASS, TileSkeleton } from "@/components/ui/skeleton";

/** Tiles drawn while the point list is in flight — see the note at the placeholder below. */
const SKELETON_TILE_COUNT = 4;

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
        <div
          data-skeleton=""
          className={`mx-1 h-48 ${SKELETON_CLASS}`}
          aria-hidden
        />
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

  if (isPending && rows.length === 0) {
    // The real tile count is the device's point count, which is exactly what this fetch is for —
    // so this placeholder can only ever be the typical case. It uses the SAME `TileSkeleton` and
    // the same grid policy as the settled tiles so at least the box model matches; the enclosing
    // `<CardSlot>` holds the previously-learned height for this node, which is what actually keeps
    // a 20-point DeepSea grid from shoving the page around on every load.
    return (
      <div className={TILE_GRID_CONTAINER}>
        <div className={tileGridClass(SKELETON_TILE_COUNT)}>
          {Array.from({ length: SKELETON_TILE_COUNT }).map((_, i) => (
            <TileSkeleton key={i} />
          ))}
        </div>
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
    <div className={TILE_GRID_CONTAINER}>
      <div className={tileGridClass(rows.length)}>
        {rows.map((row, i) => {
          // Number and unit stay SEPARATE so Tile can size the unit properly (a concatenated
          // "1234 rpm" would render entirely at hero size). See number-typography.md.
          const parts =
            row.value != null
              ? formatValueParts(row.value, row.metricUnit)
              : { value: "n/a", unit: undefined };
          // The only ReactElement case (json) is filtered out above, so this is a string here;
          // guard belt-and-suspenders to satisfy Tile's `value: string` contract.
          const value = typeof parts.value === "string" ? parts.value : "n/a";
          return (
            <Tile
              unit={parts.unit}
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
    </div>
  );
}
