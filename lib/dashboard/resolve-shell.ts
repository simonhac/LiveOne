/**
 * The shell-resolution contract: the viewer-scoped facts a dashboard node needs once its `{area,
 * device}` binding is known (clean-sheet §8.1 inheritance, §10 serve path).
 *
 * Types only. `ShellResolver` is the injection point — the SSR path builds one from the authorized
 * area/device maps and `components/dashboard/v4/node-view.tsx` builds the client-side twin
 * (`clientShellResolver`), which is also where the inheritance walk itself now lives. A resolver
 * returns `null` for a dangling or unreadable ref so the node degrades to a placeholder; that is
 * never a leak, because readability is enforced both there and by the §8.4 route check.
 */
import type { AreaId, DeviceId } from "@/lib/ids";

/** A node's inherited scope binding (§8.1): its own binding if set, else the nearest ancestor's. */
export interface NodeContext {
  area?: AreaId;
  device?: DeviceId;
}

/** Resolved area facts the shell/renderer need — the shell subset of lib/areas `ReadableArea`. */
export interface ResolvedArea {
  areaId: AreaId;
  displayName: string;
  /** `areas.legacy_system_id` — the data-fetch handle + header source. null = dangling/unresolvable. */
  handle: number | null;
  chartCapable: boolean;
}

/** Resolved device facts. */
export interface ResolvedDevice {
  deviceId: DeviceId;
  name: string;
  /** The current legacy `system_id` to fetch through the data API. */
  systemId: number | null;
}

/**
 * Injected, viewer-scoped resolver. Returns `null` for a dangling/unreadable ref so the node degrades
 * to a placeholder — never a leak (readability is enforced HERE + by the §8.4 route check).
 */
export interface ShellResolver {
  area(id: AreaId): ResolvedArea | null;
  device(id: DeviceId): ResolvedDevice | null;
}
