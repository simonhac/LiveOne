/**
 * The **serving subject** — what a dashboard data request is *about*: a real device, or an Area in
 * its own right.
 *
 * config-v4 Phase 13 PR 1. Before this, an Area with no `devices` row of its own was served through
 * `synthesizeAreaView` — a device-shaped view fabricated from the `areas` row, with `vendorType:"area"`
 * and `vendorSiteId:"area:{handle}"` as filler. Every other field it supplied was already a real
 * `areas` column, so the area leg needs no fabrication at all: it needs a discriminated union.
 *
 * ## 🛑 Precedence is per-call-site and EXPLICIT — this is trap D-l
 *
 * A legacy integer handle can name BOTH an area and a device (handle 13 is a real Sigenergy device AND
 * a 3-member Area). `DeviceRegistry.resolveHandle` returns both legs and states no precedence, so every
 * caller must choose, in code:
 *
 * | Wire address | Subject | Why |
 * | --- | --- | --- |
 * | `?systemId=13` | **device** | Behaviour-preserving. Matches `viewableByHandle`'s LOCKED device-first order. Resolving area-first would silently widen handle 13 from its device's own 12 points to its area's bindings — a scope change on a **shared dashboard**. |
 * | `?deviceId=dv_…` | device | Unambiguous by construction. |
 * | `?areaId=ar_…` | area | Unambiguous by construction. This is how an Area is addressed AS an area. |
 *
 * So the legacy alias keeps its exact v3 meaning forever, and the area-native reading of a colliding
 * handle is reachable only through the new, explicit `ar_…` address. (The Phase 13 brief's step 2 says
 * `?systemId=N` should resolve "area leg first"; that contradicts the same document's own proof gate
 * for handle 13, and the gate wins.)
 *
 * ## 🛑 Scope boundary
 *
 * The **wire** is TypeID-native; the **interior** is not. `ar_…`/`dv_…` are resolved to the integer
 * handle here, at the edge, and the handle is passed inward exactly as before — the KV latest cache
 * (PR 3), `point_readings` addressing, `PointManager` dispatch and `resolveLogicalSystem` are all still
 * handle-keyed. A consequence worth stating: for a COLLIDING handle, `?areaId=ar_…` yields the area's
 * metadata but the interior still dispatches device-first for its points — now stated explicitly in
 * `PointManager._resolvePointsForHandle` rather than carried by the deleted `isAreaHandle` gate. PR 2
 * also made the AREA leg authorize against the area's own scope, so that device-first interior is no
 * longer what keeps the wider entity safe. For the four handles that are areas ONLY — 7, 8, 1000001,
 * 1000002 — there is no collision and nothing to disagree about.
 */
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import type { DeviceRecord } from "@/lib/registry/device-config";
import { DeviceRegistry } from "@/lib/registry/device-registry";
import { areas as pgAreas } from "@/lib/db/planetscale/schema";
import { Area, Device, type AreaId, type DeviceId } from "@/lib/ids";

export type AreaRow = typeof pgAreas.$inferSelect;

/** Which leg to take when a handle names both an area and a device. */
export type SubjectPreference = "device" | "area";

export type ServingSubject =
  | {
      kind: "device";
      /** The permanent integer addressing handle (`devices.rid`). Everything inward still uses this. */
      handle: number;
      deviceId: DeviceId;
      device: DeviceRecord;
    }
  | {
      kind: "area";
      handle: number;
      areaId: AreaId;
      area: AreaRow;
    };

/** The timezone offset every date field in a payload is formatted against. */
export function subjectTimezoneOffsetMin(s: ServingSubject): number {
  return s.kind === "device"
    ? s.device.timezoneOffsetMin
    : s.area.timezoneOffsetMin;
}

/**
 * The subject's IANA display timezone. Non-null for BOTH kinds: `areas.display_timezone` is `NOT NULL`
 * in the schema, and a device's own `displayTimezone` is projected from its area-of-one's column by
 * `deviceByHandle`. The annotation was widened to `string | null` until Phase 13 PR 2 gave it a caller
 * (`/api/system/{id}/run-periods`, moved off the deleted legacy view's non-null `displayTimezone`) that
 * needs the true type.
 */
export function subjectDisplayTimezone(s: ServingSubject): string {
  return s.kind === "device"
    ? s.device.displayTimezone
    : s.area.displayTimezone;
}

/** Owning Clerk user id, or null for an ownerless (public) subject. */
export function subjectOwnerId(s: ServingSubject): string | null {
  return s.kind === "device" ? s.device.ownerClerkUserId : s.area.ownerUserId;
}

export function subjectStatus(s: ServingSubject): string {
  return s.kind === "device" ? s.device.status : s.area.status;
}

export function subjectDisplayName(s: ServingSubject): string {
  return s.kind === "device" ? s.device.displayName : s.area.name;
}

/**
 * Resolve an integer handle to its serving subject, taking `prefer` when the handle names both.
 * `prefer:"device"` is the behaviour-preserving order — see the precedence table above.
 */
export async function subjectForHandle(
  handle: number,
  prefer: SubjectPreference,
): Promise<ServingSubject | null> {
  if (prefer === "device") {
    const device = await deviceSubject(handle);
    return device ?? (await areaSubject(handle));
  }
  const area = await areaSubject(handle);
  return area ?? (await deviceSubject(handle));
}

async function deviceSubject(handle: number): Promise<ServingSubject | null> {
  const device = await DeviceConfigRegistry.deviceByHandle(handle);
  if (!device) return null;
  return { kind: "device", handle, deviceId: device.deviceId, device };
}

async function areaSubject(handle: number): Promise<ServingSubject | null> {
  const area = await DeviceConfigRegistry.areaByHandle(handle);
  if (!area) return null;
  return { kind: "area", handle, areaId: Area.encode(area.id), area };
}

/**
 * The wire address a data route was called with, resolved to `{handle, prefer}`.
 *
 * Exactly one of `areaId` / `deviceId` / `systemId` may be given. `systemId` is the **permanent**
 * compatibility alias: it is already a handle, so it needs no lookup to become one — only a
 * `legacy_handles` existence check, which `subjectForHandle` performs implicitly by failing to
 * resolve either leg.
 */
export type AddressResult =
  | { ok: true; handle: number; prefer: SubjectPreference }
  | { ok: false; error: string; status: number };

export async function resolveWireAddress(
  searchParams: URLSearchParams,
): Promise<AddressResult> {
  const areaParam = searchParams.get("areaId");
  const deviceParam = searchParams.get("deviceId");
  const systemParam = searchParams.get("systemId");
  const given = [areaParam, deviceParam, systemParam].filter(
    (v) => v != null && v !== "",
  );
  if (given.length === 0) {
    return {
      ok: false,
      error: "Missing required parameter: one of areaId, deviceId, systemId",
      status: 400,
    };
  }
  if (given.length > 1) {
    return {
      ok: false,
      error: "Give exactly one of areaId, deviceId, systemId",
      status: 400,
    };
  }

  if (areaParam) {
    const parsed = Area.parse(areaParam);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `Invalid areaId: ${parsed.message}`,
        status: 400,
      };
    }
    const handle = await DeviceRegistry.handleForArea(parsed.id);
    if (handle == null) {
      return { ok: false, error: "Area not found", status: 404 };
    }
    return { ok: true, handle, prefer: "area" };
  }

  if (deviceParam) {
    const parsed = Device.parse(deviceParam);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `Invalid deviceId: ${parsed.message}`,
        status: 400,
      };
    }
    const handle = await DeviceRegistry.handleForDevice(parsed.id);
    if (handle == null) {
      return { ok: false, error: "Device not found", status: 404 };
    }
    return { ok: true, handle, prefer: "device" };
  }

  const handle = parseInt(systemParam!, 10);
  if (isNaN(handle)) {
    return {
      ok: false,
      error: "Invalid systemId: must be a number",
      status: 400,
    };
  }
  // Device-first — the LOCKED v3 order. See the precedence table above (trap D-l).
  return { ok: true, handle, prefer: "device" };
}
