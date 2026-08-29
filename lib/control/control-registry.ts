/**
 * Central point CONTROL registry — which pushed points are writable, decided SERVER-SIDE.
 *
 * Mirrors `lib/point/display/registry.ts` in shape: a point resolves by
 * `${vendorType}:${subsystem}` → the device manifest, then `physicalPathTail` → its descriptor.
 *
 * 🛑 WHY THIS IS NOT PART OF THE PUSH PROTOCOL. `/api/gush` is deliberately self-describing — a
 * pusher declares its own points' metadata and the route needs no per-vendor knowledge. Control is
 * the one exception, and must stay one: a `gk_` gusher key is a DEVICE credential, so if a pusher
 * could declare `control` on a reading, anyone holding that key (or any bug in the collector)
 * could mint a writable point and widen the command surface. Writability is an authorization
 * decision, so it is made here, in code, reviewed like code — never asserted by the device.
 *
 * Poll vendors declare the same thing in their own point metadata (see
 * `lib/vendors/tesla/point-metadata.ts`); this registry is the equivalent seam for push vendors.
 */

import type { PointControl } from "@/lib/db/planetscale/schema";

type DeviceControlManifest = Record<string, PointControl>;

/** key = `${vendorType}:${subsystem}` (subsystem = device type) */
const MANIFESTS: Record<string, DeviceControlManifest> = {
  "deepsea:generator": {
    /**
     * The generator run request, in MINUTES: set it to run for that long, set 0 to stop. Reads
     * back as minutes remaining, so the control and its value share one unit.
     *
     * `max` is a UI/plausibility bound, NOT the safety bound — the hub's own `maxRuntimeSec`
     * (currently 120 min) is enforced where the latch is actually held, and the two are
     * deliberately independent. `step: 5` keeps a slider from producing 37-minute runs.
     */
    generator_run_request_min: { kind: "number", min: 0, max: 120, step: 5 },
  },
};

/**
 * The control descriptor for a pushed point, or null when it is not writable — which is the case
 * for every point but the handful listed above.
 */
export function resolvePointControl(
  vendorType: string | null | undefined,
  subsystem: string | null | undefined,
  physicalPathTail: string,
): PointControl | null {
  if (!vendorType || !subsystem) return null;
  const manifest = MANIFESTS[`${vendorType.toLowerCase()}:${subsystem}`];
  return manifest?.[physicalPathTail] ?? null;
}
