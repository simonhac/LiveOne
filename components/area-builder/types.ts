/**
 * Shared client types for the owner-facing Area builder (`components/area-builder/`).
 *
 * These mirror the verified `/api/areas/*` response contract exactly — they are the wire shapes the
 * dialog + tabs pass around. Kept in one place so the dialog, MembersTab, and BindingsTab agree on
 * the JSON without re-declaring it. No server imports (client-only), so this file is safe in
 * "use client" components.
 */

import type { AreaLocation } from "@/lib/areas/types";

/** A device the caller may add as a member — one row of `GET /api/areas/candidate-systems`. */
export interface CandidateSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  vendorType: string;
  status: string;
  ownerClerkUserId: string | null;
  alias: string | null;
}

export interface CandidateSystemsResponse {
  systems: CandidateSystem[];
}

/** One typed role→point edge — the shape both the editor and `PUT .../bindings` use. */
export interface AreaBinding {
  role: string;
  metricType: string;
  pointSystemId: number;
  pointId: number;
  transform?: string | null;
}

/** The Area's metadata slice from `GET /api/areas/[areaId]`. */
export interface AreaEditMeta {
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

/** One point of a member device — one row of `GET /api/system/[id]/points?showActive=true`. */
export interface SystemPoint {
  logicalPath: string;
  physicalPath: string;
  name: string;
  metricType: string;
  metricUnit: string;
  /** `"systemId.pointId"` — split on "." for a binding's pointSystemId/pointId. */
  reference: string;
  active: boolean;
}

export interface SystemPointsResponse {
  points: SystemPoint[];
}

/** Split a point `reference` ("systemId.pointId") into its numeric parts, or null if malformed. */
export function parseReference(
  reference: string,
): { pointSystemId: number; pointId: number } | null {
  const dot = reference.indexOf(".");
  if (dot < 0) return null;
  const pointSystemId = Number(reference.slice(0, dot));
  const pointId = Number(reference.slice(dot + 1));
  if (!Number.isInteger(pointSystemId) || !Number.isInteger(pointId))
    return null;
  return { pointSystemId, pointId };
}

/** The logical-path stem = the part before the "/" (e.g. "source.solar/power" → "source.solar"). */
export function stemOfLogicalPath(logicalPath: string): string {
  const slash = logicalPath.indexOf("/");
  return slash < 0 ? logicalPath : logicalPath.slice(0, slash);
}
