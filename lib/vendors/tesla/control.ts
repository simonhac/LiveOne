/**
 * Tesla's `ControlCapability` — the one place a point action becomes a Fleet command.
 *
 * This is a straight lift of the old bespoke route (`app/api/devices/[systemId]/tesla/command`,
 * since deleted — the v4 action route is the only caller). Every user-visible string was
 * preserved verbatim from that route.
 *
 * 🛑 The signer seam is UNTOUCHED. `TeslaClient`'s command methods and
 * `TeslaCommandSigner`/`DirectCommandSigner` are called exactly as they were; when a 2021+ car
 * needs a proxy signer, that still slots in at `command-signer.ts` and nothing here changes.
 *
 * 🛑 Credentials are ALWAYS the DEVICE OWNER's, never a session user's — an admin acting on
 * someone else's car uses the owner's stored tokens, and an automation (which has no session
 * user at all) resolves them from the device alone.
 */
import type {
  ControlCapability,
  ControlInvokeContext,
  ControlInvokeResult,
} from "../types";
import {
  ControlDispatchError,
  ControlRejectedError,
} from "@/lib/control/errors";
import { TeslaCommandProtocolError } from "./command-signer";
import { getValidTeslaToken } from "./tesla-auth";
import { getTeslaClient } from "./tesla-client";
import type { TeslaCommandResult, TeslaCredentials } from "./types";

/** A dispatch closure, resolved from (logicalPath, metricType, action). */
type Dispatch = (
  client: ReturnType<typeof getTeslaClient>,
  accessToken: string,
  vehicleId: string,
) => Promise<TeslaCommandResult>;

/**
 * (point address, action) → Fleet command. The address is the point's LOGICAL identity
 * (`ev.charge/active`, `ev.charge.limit/soc`, `ev.charge.limit/current`), not its physical path,
 * so it stays stable across vendor field renames.
 */
function resolveDispatch(ctx: ControlInvokeContext): Dispatch | null {
  const address = `${ctx.point.logicalPath ?? ""}/${ctx.point.metricType}`;
  const value = ctx.value;

  switch (address) {
    case "ev.charge/active":
      if (ctx.action === "turn_on") {
        return (client, token, vehicleId) =>
          client.chargeStart(token, vehicleId);
      }
      if (ctx.action === "turn_off") {
        return (client, token, vehicleId) =>
          client.chargeStop(token, vehicleId);
      }
      return null;
    case "ev.charge.limit/soc":
      if (ctx.action === "set_value" && typeof value === "number") {
        return (client, token, vehicleId) =>
          client.setChargeLimit(token, vehicleId, value);
      }
      return null;
    case "ev.charge.limit/current":
      if (ctx.action === "set_value" && typeof value === "number") {
        return (client, token, vehicleId) =>
          client.setChargingAmps(token, vehicleId, value);
      }
      return null;
    default:
      return null;
  }
}

export class TeslaControlCapability implements ControlCapability {
  async invoke(ctx: ControlInvokeContext): Promise<ControlInvokeResult> {
    // Charge commands are Fleet-API only (the Owner API path can't be relied on). Checked at
    // INVOKE time, not module load: a module-level const is untestable and misbehaves on a
    // serverless cold start with late-injected env.
    const hasFleetApiConfig = !!(
      process.env.TESLA_CLIENT_ID &&
      process.env.TESLA_CLIENT_SECRET &&
      process.env.TESLA_REDIRECT_URI
    );
    if (!hasFleetApiConfig) {
      throw new ControlDispatchError(
        "Tesla charge control requires Fleet API configuration",
        501,
      );
    }

    const ownerId = ctx.device.ownerClerkUserId;
    if (!ownerId) {
      throw new ControlDispatchError("System has no owner", 400);
    }

    const dispatch = resolveDispatch(ctx);
    if (!dispatch) {
      // A server config bug rather than a user error: `points.control` claims this point is
      // writable but this vendor has no command for it. Surfaces as 'failed'/500.
      throw new Error(
        `Tesla has no command for ${ctx.point.logicalPath ?? "?"}/${ctx.point.metricType} action '${ctx.action}'`,
      );
    }

    // The owner's token + their regional Fleet host.
    const { accessToken, credentials } = await getValidTeslaToken(
      ownerId,
      ctx.device.id,
    );
    const teslaCredentials = credentials as TeslaCredentials;
    const vehicleId = teslaCredentials.vehicle_id;
    const client = getTeslaClient(teslaCredentials.fleet_api_base_url);

    // Wake if asleep (commands fail on a sleeping vehicle)
    const vehicles = await client.getVehicles(accessToken);
    const vehicle = vehicles.find((v) => String(v.id) === vehicleId);
    if (!vehicle) {
      throw new ControlDispatchError(`Vehicle ${vehicleId} not found`, 404);
    }
    if (vehicle.state !== "online") {
      const awoke = await client.wakeUp(accessToken, vehicleId);
      if (!awoke) {
        throw new ControlDispatchError(
          "Vehicle is asleep and did not wake up; try again shortly",
          503,
        );
      }
    }

    let result: TeslaCommandResult;
    try {
      result = await dispatch(client, accessToken, vehicleId);
    } catch (error) {
      if (error instanceof TeslaCommandProtocolError) {
        // The car requires signed commands (not exempt) — Phase 2 territory. Rethrown
        // vendor-agnostically so `lib/control` never has to import a Tesla symbol.
        throw new ControlRejectedError(
          "This vehicle requires signed commands (Tesla Vehicle Command protocol), which isn't supported yet.",
          "vehicle_command_protocol_required",
        );
      }
      throw error;
    }

    // Tesla returns result=false with a reason for benign no-ops (e.g. "not_charging" when
    // stopping an idle charge). That is a RETURN, not a throw — the caller answers 200.
    return { ok: result.result, reason: result.reason || undefined };
  }
}
