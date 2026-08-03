/**
 * Freshness after a command.
 *
 * 🛑 The web tier is NOT allowed to write KV — the engine is the sole KV writer
 * (docs/architecture/engine-web-separation.md). So a command does not "optimistically update"
 * the latest map; it triggers a targeted re-poll of the one device and lets the real ingest
 * path publish the new state. This is the same thing `?systemId=N&force=true` on the minutely
 * cron does (what the Poll Now modal uses), just in-process.
 *
 * Cost: one extra vendor read per confirmed command (~$0.002 on Fleet). Priced and approved.
 */
import { after } from "next/server";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import { formatSessionId, getNextSessionId } from "@/lib/session-id";
import { VendorRegistry } from "@/lib/vendors/registry";

/**
 * Poll one device now. Best-effort: catches and logs everything, never throws — a failed
 * confirmation read must never turn a successful command into an error.
 */
export async function repollDevice(device: DeviceConfigView): Promise<void> {
  try {
    const adapter = VendorRegistry.getAdapter(device.vendorType);
    if (!adapter || adapter.dataSource === "push") return;
    if (!device.ownerClerkUserId) return;

    const credentials = await getDeviceCredentials(
      device.ownerClerkUserId,
      device.id,
    );
    if (!credentials) return;

    await adapter.poll(device, credentials, {
      forcePollAll: true,
      pollReason: "COMMAND-CONFIRM",
      sessionLabel: formatSessionId(getNextSessionId(), 1),
      sessionCause: "USER",
    });
  } catch (error) {
    console.error(
      `[control] confirmation re-poll failed for system ${device.id}:`,
      error,
    );
  }
}

/**
 * Run {@link repollDevice} AFTER the response has been sent.
 *
 * `after()` (stable since Next 15) is required rather than a floating promise: on Vercel the
 * function is frozen the moment the response returns, so a detached promise would simply be
 * killed mid-poll. `after()` throws outside a request scope, hence the fallback — the
 * evaluator/scripts/tests call this with no request around them.
 */
export function scheduleRepoll(device: DeviceConfigView): void {
  try {
    after(() => repollDevice(device));
  } catch {
    // No request scope (unit tests, scripts, non-request callers) — fire and forget.
    void repollDevice(device);
  }
}
