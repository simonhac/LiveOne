/**
 * Shared client types for the owner-facing Area builder (`components/area-builder/`).
 *
 * These mirror the verified `/api/v4/*` response contract exactly — they are the wire shapes the
 * dialog + tabs pass around. Kept in one place so the dialog, MembersTab, and BindingsTab agree on
 * the JSON without re-declaring it. No server imports (client-only), so this file is safe in
 * "use client" components.
 *
 * 🛑 `fetchJson<T>` is an UNCHECKED CAST — nothing here is validated at runtime. Each interface below
 * was diffed field-by-field against the handler that emits it (config-v4 Phase 14 stage 13); a wrong
 * key here compiles clean and renders empty.
 */

import type { AreaLocation } from "@/lib/areas/types";
import type { DeviceId, PointId } from "@/lib/ids";

/**
 * A device the caller may add as a member — one row of `GET /api/v4/devices`.
 *
 * Renamed from the legacy `candidate-devices` vocabulary: `displayName`→`name`, `vendorType`→`vendor`,
 * `alias`→`slug`, `ownerClerkUserId`→`ownerUserId`, and the int `id` became the `dv_` TypeID with the
 * integer retained as `legacySystemId`. `id` is nullable only to let a `devices` mapping hole degrade
 * to a 200 rather than a 500.
 */
export interface CandidateDevice {
  id: DeviceId | null;
  /** The integer data-addressing handle — what `/api/device/{id}/points` and `/api/data` use. */
  legacySystemId: number;
  name: string;
  slug: string | null;
  vendor: string;
  vendorSiteId: string;
  status: string;
  ownerUserId: string | null;
}

export interface CandidateDevicesResponse {
  devices: CandidateDevice[];
}

/**
 * One typed role→point edge, as `GET /api/v4/areas/{id}` and `PUT …/bindings` state it.
 *
 * Two v4 widenings over the legacy editor payload: the binding's own `bn_` identity, and `priority` —
 * the (role, metric) slot's selection order, which survives cutover where `ordinal` does not.
 */
export interface AreaBinding {
  /** The binding's own `bn_` TypeID. */
  id: string;
  role: string;
  metricType: string;
  /** The bound point's `pt_` TypeID — `area_bindings.point_uid`, encoded. */
  pointId: PointId;
  priority: number;
  transform?: string | null;
}

/** One member device of the area — `GET /api/v4/areas/{id}`'s `members[]`. */
export interface AreaMember {
  /** The member's `dv_` TypeID — the currency `PUT …/members` speaks. */
  id: DeviceId;
  /** Its integer handle. Present even for a member `GET /api/v4/devices` filters out (inactive). */
  legacySystemId: number;
  name: string;
  vendor: string;
  status: string;
  capabilities: string[];
}

/**
 * The subset of a member the picker + the bindings editor need, in the ONE currency the v4 member
 * write speaks (`dv_`). Create mode builds these from `candidates`; edit mode gets them from the
 * aggregate's `members[]`, which is a superset.
 */
export interface MemberChip {
  id: DeviceId;
  legacySystemId: number;
  name: string;
  vendor: string;
}

/**
 * The Area's metadata slice from `GET /api/v4/areas/{id}`.
 *
 * v4 vocabulary: `displayName`→`name`, `alias`→`slug`, and `timezoneOffsetMin`→`dayOffsetMin` (a
 * rename — §7 makes the fixed day offset canonical and one number still writes both columns).
 */
export interface AreaEditMeta {
  /** The opaque `ar_` TypeID. */
  id: string;
  name: string;
  slug: string | null;
  dayOffsetMin: number;
  displayTimezone: string;
  location: AreaLocation | null;
  status: string;
  capabilities: string[];
  legacySystemId: number | null;
}

/**
 * The full `GET /api/v4/areas/{id}` aggregate — meta + members + bindings in ONE payload.
 *
 * There is no separate v4 `bindings` GET: §9.2 folds the collection into the aggregate, so the editor
 * fetches once instead of twice.
 */
export interface AreaEditPayload {
  area: AreaEditMeta;
  members: AreaMember[];
  bindings: AreaBinding[];
}

/**
 * One point of a member device — one row of `GET /api/device/[id]/points?showActive=true`, addressed
 * by the member's integer handle (`AreaMember.legacySystemId`). Unchanged by config-v4: this route is
 * not part of the `/api/areas`/`/api/dashboards` trees.
 */
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
