import { BaseVendorAdapter } from "../base-adapter";

/**
 * Vendor adapter for Fusher (Fronius Pusher) systems
 * Fusher systems use push-based data collection
 * The inverter pushes data to our endpoint, we queue it, and process it here
 */
export class FusherAdapter extends BaseVendorAdapter {
  readonly vendorType = "fusher";
  readonly displayName = "Fronius Pusher";
  readonly dataSource = "push" as const;
}
