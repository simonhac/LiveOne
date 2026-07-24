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

/** Pure final-wire serializer: every entity identity crosses the v4 boundary as a TypeID. */
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
