"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AlertTriangle, Home } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import { dashboardDataQuery } from "@/lib/queries";
import Dashboard from "@/components/Dashboard";
import type { ReadableArea } from "@/lib/areas/list";
import type { DashboardV3 } from "@/lib/dashboard/v3";
import type { LatestPointValues } from "@/lib/types/api";

interface DashboardData {
  system: {
    id: number;
    vendorType: string;
    vendorSiteId: string;
    displayName: string;
    alias: string | null;
    displayTimezone: string | null;
    ownerClerkUserId: string;
    timezoneOffsetMin: number;
    status: string;
  };
  latest: LatestPointValues;
}

interface DeviceViewerProps {
  systemId: string;
  system?: any; // System object from database
  hasAccess: boolean;
  systemExists: boolean;
  isAdmin: boolean;
  userId?: string;
  /**
   * The device's default v3 view, built SERVER-SIDE from `buildAreaStrategyForHandle` — the single
   * server/config capability path, grid + generator + config overrides folded in. Null when the system
   * is inaccessible/absent (Access-Denied render).
   */
  descriptor: DashboardV3 | null;
  /** The section's render key (null when inaccessible/absent). */
  area: ReadableArea | null;
}

/**
 * Read-only per-system viewer ("Device"), served at /device/{id}. Renders the SERVER-built default
 * descriptor via the SAME v3 renderer the composition dashboards use (`<Dashboard>`): a single
 * section over the device handle. No Customise / Share / Location controls (those live on Dashboards).
 * This component owns only the device-level chrome (loading / error / removed banners); every card
 * self-fetches inside `<Dashboard>`.
 */
export default function DeviceViewer({
  systemId,
  system,
  hasAccess,
  systemExists,
  descriptor,
  area,
}: DeviceViewerProps) {
  const { isAnyModalOpen } = useModalContext();

  // Device-level chrome payload via React Query (latest values + system). Polls every 30s and on
  // focus; paused while a modal is open. Used here only for the loading/error/removed banners — the
  // cards inside <Dashboard> self-fetch the same (deduped) query. The descriptor comes from the server.
  const {
    data: queryData,
    isPending,
    isError,
    error: dataError,
  } = useQuery(dashboardDataQuery(systemId ?? "", { paused: isAnyModalOpen }));
  const data = (queryData ?? null) as DashboardData | null;

  // The section's Area is just a render key (the v3 renderer addresses data by `area.legacySystemId`).
  const areaById = useMemo(
    () => (area ? new Map([[area.id, area]]) : new Map<string, ReadableArea>()),
    [area],
  );

  // Derive the display error: connection failure, an explicit `error` body, or the "system exists but
  // no charts" marker (a system with no readings yet).
  const error = useMemo(() => {
    if (isError) {
      return dataError instanceof TypeError
        ? "Unable to connect to server"
        : "Failed to fetch data";
    }
    if (!queryData) return "";
    const r = queryData as { latest?: unknown; error?: string };
    if (r.latest) return "";
    if (r.error) return r.error;
    return system?.status !== "removed" ? "POINT_READINGS_NO_CHARTS" : "";
  }, [isError, dataError, queryData, system?.status]);

  if (!hasAccess || !systemExists) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">
            Access Denied
          </h2>
          <p className="text-gray-400 mb-6">
            You don&apos;t have permission to view this system. Please contact
            your system administrator if you believe this is an error.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            <Home className="w-4 h-4" />
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!data && isPending) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading Data…</p>
        </div>
      </div>
    );
  }

  return (
    <main className="max-w-7xl mx-auto px-1 py-4">
      {/* Removed System Banner — shown regardless of data availability. */}
      {system?.status === "removed" && (
        <div className="mb-4 p-4 bg-orange-900/50 border border-orange-700 text-orange-300 rounded-lg flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <div>
            <span className="font-semibold">
              This system has been marked as removed.
            </span>
          </div>
        </div>
      )}

      {error &&
        (error === "POINT_READINGS_NO_CHARTS" ? (
          <div className="bg-blue-900/50 border border-blue-700 text-blue-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>
              Charts coming soon. Raw data is available via the settings menu.
            </span>
          </div>
        ) : (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        ))}

      {data?.system && descriptor && (
        <Dashboard descriptor={descriptor} areaById={areaById} />
      )}
    </main>
  );
}
