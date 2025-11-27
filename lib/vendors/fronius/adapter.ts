import { BaseVendorAdapter } from "../base-adapter";

/**
 * Vendor adapter for Fronius systems
 * Fronius systems use push-based data collection
 * The inverter pushes data to our endpoint, we queue it, and process it here
 */
export class FroniusAdapter extends BaseVendorAdapter {
  readonly vendorType = "fronius";
  readonly displayName = "Fronius";
  readonly dataSource = "push" as const;
}
