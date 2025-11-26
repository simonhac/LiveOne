import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { formatTimeAEST } from "@/lib/date-utils";
import { isUserAdmin } from "@/lib/auth-utils";
import { fromDate } from "@internationalized/date";
import { VendorRegistry } from "@/lib/vendors/registry";
import { SystemsManager } from "@/lib/systems-manager";
import { getLatestValues, LatestValuesMap } from "@/lib/latest-values-store";

/**
 * Extract all source systems referenced in composite metadata (version 2 format)
 * Returns array of systems with ID and alias
 */
async function getCompositeSourceSystems(
  metadata: any,
): Promise<Array<{ id: number; alias: string | null }>> {
  if (!metadata || typeof metadata !== "object") return [];

  // Only handle version 2 format with mappings
  if (metadata.version !== 2 || !metadata.mappings) return [];

  const systemsMap = new Map<number, { id: number; alias: string | null }>();

  const systemsManager = SystemsManager.getInstance();

  // Iterate through all categories in mappings
  for (const [category, pointRefs] of Object.entries(metadata.mappings)) {
    if (Array.isArray(pointRefs)) {
      for (const pointRef of pointRefs as string[]) {
        // Version 2 format: point references are "systemId.pointId" (e.g., "1.5", "2.3")
        const [systemIdStr] = pointRef.split(".");
        const systemId = parseInt(systemIdStr);

        if (!isNaN(systemId) && !systemsMap.has(systemId)) {
          // Fetch the system
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
 * For solar and load: prefer exact path, otherwise sum subpaths
 */
function extractPowerValues(latestValues: LatestValuesMap) {
  // Filter out any entries without valid logicalPath
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

  // Helper: prefer exact path, otherwise sum subpaths
  const getPowerWithFallback = (basePath: string) => {
    const exact = entries.find((v) => v.logicalPath === `${basePath}/power`);
    if (exact) return exact.value as number;

    // Sum all basePath.*/power values
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

export async function GET(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin
    const isAdmin = await isUserAdmin();

    if (!isAdmin) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    }

    // Get all systems with polling status from cache (already JOINed)
    const systemsManager = SystemsManager.getInstance();
    const allSystems = await systemsManager.getAllSystems();
    const systemsData = [];

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

    for (const system of allSystems) {
      // Get latest values from KV cache (fast)
      const latestValuesMap = await getLatestValues(system.id);
      const powerValues = extractPowerValues(latestValuesMap);

      // Polling status is already included from SystemsManager
      const pollStatus = system.pollingStatus;

      // Get user info from cache
      const userInfo = system.ownerClerkUserId
        ? userCache.get(system.ownerClerkUserId)
        : null;

      // Extract composite source systems if this is a composite system
      const compositeSourceSystems =
        system.vendorType === "composite"
          ? await getCompositeSourceSystems(system.metadata)
          : undefined;

      systemsData.push({
        systemId: system.id, // Our internal ID
        owner: {
          clerkId: system.ownerClerkUserId || "",
          email: userInfo?.email || null,
          userName: userInfo?.userName || null,
          firstName: userInfo?.firstName || null,
          lastName: userInfo?.lastName || null,
        },
        displayName: system.displayName, // Non-null from database
        alias: system.alias, // Optional short name for history API IDs
        vendor: {
          type: system.vendorType,
          siteId: system.vendorSiteId, // Vendor's identifier
          userId: null, // Don't fetch credentials to reduce API calls
          supportsPolling: VendorRegistry.supportsPolling(system.vendorType),
        },
        location: system.location, // Location data (address, city/state/country, or lat/lon)
        metadata: system.metadata, // Vendor-specific metadata (e.g., composite system configuration)
        compositeSourceSystems, // Only present for composite systems
        status: system.status, // System status: active, disabled, or removed
        timezoneOffsetMin: system.timezoneOffsetMin, // Timezone offset in minutes
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
                fromDate(
                  new Date(powerValues.timestampMs),
                  "Australia/Brisbane",
                ),
              ),
            }
          : null,
      });
    }

    return NextResponse.json({
      success: true,
      systems: systemsData,
      totalSystems: systemsData.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching systems data:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch systems data",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
