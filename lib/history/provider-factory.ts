import { SystemWithPolling } from "@/lib/systems-manager";
import { VendorRegistry } from "@/lib/vendors/registry";
import { HistoryDataProvider } from "./types";
import { ReadingsProvider } from "./readings-provider";
import { PointReadingsProvider } from "./point-readings-provider";

export class HistoryProviderFactory {
  private static readingsProvider = new ReadingsProvider();
  private static pointReadingsProvider = new PointReadingsProvider();

  /**
   * Get the appropriate history data provider for a system based on its vendor's data store
   * @param system - The system to get the provider for
   * @param forceToPointReadings - If true, forces use of PointReadingsProvider regardless of vendor (for migration testing)
   */
  static getProvider(
    system: SystemWithPolling,
    forceToPointReadings = false,
  ): HistoryDataProvider {
    // If force override is specified, use point readings provider
    if (forceToPointReadings) {
      return this.pointReadingsProvider;
    }

    // Get the vendor adapter to determine data store
    const adapter = VendorRegistry.getAdapter(system.vendorType);

    if (!adapter) {
      throw new Error(
        `No vendor adapter found for system ${system.id} (vendor: ${system.vendorType})`,
      );
    }

    // Select provider based on the vendor's data store
    switch (adapter.dataStore) {
      case "point_readings":
        return this.pointReadingsProvider;

      case "readings":
        return this.readingsProvider;

      default:
        throw new Error(
          `Unknown data store type: ${adapter.dataStore} for vendor ${system.vendorType}`,
        );
    }
  }
}
