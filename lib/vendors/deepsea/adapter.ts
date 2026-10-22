import { BaseVendorAdapter } from "../base-adapter";
import { DeepSeaControlCapability } from "./control";

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

  /**
   * Opts the generator into the device-health monitor (`isMonitored`): four missed 5-minute idle
   * pushes. Meaningful only because gusher counts a control-plane-only batch — the hub reporting on
   * itself while the controller does not answer — as a FAILED read; see lib/push/control-plane.ts.
   */
  override readonly staleBudgetMinutes = 20;

  /**
   * Commands the generator's run-request point by forwarding to the usher hub, which holds the
   * DSE's start latch and owns the run deadline. Present only because one deepsea point is
   * writable (see lib/control/control-registry.ts); the poll/push path is untouched by it.
   */
  readonly control = new DeepSeaControlCapability();
}
