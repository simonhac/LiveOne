import { BaseVendorAdapter } from "../base-adapter";
import type { PollingResult, TestConnectionResult } from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { LatestReadingData } from "@/lib/types/readings";
import { VendorRegistry } from "@/lib/vendors/registry";

/**
 * Composite system metadata
 *
 * Example 1 - CraigHack:
 * {
 *   "base_system": 2,      // Selectronic for battery, load, grid
 *   "overrides": {
 *     "solar": 3           // Enphase for solar
 *   }
 * }
 *
 * Example 2 - Kinkora:
 * {
 *   "base_system": 10,     // Mondo for everything
 *   "overrides": {
 *     "battery_soc": 7     // Fronius for SOC only
 *   }
 * }
 */
interface CompositeMetadata {
  base_system: number | null;
  overrides?: {
    solar?: number;
    battery?: number;
    battery_soc?: number;
    load?: number;
    grid?: number;
  };
}

/**
 * Vendor adapter for Composite systems
 * Composite systems don't poll - they combine data from other systems
 */
export class CompositeAdapter extends BaseVendorAdapter {
  readonly vendorType = "composite";
  readonly displayName = "Composite System";
  readonly dataSource = "push" as const;

  /**
   * Determine which system to pull each metric from
   */
  private getSourceForMetric(
    metric: string,
    metadata: CompositeMetadata,
  ): number | null {
    // Check for override first
    if (metadata.overrides && metric in metadata.overrides) {
      return (metadata.overrides as any)[metric] ?? null;
    }

    // Fall back to base system
    return metadata.base_system ?? null;
  }

  /**
   * Override getLastReading to combine data from multiple systems
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    try {
      // Get the composite system to read its metadata
      const { SystemsManager } = await import("@/lib/systems-manager");
      const systemsManager = SystemsManager.getInstance();
      const system = await systemsManager.getSystem(systemId);

      if (!system) {
        console.error("[Composite] System not found:", systemId);
        return null;
      }

      const metadata = system.metadata as CompositeMetadata;

      if (!metadata.base_system && !metadata.overrides) {
        console.error(
          "[Composite] Invalid metadata - must have base_system or overrides",
        );
        return null;
      }

      // Determine source systems for each metric
      const sources = {
        solar: this.getSourceForMetric("solar", metadata),
        battery: this.getSourceForMetric("battery", metadata),
        battery_soc: this.getSourceForMetric("battery_soc", metadata),
        load: this.getSourceForMetric("load", metadata),
        grid: this.getSourceForMetric("grid", metadata),
      };

      console.log("[Composite] Source mapping:", sources);

      // Fetch data from each unique source system
      const fetchedData = new Map<number, LatestReadingData>();
      const uniqueSources = new Set(
        Object.values(sources).filter((s) => s !== null) as number[],
      );

      for (const sourceSystemId of uniqueSources) {
        const adapter =
          await VendorRegistry.getAdapterForSystem(sourceSystemId);
        if (!adapter) {
          console.error(
            `[Composite] Could not get adapter for system ${sourceSystemId}`,
          );
          continue;
        }

        const data = await adapter.getLastReading(sourceSystemId);
        if (data) {
          fetchedData.set(sourceSystemId, data);
        } else {
          console.warn(
            `[Composite] No data available from system ${sourceSystemId}`,
          );
        }
      }

      if (fetchedData.size === 0) {
        console.error("[Composite] No data available from any source system");
        return null;
      }

      // Use the most recent timestamp from fetched data
      let timestamp = new Date(0);
      let receivedTime = new Date(0);

      for (const data of fetchedData.values()) {
        if (data.timestamp > timestamp) {
          timestamp = data.timestamp;
        }
        if (data.receivedTime > receivedTime) {
          receivedTime = data.receivedTime;
        }
      }

      // Helper to get value from source
      const getValue = <T>(
        sourceId: number | null,
        getter: (data: LatestReadingData) => T | null,
      ): T | null => {
        if (sourceId === null) return null;
        const data = fetchedData.get(sourceId);
        return data ? getter(data) : null;
      };

      // Get solar data (includes powerW, localW, remoteW)
      const solarData =
        sources.solar !== null ? fetchedData.get(sources.solar) : null;
      const batteryData =
        sources.battery !== null ? fetchedData.get(sources.battery) : null;
      const batterySOCData =
        sources.battery_soc !== null
          ? fetchedData.get(sources.battery_soc)
          : null;
      const loadData =
        sources.load !== null ? fetchedData.get(sources.load) : null;
      const gridData =
        sources.grid !== null ? fetchedData.get(sources.grid) : null;

      // Build combined data
      const combinedData: LatestReadingData = {
        timestamp,
        receivedTime,

        solar: {
          powerW: solarData?.solar.powerW ?? null,
          localW: solarData?.solar.localW ?? null,
          remoteW: solarData?.solar.remoteW ?? null,
        },

        battery: {
          powerW: batteryData?.battery.powerW ?? null,
          soc: batterySOCData?.battery.soc ?? null,
        },

        load: {
          powerW: loadData?.load.powerW ?? null,
        },

        grid: {
          powerW: gridData?.grid.powerW ?? null,
          generatorStatus: gridData?.grid.generatorStatus ?? null,
        },

        connection: {
          faultCode: batteryData?.connection.faultCode ?? null,
          faultTimestamp: batteryData?.connection.faultTimestamp ?? null,
        },
      };

      console.log(
        "[Composite] Combined data -",
        "Solar:",
        combinedData.solar.powerW,
        "W (from system",
        sources.solar,
        ")",
        "Battery:",
        combinedData.battery.powerW,
        "W (from system",
        sources.battery,
        ")",
        "SOC:",
        combinedData.battery.soc?.toFixed(1) ?? "N/A",
        "% (from system",
        sources.battery_soc,
        ")",
        "Load:",
        combinedData.load.powerW,
        "W (from system",
        sources.load,
        ")",
        "Grid:",
        combinedData.grid.powerW,
        "W (from system",
        sources.grid,
        ")",
      );

      return combinedData;
    } catch (error) {
      console.error("[Composite] Error fetching combined data:", error);
      return null;
    }
  }
}
