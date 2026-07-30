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
    members: source.members.map((member) => ({
      ...member,
      capabilities: [...member.capabilities].sort(),
    })),
    bindings: source.bindings.map((binding) => ({
      id: Binding.encode(binding.id),
      role: binding.role,
      metricType: binding.metricType,
      pointId: Point.encode(binding.pointUid),
      priority: binding.priority,
      transform: binding.transform,
    })),
  };
}
