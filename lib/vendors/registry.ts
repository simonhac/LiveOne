import type { VendorAdapter } from "./types";
import { SelectronicAdapter } from "./selectronic/adapter";
import { EnphaseAdapter } from "./enphase/adapter";
import { FusherAdapter } from "./fusher/adapter";
import { MondoAdapter } from "./mondo/adapter";
import { AmberAdapter } from "./amber/adapter";
import { CompositeAdapter } from "./composite/adapter";
import { SystemsManager } from "@/lib/systems-manager";

/**
 * Registry for all vendor adapters
 * Provides a central place to get the appropriate adapter for a vendor type
 */
export class VendorRegistry {
  private static adapters = new Map<string, VendorAdapter>();
  private static initialized = false;

  /**
   * Initialize the registry with all available adapters
   */
  private static initialize() {
    if (this.initialized) return;

    // Register all adapters
    this.adapters.set("selectronic", new SelectronicAdapter());

    this.adapters.set("enphase", new EnphaseAdapter());
    this.adapters.set("fusher", new FusherAdapter());
    this.adapters.set("mondo", new MondoAdapter());
    this.adapters.set("amber", new AmberAdapter());
    this.adapters.set("composite", new CompositeAdapter());

    this.initialized = true;

    console.log(
      "[VendorRegistry] Initialized with adapters:",
      Array.from(this.adapters.keys()).join(", "),
    );
  }

  /**
   * Get an adapter for a specific vendor type
   */
  static getAdapter(vendorType: string): VendorAdapter | null {
    this.initialize();
    return this.adapters.get(vendorType.toLowerCase()) || null;
  }

  /**
   * Get all registered vendor types
   */
  static getVendorTypes(): string[] {
    this.initialize();
    return Array.from(this.adapters.keys());
  }

  /**
   * Check if a vendor type is supported
   */
  static isSupported(vendorType: string): boolean {
    this.initialize();
    return this.adapters.has(vendorType.toLowerCase());
  }

  /**
   * Register a custom adapter (useful for testing or extensions)
   */
  static registerAdapter(vendorType: string, adapter: VendorAdapter) {
    this.initialize();
    this.adapters.set(vendorType.toLowerCase(), adapter);
    console.log(`[VendorRegistry] Registered adapter for ${vendorType}`);
  }

  /**
   * Get all registered adapters
   */
  static getAllAdapters(): VendorAdapter[] {
    this.initialize();
    // Return unique adapters (avoid duplicates from aliases)
    const uniqueAdapters = new Map<VendorAdapter, boolean>();
    for (const adapter of this.adapters.values()) {
      uniqueAdapters.set(adapter, true);
    }
    return Array.from(uniqueAdapters.keys());
  }

  /**
   * Check if a vendor type supports polling (for Test Connection feature)
   * @param vendorType The vendor type to check
   * @returns true if the vendor supports polling, false if push-only
   */
  static supportsPolling(vendorType: string): boolean {
    this.initialize();
    const adapter = this.adapters.get(vendorType.toLowerCase());
    if (!adapter) return false;
    return adapter.dataSource === "poll" || adapter.dataSource === "combined";
  }

  /**
   * Get an adapter for a specific system by its ID
   * Uses SystemsManager to look up the system's vendor type
   */
  static async getAdapterForSystem(
    systemId: number,
  ): Promise<VendorAdapter | null> {
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);

    if (!system) {
      console.error(`[VendorRegistry] System ${systemId} not found`);
      return null;
    }

    const adapter = this.getAdapter(system.vendorType);
    if (!adapter) {
      console.error(
        `[VendorRegistry] No adapter found for vendor type: ${system.vendorType}`,
      );
      return null;
    }

    return adapter;
  }
}
