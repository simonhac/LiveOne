/**
 * The ONE dispatch path of the command plane.
 *
 * Every command — from the v4 action route and from the
 * automation evaluator — goes through `dispatchPointAction`. It validates against the point's
 * own `control` descriptor, writes a `point_commands` audit row, dispatches through the
 * vendor's `ControlCapability`, and completes that row in place with the outcome.
 *
 * Deliberately session-free and authorization-free:
 *  - it does NOT authorize (callers do — the routes with `requireDeviceAccess`, the evaluator
 *    by construction), and
 *  - it does NOT re-poll (callers schedule that, because `after()` needs a request scope).
 * That is what lets an automation with no user call it exactly the way a request does.
 *
 * It never throws: an unexpected error becomes `{kind:"failed"}` with the row marked `failed`.
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices,
  pointCommands,
  points,
  type PointRow,
} from "@/lib/db/planetscale/schema";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import { VendorRegistry } from "@/lib/vendors/registry";
import { ControlDispatchError, ControlRejectedError } from "./errors";
import { validatePointAction, type PointActionName } from "./point-control";
import type { StructuredMessage } from "@/lib/control/message-format";

export interface PointActionRequest {
  point: PointRow;
  device: DeviceConfigView;
  action: PointActionName;
  value?: number;
  /**
   * A clerk user id, or the literal form `automation:au_…` (PR-F). AUDIT ONLY — credentials
   * are always resolved from the device owner, never from this.
   */
  requestedBy: string;
}

export type PointActionOutcome =
  /** Malformed for this point (not controllable / bad action / out of range) → 400, no audit row. */
  | { kind: "invalid"; error: string }
  /** We could not attempt it (no vendor capability / no env / asleep / missing vehicle). */
  | {
      kind: "unavailable";
      error: string;
      httpStatus: 400 | 404 | 501 | 503;
      commandId?: string;
    }
  /** Dispatched and answered — `ok:false` is a BENIGN vendor decline, still a 200. */
  | {
      kind: "completed";
      ok: boolean;
      reason: string | null;
      /** `reason` unrendered — see `ControlInvokeResult.reasonMessage`. Not persisted. */
      reasonMessage?: StructuredMessage;
      commandId: string;
    }
  /** The vendor refused as a matter of protocol/config → 422. */
  | { kind: "rejected"; error: string; code: string; commandId: string }
  /** Something unexpected blew up mid-dispatch → 500. */
  | { kind: "failed"; error: string; commandId: string };

/**
 * Resolve a point row + its device's rid by point uuid — the v4 action route's resolver.
 * Same `points ⋈ devices` join `findPointByStemMetric` uses, but returning the raw row.
 */
export async function loadPointByUuid(
  pointUuid: string,
): Promise<{ point: PointRow; deviceRid: number } | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ points, deviceRid: devices.rid })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(eq(points.id, pointUuid))
    .limit(1);
  return row ? { point: row.points, deviceRid: row.deviceRid } : null;
}

/**
 * Resolve a device's point row by `(rid, logicalPathStem, metricType)` — the evaluator's and
 * `checkReferences`' resolver, for callers that name a capability rather than a point id.
 */
export async function loadPointByStemMetric(
  deviceRid: number,
  logicalPathStem: string,
  metricType: string,
): Promise<PointRow | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ points })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(
        eq(devices.rid, deviceRid),
        eq(points.logicalPath, logicalPathStem),
        eq(points.metricType, metricType),
      ),
    )
    .limit(1);
  return row ? row.points : null;
}

/**
 * Validate → audit → dispatch → complete. See the module header.
 *
 * Status vocabulary (the CHECK on `point_commands.status` is closed):
 *   `ok`       — the vendor accepted the command
 *   `rejected` — the command was refused (a benign vendor decline OR a protocol refusal)
 *   `failed`   — we could not complete the dispatch at all
 */
export async function dispatchPointAction(
  req: PointActionRequest,
): Promise<PointActionOutcome> {
  const { point, device, action, value, requestedBy } = req;

  // 1. Validate against the point's own descriptor. No audit row: the trail records dispatched
  //    attempts, not malformed requests.
  const validation = validatePointAction(point.control, action, value);
  if (!validation.ok) {
    return { kind: "invalid", error: validation.error };
  }

  // 2. Resolve the vendor capability. No capability = nothing to audit.
  const capability = VendorRegistry.getControlCapability(device.vendorType);
  if (!capability) {
    return {
      kind: "unavailable",
      httpStatus: 501,
      error: `Vendor '${device.vendorType}' does not support control`,
    };
  }

  const db = requirePlanetscaleDb();

  // 3. Audit row, pending.
  const [command] = await db
    .insert(pointCommands)
    .values({
      pointId: point.id,
      deviceId: point.deviceId,
      action,
      value: value ?? null,
      requestedBy,
      status: "pending",
    })
    .returning({ id: pointCommands.id });
  const commandId = command.id;

  const complete = async (fields: {
    status: "ok" | "rejected" | "failed";
    vendorResult?: unknown;
    error?: string;
  }) => {
    await db
      .update(pointCommands)
      .set({
        status: fields.status,
        vendorResult: fields.vendorResult ?? null,
        error: fields.error ?? null,
        completedAt: new Date(),
      })
      .where(eq(pointCommands.id, commandId));
  };

  // 4. Dispatch, then complete the row IN PLACE with the outcome.
  try {
    const result = await capability.invoke({ device, point, action, value });
    const reason = result.reason ?? "";
    await complete({
      status: result.ok ? "ok" : "rejected",
      vendorResult: { result: result.ok, reason },
    });
    console.log(
      `[control] ${device.vendorType} ${point.logicalPath ?? "?"}/${point.metricType} ` +
        `${action}${value !== undefined ? `=${value}` : ""} by ${requestedBy} → ` +
        `${result.ok ? "ok" : "declined"}${reason ? ` (${reason})` : ""}`,
    );
    return {
      kind: "completed",
      ok: result.ok,
      reason: reason || null,
      // Deliberately NOT persisted above: the audit row keeps the rendered sentence (with its
      // instant in ISO), which is the record. This is presentation, and only the caller needs it.
      reasonMessage: result.reasonMessage,
      commandId,
    };
  } catch (error) {
    if (error instanceof ControlRejectedError) {
      await complete({ status: "rejected", error: error.message });
      console.log(
        `[control] ${device.vendorType} ${action} rejected: ${error.code}`,
      );
      return {
        kind: "rejected",
        error: error.message,
        code: error.code,
        commandId,
      };
    }
    if (error instanceof ControlDispatchError) {
      await complete({ status: "failed", error: error.message });
      console.log(
        `[control] ${device.vendorType} ${action} unavailable (${error.httpStatus}): ${error.message}`,
      );
      return {
        kind: "unavailable",
        error: error.message,
        httpStatus: error.httpStatus,
        commandId,
      };
    }
    const message =
      error instanceof Error ? error.message : "Failed to issue command";
    await complete({ status: "failed", error: message });
    console.error(`[control] ${device.vendorType} ${action} failed:`, error);
    return { kind: "failed", error: message, commandId };
  }
}
