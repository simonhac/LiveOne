import { BaseVendorAdapter } from "../base-adapter";

/**
 * No-op adapter for HELPER devices — derived, non-physical devices that live in an Area and own the
 * Area's COMPUTED points (the battery-provenance blend is the first tenant). A helper is never polled,
 * has no credentials, and is not addable via the Add-Device flow. This adapter exists only so the vendor
 * registry recognizes `vendor_type='helper'`; the minutely poll loop then skips the device via
 * `dataSource==='push'` (cf. lib/vendors/deepsea/adapter.ts). Its points are produced by a recompute
 * (lib/db/planetscale/battery-provenance-pg.ts), like HWS/run-tracking derived points.
 */
export class HelperAdapter extends BaseVendorAdapter {
  readonly vendorType = "helper";
  readonly displayName = "Helper (derived)";
  readonly dataSource = "push" as const;
  readonly supportsAddDevice = false;
}
