/**
 * Shared client types for the owner-facing Area builder (`components/area-builder/`).
 *
 * These mirror the verified `/api/areas/*` response contract exactly — they are the wire shapes the
 * dialog + tabs pass around. Kept in one place so the dialog, MembersTab, and BindingsTab agree on
 * the JSON without re-declaring it. No server imports (client-only), so this file is safe in
 * "use client" components.
 */

import type { AreaLocation } from "@/lib/areas/types";
import type { PointId } from "@/lib/ids";

/** A device the caller may add as a member — one row of `GET /api/areas/candidate-devices`. */
export interface CandidateDevice {
  id: number;
  displayName: string;
  vendorSiteId: string;
  vendorType: string;
  status: string;
  ownerClerkUserId: string | null;
  alias: string | null;
}

export interface CandidateDevicesResponse {
  devices: CandidateDevice[];
}

/** One typed role→point edge — the shape both the editor and `PUT .../bindings` use. */
export interface AreaBinding {
  role: string;
  metricType: string;
  /** The bound point's `pt_` TypeID — `area_bindings.point_uid`, encoded (slice E PR 2b). */
  pointId: PointId;
  transform?: string | null;
}

/** The Area's metadata slice from `GET /api/areas/[areaId]`. */
export interface AreaEditMeta {
  /** The opaque `ar_` TypeID. */
  id: string;
  displayName: string;
  alias: string | null;
  timezoneOffsetMin: number;
  displayTimezone: string;
  location: AreaLocation | null;
  status: string;
  legacySystemId: number | null;
}

/** The full `GET /api/areas/[areaId]` edit payload. */
export interface AreaEditPayload {
  area: AreaEditMeta;
  memberSystemIds: number[];
  bindings: AreaBinding[];
}

/** One point of a member device — one row of `GET /api/device/[id]/points?showActive=true`. */
export interface DevicePoint {
  logicalPath: string;
  physicalPath: string;
  name: string;
  metricType: string;
  metricUnit: string;
  /** The point's `pt_` TypeID — what a binding is stated in. */
  pointId: PointId;
  /** Legacy `"systemId.pointIndex"`. Display/keying only; never bound on. Retires in Phase 13. */
  reference: string;
  active: boolean;
}

export interface DevicePointsResponse {
  points: DevicePoint[];
}

/** The logical-path stem = the part before the "/" (e.g. "source.solar/power" → "source.solar"). */
export function stemOfLogicalPath(logicalPath: string): string {
  const slash = logicalPath.indexOf("/");
  return slash < 0 ? logicalPath : logicalPath.slice(0, slash);
}
