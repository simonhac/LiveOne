"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AlertTriangle, Home } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import { dashboardDataQuery } from "@/lib/queries";
import { DashboardV4View } from "@/components/dashboard/v4/node-view";
import type { ReadableArea } from "@/lib/areas/list";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import type { ResolvedDevice } from "@/lib/dashboard/resolve-shell";
import type { LatestPointValues } from "@/lib/types/api";

/**
 * The slice of the `dashboardDataQuery` payload this chrome reads.
 *
 * 🛑 config-v4 Phase 13 PR 1: the payload key moved `system` -> `device`/`area`, and this cast is why
 * `tsc` could not see it — `dashboardDataQuery` returns `unknown`, so the OLD key would have compiled
 * clean and silently stopped rendering the viewer's dashboard (`data?.device` forever falsy). `/device`
 * routes are device-only, but the area leg is accepted rather than assumed away.
 */
interface DashboardData {
  device?: {
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
  area?: { id: number };
  latest: LatestPointValues;
}

interface DeviceViewerProps {
  systemId: string;
  device?: any; // Device object from database
  hasAccess: boolean;
  deviceExists: boolean;
  isAdmin: boolean;
  userId?: string;
  /**
   * The device's default v4 view, built SERVER-SIDE by `buildDeviceStrategyDoc` — the single
   * server/config capability path, grid + generator + config overrides folded in. Null when the device
   * is inaccessible/absent (Access-Denied render).
   */
  doc: DashboardV4 | null;
  /** Every `dv_` the doc binds (this device + any pin) — the renderer's device resolver input. */
  resolvedDevices: ResolvedDevice[];
}

/**
 * Read-only per-device viewer ("Device"), served at /device/{id}. Renders the SERVER-built default
 * document via the SAME v4 renderer the composition dashboards use (`<DashboardV4View>`): one group
 * bound to this DEVICE, no area. No Customise / Share / Location controls (those live on Dashboards).
 * This component owns only the device-level chrome (loading / error / removed banners); every card
 * self-fetches inside `<DashboardV4View>`.
 */
export default function DeviceViewer({
  systemId,
  device,
  hasAccess,
  deviceExists,
  doc,
  resolvedDevices,
}: DeviceViewerProps) {
  const { isAnyModalOpen } = useModalContext();

  // Device-level chrome payload via React Query (latest values + device). Polls every 30s and on
  // focus; paused while a modal is open. Used here only for the loading/error/removed banners — the
  // cards inside <DashboardV4View> self-fetch the same (deduped) query. The doc comes from the server.
  const {
    data: queryData,
    isPending,
    isError,
    error: dataError,
  } = useQuery(dashboardDataQuery(systemId ?? "", { paused: isAnyModalOpen }));
  const data = (queryData ?? null) as DashboardData | null;

  // A device page binds no Area, so the renderer's area map is always empty; every node addresses its
  // data through the inherited `device` ref instead (node-view.tsx: `area?.handle ?? device.systemId`).
  const areaById = useMemo(() => new Map<string, ReadableArea>(), []);
  const deviceById = useMemo(
    () => new Map(resolvedDevices.map((d) => [d.deviceId as string, d])),
    [resolvedDevices],
  );

  // Derive the display error: connection failure, an explicit `error` body, or the "device exists but
  // no charts" marker (a device with no readings yet).
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
    return device?.status !== "removed" ? "POINT_READINGS_NO_CHARTS" : "";
  }, [isError, dataError, queryData, device?.status]);

  if (!hasAccess || !deviceExists) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">
            Access Denied
          </h2>
          <p className="text-gray-400 mb-6">
            You don&apos;t have permission to view this device. Please contact
            your device administrator if you believe this is an error.
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
      {/* Removed Device Banner — shown regardless of data availability. */}
      {device?.status === "removed" && (
        <div className="mb-4 p-4 bg-orange-900/50 border border-orange-700 text-orange-300 rounded-lg flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <div>
            <span className="font-semibold">
              This device has been marked as removed.
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

      {/* `px-1` is the cards' own outer horizontal inset, sitting inside this `main`'s padding. */}
      {(data?.device ?? data?.area) && doc && (
        <div className="px-1">
          <DashboardV4View
            doc={doc}
            areaById={areaById}
            deviceById={deviceById}
            areasResolved
          />
        </div>
      )}
    </main>
  );
}
