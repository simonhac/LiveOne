/**
 * Shared function to fetch admin systems data
 * Used by both the API route and server-side rendering
 */

import { clerkClient } from "@clerk/nextjs/server";
import { formatTimeAEST } from "@/lib/date-utils";
import { fromDate } from "@internationalized/date";
import { VendorRegistry } from "@/lib/vendors/registry";
import { SystemsManager } from "@/lib/systems-manager";
import { getLatestValues, LatestValuesMap } from "@/lib/latest-values-store";

export interface SystemData {
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
  compositeSourceSystems?: Array<{ id: number; alias: string | null }>;
  status: "active" | "disabled" | "removed";
  timezoneOffsetMin: number;
  systemInfo?: {
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

export interface AdminSystemsResult {
  success: true;
  systems: SystemData[];
  totalSystems: number;
  timestamp: string;
  latestValuesIncluded: boolean;
}

/**
 * Extract all source systems referenced in composite metadata (version 2 format)
 */
async function getCompositeSourceSystems(
  metadata: any,
): Promise<Array<{ id: number; alias: string | null }>> {
  if (!metadata || typeof metadata !== "object") return [];
  if (metadata.version !== 2 || !metadata.mappings) return [];

  const systemsMap = new Map<number, { id: number; alias: string | null }>();
  const systemsManager = SystemsManager.getInstance();

  for (const [, pointRefs] of Object.entries(metadata.mappings)) {
    if (Array.isArray(pointRefs)) {
      for (const pointRef of pointRefs as string[]) {
        const [systemIdStr] = pointRef.split(".");
        const systemId = parseInt(systemIdStr);

        if (!isNaN(systemId) && !systemsMap.has(systemId)) {
          const system = await systemsManager.getSystem(systemId);
          if (system) {
            systemsMap.set(systemId, {
              id: system.id,
              alias: system.alias,
            });
          }
        }
      }
    }
  }

  return Array.from(systemsMap.values()).sort((a, b) => a.id - b.id);
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

interface GetAdminSystemsOptions {
  /** Timeout for fetching latest values (ms). If exceeded, returns without latest values. Default: 100 */
  latestValuesTimeoutMs?: number;
  /** Skip fetching latest values entirely */
  skipLatestValues?: boolean;
}

/**
 * Get admin systems data - shared between API and server-side rendering
 */
export async function getAdminSystemsData(
  options: GetAdminSystemsOptions = {},
): Promise<AdminSystemsResult> {
  const { latestValuesTimeoutMs = 100, skipLatestValues = false } = options;

  const systemsManager = SystemsManager.getInstance();
  const allSystems = await systemsManager.getAllSystems();

  // Get unique owner user IDs to fetch user info in batch
  const ownerUserIds = [
    ...new Set(
      allSystems
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

  // Fetch latest values with timeout (parallel for all systems)
  let latestValuesMap = new Map<number, LatestValuesMap>();
  let latestValuesIncluded = false;

  if (!skipLatestValues) {
    try {
      const latestValuesPromise = Promise.all(
        allSystems.map(async (system) => ({
          systemId: system.id,
          values: await getLatestValues(system.id),
        })),
      );

      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), latestValuesTimeoutMs),
      );

      const result = await Promise.race([latestValuesPromise, timeoutPromise]);

      if (result !== null) {
        for (const { systemId, values } of result) {
          latestValuesMap.set(systemId, values);
        }
        latestValuesIncluded = true;
      } else {
        console.log(
          `[getAdminSystemsData] Latest values fetch timed out after ${latestValuesTimeoutMs}ms`,
        );
      }
    } catch (error) {
      console.warn(
        "[getAdminSystemsData] Failed to fetch latest values:",
        error,
      );
    }
  }

  // Build systems data
  const systemsData: SystemData[] = [];

  for (const system of allSystems) {
    const latestValues = latestValuesMap.get(system.id) || {};
    const powerValues = extractPowerValues(latestValues);
    const pollStatus = system.pollingStatus;
    const userInfo = system.ownerClerkUserId
      ? userCache.get(system.ownerClerkUserId)
      : null;

    const compositeSourceSystems =
      system.vendorType === "composite"
        ? await getCompositeSourceSystems(system.metadata)
        : undefined;

    systemsData.push({
      systemId: system.id,
      owner: {
        clerkId: system.ownerClerkUserId || "",
        email: userInfo?.email || null,
        userName: userInfo?.userName || null,
        firstName: userInfo?.firstName || null,
        lastName: userInfo?.lastName || null,
      },
      displayName: system.displayName,
      alias: system.alias,
      vendor: {
        type: system.vendorType,
        siteId: system.vendorSiteId,
        userId: null,
        supportsPolling: VendorRegistry.supportsPolling(system.vendorType),
      },
      location: system.location,
      metadata: system.metadata,
      compositeSourceSystems,
      status: system.status as "active" | "disabled" | "removed",
      timezoneOffsetMin: system.timezoneOffsetMin,
      systemInfo: {
        model: system.model,
        serial: system.serial,
        ratings: system.ratings,
        solarSize: system.solarSize,
        batterySize: system.batterySize,
      },
      polling: {
        isActive: system.status === "active",
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
    systems: systemsData,
    totalSystems: systemsData.length,
    timestamp: new Date().toISOString(),
    latestValuesIncluded,
  };
}
