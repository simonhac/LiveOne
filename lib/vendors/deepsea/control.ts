/**
 * DeepSea's `ControlCapability` — the one place a point action becomes a generator run request.
 *
 * Mirrors `lib/vendors/tesla/control.ts` deliberately: resolve (logical address, action) to a
 * dispatch, call the vendor path, return benign declines rather than throwing them. The vendor
 * "path" here is the usher hub (see ./hub-client.ts), which owns the run deadline.
 *
 * 🛑 THE UNIT SEAM LIVES HERE, AND ONLY HERE. The point is in MINUTES (what a human sets and
 * reads back); the hub speaks SECONDS. One multiply, in one function, with a test — because a
 * silent factor-of-60 on a command that runs a diesel engine is the kind of bug that reads as
 * "it stopped after 30 seconds" or, far worse, "it ran for 30 hours".
 *
 * 🛑 The passkey is ALWAYS the DEVICE OWNER's, resolved from their Clerk credentials — never a
 * session user's and never an env var. Same rule as Tesla (lib/control/ownership.ts): an admin
 * commanding someone else's hardware does so on the owner's credentials, an automation with no
 * session user resolves them from the device alone, and an OWNERLESS device is commandable by
 * nobody. An env var would make the credential a property of the deployment instead, so any device
 * on it could command the generator.
 *
 * 🛑 Two independent ceilings guard the runtime, and that is on purpose: the point's `control`
 * descriptor (max minutes, enforced by `validatePointAction` before we are called) and the hub's
 * `control.maxRuntimeSec` (enforced on the hub, which is the thing actually holding the latch).
 * They are NOT derived from each other — a mistake in the web app's config cannot widen what the
 * hub will accept.
 */
import type {
  ControlCapability,
  ControlInvokeContext,
  ControlInvokeResult,
} from "../types";
import { ControlDispatchError } from "@/lib/control/errors";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { hubRun } from "./hub-client";

/**
 * The point this capability commands, by LOGICAL address (`logicalPath/metricType`) so it stays
 * stable across physical field renames — same convention as Tesla's `resolveDispatch`.
 */
const RUN_REQUEST_ADDRESS = "source.generator.control.request/duration";

export class DeepSeaControlCapability implements ControlCapability {
  async invoke(ctx: ControlInvokeContext): Promise<ControlInvokeResult> {
    const address = `${ctx.point.logicalPath ?? ""}/${ctx.point.metricType}`;
    if (address !== RUN_REQUEST_ADDRESS || ctx.action !== "set_value") {
      // A server config bug rather than a user error: `points.control` claims this point is
      // writable but this vendor has no command for it. Surfaces as 'failed'/500.
      throw new Error(
        `DeepSea has no command for ${ctx.point.logicalPath ?? "?"}/${ctx.point.metricType} action '${ctx.action}'`,
      );
    }

    const minutes = ctx.value;
    if (
      typeof minutes !== "number" ||
      !Number.isFinite(minutes) ||
      minutes < 0
    ) {
      throw new ControlDispatchError(
        "A run request needs a non-negative number of minutes (0 stops)",
        400,
      );
    }

    const siteId = ctx.device.vendorSiteId;
    if (!siteId) {
      throw new ControlDispatchError("Device has no vendor site id", 400);
    }

    const ownerId = ctx.device.ownerClerkUserId;
    if (!ownerId) {
      // Not an oversight: ownerless hardware is commandable by nobody, because there are no
      // credentials to command it WITH. See lib/control/ownership.ts.
      throw new ControlDispatchError("System has no owner", 400);
    }

    const credentials = await getDeviceCredentials(ownerId, ctx.device.id);
    const passkey = credentials?.controlPasskey;
    if (typeof passkey !== "string" || !passkey) {
      throw new ControlDispatchError(
        "This generator has no control passkey stored — generator control is not set up for this device",
        501,
      );
    }

    const runtimeSec = Math.round(minutes * 60); // ← the unit seam
    const result = await hubRun(siteId, passkey, runtimeSec);

    if (!result.ok) {
      // The hub refused (not in Auto, already running under someone else's command, over its own
      // cap, an ambiguous write). These are RETURNED as benign declines with the hub's own wording
      // — it knows why, and its reasons are written to be read by a human.
      return {
        ok: false,
        reason: result.reason ?? "the generator hub declined the request",
      };
    }

    if (runtimeSec === 0) {
      // 🛑 Released ≠ stopped. Clearing our telemetry latch cannot cancel a run the SP-PRO is
      // commanding on its own digital input, and saying "stopped" when the engine is still turning
      // would be a lie the user acts on.
      return result.stillRunning
        ? {
            ok: true,
            reason: `Released the hub's run request, but the engine is still running — it is being commanded by ${result.stillRunning === "remote-start-input" ? "the SP-PRO inverter" : "an unknown source"}, which this control cannot override.`,
          }
        : {
            ok: true,
            reason:
              "Run request released; the generator will cool down and stop.",
          };
    }

    const stopsAt = result.stopAt
      ? new Date(result.stopAt).toLocaleTimeString("en-AU", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Australia/Melbourne",
        })
      : "an unknown time";
    return {
      ok: true,
      reason:
        result.action === "extended"
          ? `Run extended — now stops at ${stopsAt}.`
          : `Generator starting — runs until ${stopsAt}.`,
    };
  }
}
