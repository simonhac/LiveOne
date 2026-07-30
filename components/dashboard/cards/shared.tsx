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

/**
 * The slice of the `dashboardDataQuery` payload the cards read.
 *
 * config-v4 Phase 13 PR 1: the payload is DISCRIMINATED — `device` for a real device, `area` for an
 * Area served as an Area (previously both arrived as `system`, an Area via `synthesizeAreaView`'s
 * device-shaped fabrication). Cards read the shared fields through {@link subjectOf}; only a card that
 * genuinely needs device hardware (`vendorType`, `vendorSiteId`, `config`) narrows on `datum.device`,
 * and those fields are simply ABSENT for an area — as they were `null`/`"area"` filler before.
 */
export interface AreaDatum {
  device?: {
    id: number;
    deviceId: string;
    vendorType: string;
    vendorSiteId: string | null;
    timezoneOffsetMin: number;
    displayTimezone: string | null;
    config?: DeviceConfig | null;
  };
  area?: {
    id: number;
    areaId: string;
    timezoneOffsetMin: number;
    displayTimezone: string | null;
  };
  latest?: LatestPointValues;
}

/** The subject fields common to both legs — the drop-in replacement for the old `datum?.system`. */
export interface AreaDatumSubject {
  id: number;
  timezoneOffsetMin: number;
  displayTimezone: string | null;
  /** Device-only; undefined for an Area (was the `"area"` sentinel). */
  vendorType?: string;
  /** Device-only; undefined for an Area (was `"area:{handle}"`). */
  vendorSiteId?: string | null;
  /** Device-only; undefined for an Area (was `null`). */
  config?: DeviceConfig | null;
}

/**
 * Device-first, matching the server's `?systemId=` precedence (trap D-l). A payload never carries both
 * legs, so the order is documentation of intent rather than a tie-break.
 */
export function subjectOf(
  datum: AreaDatum | null | undefined,
): AreaDatumSubject | undefined {
  return datum?.device ?? datum?.area;
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
