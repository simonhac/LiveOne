import { BaseVendorAdapter } from "../base-adapter";

/**
 * Vendor adapter for DeepSea (DSE7410) generator controllers.
 *
 * DeepSea is a push-based vendor: the controller is Modbus TCP on a LAN and is not reachable
 * from the cloud, so a local reader ("musher") reads it and POSTs self-describing readings to the
 * generic /api/gush (gusher) endpoint. There is no poll path (cf. lib/vendors/fusher/adapter.ts).
 */
export class DeepSeaAdapter extends BaseVendorAdapter {
  readonly vendorType = "deepsea";
  readonly displayName = "DeepSea";
  readonly dataSource = "push" as const;
}
