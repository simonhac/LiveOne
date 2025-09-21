import type { VendorAdapter } from './types';
import { SelectronicAdapter } from './selectronic/adapter';
import { EnphaseAdapter } from './enphase/adapter';
import { CraigHackAdapter } from './craighack/adapter';
import { FroniusAdapter } from './fronius/adapter';

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
    const selectronic = new SelectronicAdapter();
    this.adapters.set('selectronic', selectronic);
    this.adapters.set('select.live', selectronic); // Alias for backward compatibility
    
    this.adapters.set('enphase', new EnphaseAdapter());
    this.adapters.set('craighack', new CraigHackAdapter());
    this.adapters.set('fronius', new FroniusAdapter());
    
    this.initialized = true;
    
    console.log('[VendorRegistry] Initialized with adapters:', 
      Array.from(this.adapters.keys()).join(', '));
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
}