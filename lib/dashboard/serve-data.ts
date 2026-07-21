import { getPollingStatus } from "@/lib/polling-utils";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { transformDates } from "@/lib/json";
import { PointManager } from "@/lib/point/point-manager";
import { resolvePointDisplay } from "@/lib/point/display/registry";
import {
  SystemsManager,
  type SystemWithPolling,
} from "@/lib/systems-manager";
import type { ServerTimer } from "@/lib/server-timing";

/**
 * One row of the detailed "latest readings" table (`include=readings`). A superset of the `latest`
 * map: it also lists active points that have NO cached value yet (expected-but-missing) and carries
 * per-point metadata (physical path, session labels). Date fields are renamed by `jsonResponse`
 * (measurementTimeMs → measurementTime).
 */
interface LatestReadingRow {
  value?: number | string | boolean;
  physicalPath: string;
  logicalPath: string | null;
  pointReference?: string;
  measurementTimeMs?: number;
  receivedTimeMs?: number;
  metricUnit: string;
  pointName: string;
  sessionId?: string;
  sessionLabel?: string;
  /** Resolved from the central display registry (unit + Excel number format), null when uncovered. */
  displayUnit?: string;
  displayFormat?: string;
}

/**
 * The raw (untransformed) payload for one system — shared by the `/api/data` single-system and batch
 * paths AND by the dashboard SSR prefetch. Callers transform dates (`jsonResponse`/`transformDates`)
 * before returning/caching.
 */
export async function buildSystemPayload(
  system: SystemWithPolling,
  wantsReadings: boolean,
  timer?: ServerTimer,
) {
  // Polling status, the KV latest-values cache, and (if requested) the active-points list are
  // mutually independent reads — fire them concurrently rather than paying each round-trip in
  // sequence. The optional timer spans them individually (they overlap; that's the point) —
  // `kv` is the Vercel KV REST round trip, a prime latency suspect.
  const [pollingStatusResult, latest, expectedPoints] = await Promise.all([
    timer
      ? timer.time("polling", () => getPollingStatus(system.id))
      : getPollingStatus(system.id),
    timer
      ? timer.time("kv", () => getLatestPointValues(system.id))
      : getLatestPointValues(system.id),
    wantsReadings
      ? PointManager.getInstance().getActivePointsForSystem(system.id)
      : Promise.resolve(undefined),
  ]);

  // Build the system object with full SystemWithPolling data
  const systemData = {
    id: system.id,
    vendorType: system.vendorType,
    vendorSiteId: system.vendorSiteId,
    displayName: system.displayName,
    alias: system.alias,
    displayTimezone: system.displayTimezone,
    ownerClerkUserId: system.ownerClerkUserId,
    timezoneOffsetMin: system.timezoneOffsetMin,
    status: system.status,
    model: system.model,
    serial: system.serial,
    ratings: system.ratings,
    solarSize: system.solarSize,
    batterySize: system.batterySize,
    location: system.location,
    metadata: system.metadata,
    config: system.config,
    createdAt: system.createdAt,
    updatedAt: system.updatedAt,
    supportsPolling: VendorRegistry.supportsPolling(system.vendorType),
    pollingStatus: pollingStatusResult
      ? {
          lastPollTime: pollingStatusResult?.lastPollTime
            ? formatTime_fromJSDate(
                pollingStatusResult.lastPollTime,
                system.timezoneOffsetMin,
              )
            : null,
          lastSuccessTime: pollingStatusResult?.lastSuccessTime
            ? formatTime_fromJSDate(
                pollingStatusResult.lastSuccessTime,
                system.timezoneOffsetMin,
              )
            : null,
          lastErrorTime: pollingStatusResult?.lastErrorTime
            ? formatTime_fromJSDate(
                pollingStatusResult.lastErrorTime,
                system.timezoneOffsetMin,
              )
            : null,
          lastError: pollingStatusResult?.lastError || null,
          consecutiveErrors: pollingStatusResult?.consecutiveErrors || 0,
          totalPolls: pollingStatusResult?.totalPolls || 0,
          successfulPolls: pollingStatusResult?.successfulPolls || 0,
          isActive: system.status === "active",
        }
      : null,
  };

  let readings: LatestReadingRow[] | undefined;
  if (expectedPoints) {
    readings = expectedPoints
      .map((point): LatestReadingRow => {
        const logicalPath = point.getLogicalPath();
        const display = resolvePointDisplay(
          system.vendorType,
          point.subsystem,
          point.physicalPathTail,
        );
        const displayFields = display
          ? { displayUnit: display.unit, displayFormat: display.format }
          : {};
        const cached = logicalPath ? latest[logicalPath] : null;
        if (cached) {
          // Numeric → boolean when the unit says so (the readings table renders true/false).
          let displayValue: number | string | boolean | null = cached.value;
          if (
            cached.metricUnit === "boolean" &&
            typeof cached.value === "number"
          ) {
            displayValue = cached.value !== 0;
          }
          return {
            ...(displayValue != null && { value: displayValue }),
            physicalPath: point.physicalPathTail,
            logicalPath: cached.logicalPath,
            ...(cached.pointReference != null && {
              pointReference: cached.pointReference,
            }),
            ...(cached.measurementTimeMs != null && {
              measurementTimeMs: cached.measurementTimeMs,
            }),
            ...(cached.receivedTimeMs != null && {
              receivedTimeMs: cached.receivedTimeMs,
            }),
            metricUnit: cached.metricUnit,
            pointName: cached.displayName,
            ...(cached.sessionId != null && { sessionId: cached.sessionId }),
            ...(cached.sessionLabel != null && {
              sessionLabel: cached.sessionLabel,
            }),
            ...displayFields,
          };
        }
        // No cached value — expected-but-missing point.
        return {
          physicalPath: point.physicalPathTail,
          logicalPath,
          metricUnit: point.metricUnit,
          pointName: point.name,
          ...displayFields,
        };
      })
      .sort(
        (a, b) =>
          (a.pointName || "").localeCompare(b.pointName || "") ||
          (a.logicalPath || "").localeCompare(b.logicalPath || ""),
      );
  }

  return {
    system: systemData,
    latest,
    ...(readings !== undefined && { readings }),
  };
}

/**
 * SSR prefetch helper: build the single-system `/api/data` **cache value** (date-transformed to ISO
 * strings, exactly the shape `dashboardDataQuery(handle)` caches) in-process, so the dashboard server
 * component can seed a React Query `HydrationBoundary` and cards render filled without a client
 * `/api/data` round-trip (SP1.2). Returns null if the handle doesn't resolve to a viewable system.
 *
 * Access is the CALLER's responsibility: SSR callers pass only handles from areas already resolved
 * and authorized server-side (owner's readable areas / a share token's scope), so this never widens
 * the viewer's scope.
 */
export async function getSystemDataForCache(
  systemId: number,
): Promise<unknown | null> {
  const system = await SystemsManager.getInstance().getViewableSystem(systemId);
  if (!system) return null;
  const payload = await buildSystemPayload(system, false);
  return transformDates(payload, system.timezoneOffsetMin);
}
