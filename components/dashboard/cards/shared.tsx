"use client";

/**
 * Shared card plumbing — the per-card boilerplate that used to be repeated across every
 * `AreaXxx` wrapper in Dashboard.tsx.
 */
import { useQuery } from "@tanstack/react-query";
import { dashboardDataQuery } from "@/lib/queries";
import { useModalContext } from "@/contexts/ModalContext";
import type { LatestPointValues } from "@/lib/types/api";
import type { DeviceConfig } from "@/lib/capabilities/config";

/** The slice of the `dashboardDataQuery` payload the cards read. */
export interface AreaDatum {
  system?: {
    id: number;
    vendorType: string;
    vendorSiteId: string | null;
    timezoneOffsetMin: number;
    displayTimezone: string | null;
    config?: DeviceConfig | null;
  };
  latest?: LatestPointValues;
}

/**
 * A card's view of its system's live data: the shared `dashboardDataQuery` (React Query dedupes,
 * so all whole-area cards share one request; a device-bound card adds one), paused while any
 * modal is open. `paused` is exposed for plugins with a second query of their own (ev-provenance)
 * so modal-open pauses that too.
 */
export function useAreaDatum(systemId: number): {
  data: unknown;
  datum: AreaDatum | null;
  isLoading: boolean;
  paused: boolean;
} {
  const { isAnyModalOpen } = useModalContext();
  const { data, isLoading } = useQuery(
    dashboardDataQuery(systemId, { paused: isAnyModalOpen }),
  );
  return {
    data,
    datum: (data ?? null) as AreaDatum | null,
    isLoading,
    paused: isAnyModalOpen,
  };
}

/**
 * Seconds a tile can go without an update before it dims. Prefers the device's configured
 * `updateCadenceSeconds` (from `systems.config`); falls back to the vendor default (Enphase's slow
 * cloud cadence, else 5 min) when unconfigured.
 */
export function staleThreshold(
  vendorType: string,
  updateCadenceSeconds?: number,
): number {
  return updateCadenceSeconds ?? (vendorType === "enphase" ? 2100 : 300);
}

/**
 * The line chart's y-axis scaling hint, derived from the system's nameplate solar/inverter sizing
 * (`systemInfo.solarSize` "9 kW" / `ratings` "7.5kW, 48V"). Used by the per-device viewer historically;
 * resolved here so every section's lines chart scales the same. Undefined when no sizing is known.
 */
export function maxPowerHintFromSystemInfo(systemInfo?: {
  solarSize?: string;
  ratings?: string;
}): number | undefined {
  const solarMatch = systemInfo?.solarSize?.match(/^(\d+(?:\.\d+)?)\s+kW$/i);
  const solarKW = solarMatch ? parseFloat(solarMatch[1]) : undefined;
  const ratingMatch = systemInfo?.ratings?.match(/(\d+(?:\.\d+)?)kW/i);
  const inverterKW = ratingMatch ? parseFloat(ratingMatch[1]) : undefined;
  if (solarKW !== undefined && inverterKW !== undefined) {
    return Math.max(solarKW, inverterKW);
  }
  return solarKW ?? inverterKW;
}

/** A tile-shaped loading placeholder shown while a TileCell's data is in flight. */
export function TileSkeleton() {
  return (
    <div className="min-h-[120px] animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30" />
  );
}

/** A card-height loading placeholder for non-tile cards (charts / sankey / amber / generator-runs). */
export function ChartSkeleton() {
  return (
    <div className="min-h-[360px] animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30" />
  );
}
