import { Area, Binding, Point, type DeviceId } from "@/lib/ids";
import type { AreaConfig, AreaLocation } from "./types";

export interface AreaDetailSource {
  area: {
    id: string;
    name: string;
    slug: string | null;
    status: string;
    dayOffsetMin: number | null;
    timezoneOffsetMin: number;
    displayTimezone: string;
    location: AreaLocation | null;
    config: AreaConfig | null;
    capabilities: string[];
    /** The integer data-addressing handle — see `legacySystemId` on the emitted shape below. */
    legacySystemId: number | null;
  };
  members: {
    id: DeviceId;
    /** The member device's integer data-addressing handle (`devices.rid`) — see the note below. */
    legacySystemId: number;
    name: string;
    vendor: string;
    status: string;
    capabilities: string[];
  }[];
  bindings: {
    id: string;
    role: string;
    metricType: string;
    pointUid: string;
    priority: number;
    transform: string | null;
  }[];
}

/**
 * Pure final-wire serializer: every entity IDENTITY crosses the v4 boundary as a TypeID.
 *
 * `legacySystemId` is the one deliberate exception and is NOT an identity — it is the integer
 * ADDRESS `/api/data?systemId=` and the KV keyspace are still keyed by, which the legacy twin
 * (`GET /api/areas/{areaId}`) returns and which `components/areas/AreaTable.tsx` renders. Omitting it
 * made this payload silently non-substitutable for the legacy one; see the same note (and the much
 * sharper failure mode) on `app/api/v4/areas/route.ts`. It dies with the handle, not before.
 *
 * 🛑 The SAME exception applies per MEMBER, and for the same reason. The
 * legacy twin's `memberSystemIds: number[]` is what the area builder's Bindings tab turns into
 * `GET /api/device/{handle}/points` — the only way to enumerate a member's bindable points. Emitting a
 * `dv_` alone forced the client to re-derive the handle by joining against `GET /api/v4/devices`, which
 * silently loses any member that route filters out: `devicesVisibleByUser` is `activeOnly`, and a
 * `status='removed'` member IS still a member (two of them are on `liveone-dev` today). Those members'
 * points would have vanished from the picker with no error — so the number is carried, not re-derived.
 *
 * NOT a narrowing, by contrast: `timezoneOffsetMin` is deliberately absent because clean-sheet §7 /
 * locked decision 9 make the FIXED DAY OFFSET canonical — `dayOffsetMin` carries the same number
 * (`updateAreaMeta` writes both from one input) under the name v4 means.
 */
export function areaDetailResponse(source: AreaDetailSource) {
  return {
    area: {
      id: Area.encode(source.area.id),
      name: source.area.name,
      slug: source.area.slug,
      status: source.area.status,
      dayOffsetMin: source.area.dayOffsetMin ?? source.area.timezoneOffsetMin,
      displayTimezone: source.area.displayTimezone,
      location: source.area.location,
      config: source.area.config ?? {},
      capabilities: [...source.area.capabilities].sort(),
      legacySystemId: source.area.legacySystemId,
    },
    members: areaMembersWire(source.members),
    bindings: areaBindingsWire(source.bindings),
  };
}

/**
 * The `members` collection, alone — what `PUT /api/v4/areas/{id}/members` returns as "the new state".
 *
 * Split out of `areaDetailResponse` rather than re-written beside it: §9.2 makes the collection PUT's
 * response the same list the aggregate GET carries, so a second projection would only exist in order to
 * drift from this one.
 */
export function areaMembersWire(members: AreaDetailSource["members"]) {
  return members.map((member) => ({
    ...member,
    capabilities: [...member.capabilities].sort(),
  }));
}

/** The `bindings` collection, alone — what `PUT /api/v4/areas/{id}/bindings` returns. See above. */
export function areaBindingsWire(bindings: AreaDetailSource["bindings"]) {
  return bindings.map((binding) => ({
    id: Binding.encode(binding.id),
    role: binding.role,
    metricType: binding.metricType,
    pointId: Point.encode(binding.pointUid),
    priority: binding.priority,
    transform: binding.transform,
  }));
}
