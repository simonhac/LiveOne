import { getPollingStatus } from "@/lib/polling-utils";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getLatestValues } from "@/lib/latest-values-store";
import { transformDates } from "@/lib/json";
import { PointManager } from "@/lib/point/point-manager";
import { resolvePointDisplay } from "@/lib/point/display/registry";
import { specToDisplayStrings } from "@/lib/capabilities/config";
import type { ServerTimer } from "@/lib/server-timing";
import {
  subjectForHandle,
  subjectStatus,
  subjectTimezoneOffsetMin,
  type ServingSubject,
} from "@/lib/dashboard/subject";
import type { AreaId, DeviceId } from "@/lib/ids";
import type { DeviceConfig } from "@/lib/capabilities/config";

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
  sourceSystemId?: number;
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

/** Formatted polling status, or null when the subject has no `device_state` row (every Area). */
type PollingStatusBlock = {
  lastPollTime: string | null;
  lastSuccessTime: string | null;
  lastErrorTime: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  totalPolls: number;
  successfulPolls: number;
  isActive: boolean;
} | null;

/** Fields common to both legs of the discriminated payload. */
interface SubjectBlockCommon {
  /** The permanent integer addressing handle (the `?systemId=` alias). */
  id: number;
  displayName: string;
  alias: string | null;
  displayTimezone: string | null;
  ownerClerkUserId: string | null;
  timezoneOffsetMin: number;
  status: string;
  location: unknown;
  createdAt: Date;
  updatedAt: Date;
  supportsPolling: boolean;
  pollingStatus: PollingStatusBlock;
}

export interface DeviceBlock extends SubjectBlockCommon {
  deviceId: DeviceId;
  vendorType: string;
  vendorSiteId: string;
  model: string | null;
  serial: string | null;
  ratings: string | null;
  solarSize: string | null;
  batterySize: string | null;
  metadata: unknown;
  config: DeviceConfig | null;
}

/**
 * An Area served AS an area. Note what is ABSENT versus {@link DeviceBlock}: `vendorType`,
 * `vendorSiteId`, `model`, `serial`, `metadata`, `config`, `ratings`, `solarSize`, `batterySize`. Those
 * were the whole of `synthesizeAreaView`'s fabrication — two sentinels (`"area"`, `"area:{handle}"`) and
 * seven nulls. An Area has no vendor connection and no hardware, so it has nothing to say about any of
 * them.
 */
export interface AreaBlock extends SubjectBlockCommon {
  areaId: AreaId;
}

/**
 * The raw (untransformed) payload for one serving subject — shared by the `/api/data` single-subject
 * and batch paths AND by the dashboard SSR prefetch. Callers transform dates
 * (`jsonResponse`/`transformDates`) before returning/caching.
 *
 * config-v4 Phase 13 PR 1: the payload is now DISCRIMINATED — `{device, latest}` for a real device,
 * `{area, latest}` for an Area served as an Area. Previously an Area was served as `{system, latest}`
 * built from `synthesizeAreaView`, whose only invented fields were `vendorType:"area"`,
 * `vendorSiteId:"area:{handle}"` and null `model`/`serial`/`metadata`/`config`; every other field was
 * already a real `areas` column, so the area branch reads that row directly and simply DOES NOT EMIT
 * the filler. `pollingStatus` resolves to null on its own (`getPollingStatus` is a
 * `devices ⋈ device_state` join that misses for a pure area) and `commissionedOn` was never on the
 * wire — neither needed special-casing, both were verified against the pre-change payloads for
 * handles 7 / 8 / 1000001 / 1000002.
 *
 * 🛑 The INTERIOR is still integer-handle-keyed: the KV latest cache (PR 3), the active-points list and
 * polling status all take `subject.handle` exactly as they took `system.id`.
 */
export async function buildDevicePayload(
  subject: ServingSubject,
  wantsReadings: boolean,
  timer?: ServerTimer,
) {
  const handle = subject.handle;
  // Polling status, the KV latest-values cache, and (if requested) the active-points list are
  // mutually independent reads — fire them concurrently rather than paying each round-trip in
  // sequence. The optional timer spans them individually (they overlap; that's the point) —
  // `kv` is the Vercel KV REST round trip, a prime latency suspect.
  const [pollingStatusResult, latest, expectedPoints] = await Promise.all([
    timer
      ? timer.time("polling", () => getPollingStatus(handle))
      : getPollingStatus(handle),
    timer
      ? timer.time("kv", () => getLatestValues(handle))
      : getLatestValues(handle),
    wantsReadings
      ? PointManager.getInstance().getActivePointsForDevice(handle)
      : Promise.resolve(undefined),
  ]);

  const tz = subjectTimezoneOffsetMin(subject);
  const pollingStatus = pollingStatusResult
    ? {
        lastPollTime: pollingStatusResult.lastPollTime
          ? formatTime_fromJSDate(pollingStatusResult.lastPollTime, tz)
          : null,
        lastSuccessTime: pollingStatusResult.lastSuccessTime
          ? formatTime_fromJSDate(pollingStatusResult.lastSuccessTime, tz)
          : null,
        lastErrorTime: pollingStatusResult.lastErrorTime
          ? formatTime_fromJSDate(pollingStatusResult.lastErrorTime, tz)
          : null,
        lastError: pollingStatusResult.lastError || null,
        consecutiveErrors: pollingStatusResult.consecutiveErrors || 0,
        totalPolls: pollingStatusResult.totalPolls || 0,
        successfulPolls: pollingStatusResult.successfulPolls || 0,
        isActive: subjectStatus(subject) === "active",
      }
    : null;

  // The discriminated subject block. `id` (the integer handle) stays on BOTH legs — it is the
  // permanent `?systemId=` alias and every client-side card still threads it inward.
  let subjectBlock: { device: DeviceBlock } | { area: AreaBlock };
  if (subject.kind === "device") {
    const device = subject.device;
    // config-v4 slice K2: `ratings`/`solarSize`/`batterySize` are no longer COLUMNS — `devices` has no
    // counterpart and `config.spec` is the source. They stay on the wire as a display projection
    // because four components render them verbatim; retired with those components in Phase 14.
    const spec = specToDisplayStrings(device.config?.spec);
    subjectBlock = {
      device: {
        id: device.id,
        deviceId: subject.deviceId,
        vendorType: device.vendorType,
        vendorSiteId: device.vendorSiteId,
        displayName: device.displayName,
        alias: device.alias,
        displayTimezone: device.displayTimezone,
        ownerClerkUserId: device.ownerClerkUserId,
        timezoneOffsetMin: device.timezoneOffsetMin,
        status: device.status,
        model: device.model,
        serial: device.serial,
        ratings: spec.ratings,
        solarSize: spec.solarSize,
        batterySize: spec.batterySize,
        location: device.location,
        metadata: device.metadata,
        config: device.config,
        createdAt: device.createdAt,
        updatedAt: device.updatedAt,
        supportsPolling: VendorRegistry.supportsPolling(device.vendorType),
        pollingStatus,
      },
    };
  } else {
    const area = subject.area;
    subjectBlock = {
      area: {
        id: subject.handle,
        areaId: subject.areaId,
        displayName: area.name,
        alias: area.slug,
        displayTimezone: area.displayTimezone,
        ownerClerkUserId: area.ownerUserId,
        timezoneOffsetMin: area.timezoneOffsetMin,
        status: area.status,
        location: area.location,
        createdAt: area.createdAt,
        updatedAt: area.updatedAt,
        // An Area owns no vendor connection, so it never polls. Both were already null/false on the
        // synthesized view — they are kept because they are TRUE of an area, not filler.
        supportsPolling: false,
        pollingStatus,
      },
    };
  }

  // The display registry is keyed by DEVICE type; an Area has none, and the synthesized view fed it the
  // `"area"` sentinel (which no registry covers, so an area's readings carried no display hints). Kept
  // verbatim — the per-member resolution an area really wants is a pre-existing gap, not this PR's.
  const displayVendorType =
    subject.kind === "device" ? subject.device.vendorType : "area";

  let readings: LatestReadingRow[] | undefined;
  if (expectedPoints) {
    readings = expectedPoints
      .map((point): LatestReadingRow => {
        const logicalPath = point.getLogicalPath();
        const display = resolvePointDisplay(
          displayVendorType,
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
            ...(cached.sourceSystemId != null && {
              sourceSystemId: cached.sourceSystemId,
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
    ...subjectBlock,
    latest,
    ...(readings !== undefined && { readings }),
  };
}

/**
 * SSR prefetch helper: build the single-device `/api/data` **cache value** (date-transformed to ISO
 * strings, exactly the shape `dashboardDataQuery(handle)` caches) in-process, so the dashboard server
 * component can seed a React Query `HydrationBoundary` and cards render filled without a client
 * `/api/data` round-trip (SP1.2). Returns null if the handle doesn't resolve to a subject.
 *
 * Access is the CALLER's responsibility: SSR callers pass only handles from areas already resolved
 * and authorized server-side (owner's readable areas / a share token's scope), so this never widens
 * the viewer's scope.
 *
 * 🛑 Device-first, matching the `?systemId=` alias the client seeds this cache entry under
 * (`queryKeys.data(handle)`). A different precedence here would seed a DIFFERENT payload shape under
 * the key the client then reads — silent cache poisoning, not a compile error.
 */
export async function getDeviceDataForCache(
  systemId: number,
): Promise<unknown | null> {
  const subject = await subjectForHandle(systemId, "device");
  if (!subject) return null;
  const payload = await buildDevicePayload(subject, false);
  return transformDates(payload, subjectTimezoneOffsetMin(subject));
}
