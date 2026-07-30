/**
 * Shared function to fetch admin devices data
 * Used by both the API route and server-side rendering
 */

import { clerkClient } from "@clerk/nextjs/server";
import { specToDisplayStrings } from "@/lib/capabilities/config";
import { formatTimeAEST } from "@/lib/date-utils";
import { fromDate } from "@internationalized/date";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getLatestValues, LatestValuesMap } from "@/lib/latest-values-store";
import {
  getAllSystemSummaries,
  SystemSummary,
  SystemSummariesMap,
} from "@/lib/system-summary-store";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

export interface DeviceData {
  systemId: number;
  owner: {
    clerkId: string;
    email: string | null;
    userName: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  displayName: string;
  alias: string | null;
  vendor: {
    type: string;
    siteId: string;
    userId: string | null;
    supportsPolling?: boolean;
  };
  location?: any;
  metadata?: any;
  status: "active" | "disabled" | "removed";
  timezoneOffsetMin: number;
  deviceInfo?: {
    model?: string | null;
    serial?: string | null;
    ratings?: string | null;
    solarSize?: string | null;
    batterySize?: string | null;
  } | null;
  polling: {
    isActive: boolean;
    lastPollTime: string | null;
    lastSuccessTime: string | null;
    lastErrorTime: string | null;
    lastError: string | null;
    lastResponse: any | null;
    consecutiveErrors: number;
    totalPolls: number;
    successfulPolls: number;
    failedPolls: number;
    successRate: number;
  };
  data: {
    solarPower: number | null;
    loadPower: number | null;
    batteryPower: number | null;
    batterySOC: number | null;
    gridPower: number | null;
    timestamp: string;
  } | null;
}

export interface AdminDevicesResult {
  success: true;
  devices: DeviceData[];
  totalDevices: number;
  timestamp: string;
  latestValuesIncluded: boolean;
}

/**
 * Extract power values from KV cache latest values
 */
function extractPowerValues(latestValues: LatestValuesMap) {
  const entries = Object.values(latestValues).filter(
    (v) => v && typeof v.logicalPath === "string",
  );

  if (entries.length === 0) {
    return {
      solarPower: null,
      loadPower: null,
      batteryPower: null,
      gridPower: null,
      batterySOC: null,
      timestampMs: null,
    };
  }

  const findValue = (pathPrefix: string, metric: string) => {
    const entry = entries.find(
      (v) =>
        v.logicalPath.startsWith(pathPrefix) &&
        v.logicalPath.includes(`/${metric}`),
    );
    return (entry?.value as number) ?? null;
  };

  const getPowerWithFallback = (basePath: string) => {
    const exact = entries.find((v) => v.logicalPath === `${basePath}/power`);
    if (exact) return exact.value as number;

    const parts = entries.filter(
      (v) =>
        v.logicalPath.startsWith(`${basePath}.`) &&
        v.logicalPath.endsWith("/power"),
    );
    if (parts.length === 0) return null;
    return parts.reduce((sum, v) => sum + (v.value as number), 0);
  };

  const findTimestamp = () => {
    const first = entries[0];
    return first?.measurementTimeMs ?? null;
  };

  return {
    solarPower: getPowerWithFallback("source.solar"),
    loadPower: getPowerWithFallback("load"),
    batteryPower: findValue("bidi.battery", "power"),
    gridPower: findValue("bidi.grid", "power"),
    batterySOC: findValue("bidi.battery", "soc"),
    timestampMs: findTimestamp(),
  };
}

/**
 * Extract power values from system summary (fast path - single KV call for all devices)
 */
function extractPowerValuesFromSummary(summary: SystemSummary | null) {
  if (!summary) {
    return {
      solarPower: null,
      loadPower: null,
      batteryPower: null,
      gridPower: null,
      batterySOC: null,
      timestampMs: null,
    };
  }

  return {
    solarPower: summary.readings["source.solar/power"] ?? null,
    loadPower: summary.readings["load/power"] ?? null,
    batteryPower: null, // Not included in summaries per user request
    gridPower: summary.readings["bidi.grid/power"] ?? null,
    batterySOC: summary.readings["bidi.battery/soc"] ?? null,
    timestampMs: summary.measurementTimeMs,
  };
}

interface GetAdminDevicesOptions {
  /** Timeout for fetching latest values (ms). If exceeded, returns without latest values. Default: 100 */
  latestValuesTimeoutMs?: number;
  /** Skip fetching latest values entirely */
  skipLatestValues?: boolean;
}

/**
 * Get admin devices data - shared between API and server-side rendering
 */
export async function getAdminDevicesData(
  options: GetAdminDevicesOptions = {},
): Promise<AdminDevicesResult> {
  const { latestValuesTimeoutMs = 100, skipLatestValues = false } = options;

  // Only real (physical, polled) devices belong in the admin Devices list. Areas-backed virtual
  // devices are never in the systems table (synthesized on demand) and live on /admin/areas.
  const allDevices = await DeviceConfigRegistry.allDevices();

  // Get unique owner user IDs to fetch user info in batch
  const ownerUserIds = [
    ...new Set(
      allDevices
        .map((s) => s.ownerClerkUserId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const userCache = new Map<
    string,
    {
      email: string | null;
      userName: string | null;
      firstName: string | null;
      lastName: string | null;
    }
  >();

  // Fetch user information from Clerk (parallel calls)
  if (ownerUserIds.length > 0) {
    const clerk = await clerkClient();
    const userPromises = ownerUserIds.map(async (id) => {
      try {
        const user = await clerk.users.getUser(id);
        return {
          id: user.id,
          email: user.emailAddresses[0]?.emailAddress || null,
          userName: user.username || null,
          firstName: user.firstName || null,
          lastName: user.lastName || null,
        };
      } catch (error) {
        console.warn(`Failed to fetch user ${id}:`, error);
        return {
          id,
          email: null,
          userName: null,
          firstName: null,
          lastName: null,
        };
      }
    });
    const users = await Promise.all(userPromises);
    for (const user of users) {
      userCache.set(user.id, {
        email: user.email,
        userName: user.userName,
        firstName: user.firstName,
        lastName: user.lastName,
      });
    }
  }

  // Fetch system summaries with timeout (single KV call for all devices)
  let summariesMap: SystemSummariesMap = {};
  let latestValuesIncluded = false;

  if (!skipLatestValues) {
    try {
      const summariesPromise = getAllSystemSummaries();

      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), latestValuesTimeoutMs),
      );

      const result = await Promise.race([summariesPromise, timeoutPromise]);

      if (result !== null) {
        summariesMap = result;
        latestValuesIncluded = true;
      } else {
        console.log(
          `[getAdminSystemsData] System summaries fetch timed out after ${latestValuesTimeoutMs}ms`,
        );
      }
    } catch (error) {
      console.warn(
        "[getAdminSystemsData] Failed to fetch system summaries:",
        error,
      );
    }
  }

  // Build devices data
  const devicesData: DeviceData[] = [];

  for (const device of allDevices) {
    // config-v4 Phase 13 PR 3: the summaries hash is keyed by `dv_`/`ar_` TypeID, not the integer
    // handle. For a COLLIDING handle this is now the DEVICE's own aggregate rather than whichever of the
    // device poll / area fan-out wrote the shared integer field last — strictly better for a device list.
    const summary = summariesMap[device.deviceId] || null;
    const powerValues = extractPowerValuesFromSummary(summary);
    const pollStatus = device.pollingStatus;
    const userInfo = device.ownerClerkUserId
      ? userCache.get(device.ownerClerkUserId)
      : null;

    devicesData.push({
      systemId: device.id,
      owner: {
        clerkId: device.ownerClerkUserId || "",
        email: userInfo?.email || null,
        userName: userInfo?.userName || null,
        firstName: userInfo?.firstName || null,
        lastName: userInfo?.lastName || null,
      },
      displayName: device.displayName,
      alias: device.alias,
      vendor: {
        type: device.vendorType,
        siteId: device.vendorSiteId,
        userId: null,
        supportsPolling: VendorRegistry.supportsPolling(device.vendorType),
      },
      location: device.location,
      metadata: device.metadata,
      status: device.status as "active" | "disabled" | "removed",
      timezoneOffsetMin: device.timezoneOffsetMin,
      deviceInfo: {
        model: device.model,
        serial: device.serial,
        // config-v4 slice K2: projected from `config.spec` — no longer columns on `devices`.
        ...specToDisplayStrings(device.config?.spec),
      },
      polling: {
        isActive: device.status === "active",
        lastPollTime: pollStatus?.lastPollTime
          ? formatTimeAEST(
              fromDate(pollStatus.lastPollTime, "Australia/Brisbane"),
            )
          : null,
        lastSuccessTime: pollStatus?.lastSuccessTime
          ? formatTimeAEST(
              fromDate(pollStatus.lastSuccessTime, "Australia/Brisbane"),
            )
          : null,
        lastErrorTime: pollStatus?.lastErrorTime
          ? formatTimeAEST(
              fromDate(pollStatus.lastErrorTime, "Australia/Brisbane"),
            )
          : null,
        lastError: pollStatus?.lastError || null,
        lastResponse: pollStatus?.lastResponse || null,
        consecutiveErrors: pollStatus?.consecutiveErrors || 0,
        totalPolls: pollStatus?.totalPolls || 0,
        successfulPolls: pollStatus?.successfulPolls || 0,
        failedPolls: pollStatus?.totalPolls
          ? pollStatus.totalPolls - pollStatus.successfulPolls
          : 0,
        successRate: pollStatus?.totalPolls
          ? Math.round(
              (pollStatus.successfulPolls / pollStatus.totalPolls) * 100,
            )
          : 0,
      },
      data: powerValues.timestampMs
        ? {
            solarPower: powerValues.solarPower,
            loadPower: powerValues.loadPower,
            batteryPower: powerValues.batteryPower,
            batterySOC: powerValues.batterySOC,
            gridPower: powerValues.gridPower,
            timestamp: formatTimeAEST(
              fromDate(new Date(powerValues.timestampMs), "Australia/Brisbane"),
            ),
          }
        : null,
    });
  }

  return {
    success: true,
    devices: devicesData,
    totalDevices: devicesData.length,
    timestamp: new Date().toISOString(),
    latestValuesIncluded,
  };
}
