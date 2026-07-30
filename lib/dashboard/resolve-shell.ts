/**
 * config-v4 dashboard shell resolution (clean-sheet §8.1 inheritance, §10 serve path).
 *
 * Two responsibilities, both PURE orchestration (no DB, no React — the DB-backed `ShellResolver` is
 * injected, mirroring the v3→v4 rewriter's `LegacyRefResolver`):
 *
 *   - `resolveNodeContexts(doc)` — every node's INHERITED `{area, device}` binding: a node's own
 *     binding if set, else the nearest ancestor's (generalizes v3's `deviceSystemId ?? section-handle`).
 *   - `resolveDashboardShell(doc, resolver)` — annotate the tree with resolved area/device facts and
 *     collect the deduped data-fetch handles the SSR path seeds. This is the doc-shape-agnostic
 *     replacement for the v3 `sections[].cards[].tiles[].deviceSystemId` SSR walk.
 *
 * `collectRefs` (the §8.3 scope walk) is re-exported so callers have one import for doc resolution.
 *
 * The real `ShellResolver` is viewer-scoped: areas resolve to their current handle and stable device
 * refs resolve through `legacy_handles` to the current device address.
 */
import type { AreaId, DeviceId } from "@/lib/ids";
import type { DashboardV4, DashboardNode } from "./v4";
import { collectRefs } from "./v4-validate";

export { collectRefs };

/** A node's inherited scope binding (§8.1). */
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
  /** The current legacy `system_id` to fetch through the pre-cutover data API. */
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

/** A node annotated with its inherited context and resolved bindings. */
export interface ResolvedNode {
  node: DashboardNode;
  depth: number;
  context: NodeContext;
  /** Resolved only when `context.area` is set; `null` when the ref is dangling/unreadable. */
  area?: ResolvedArea | null;
  /** Resolved only when `context.device` is set; `null` when the ref is dangling/unreadable. */
  device?: ResolvedDevice | null;
}

export interface ResolvedShell {
  /** Every doc node, pre-order (root first), with inherited context + resolved bindings. */
  nodes: ResolvedNode[];
  /** Distinct data-fetch handles to seed (area handles + device systemIds), deduped, in first-seen order. */
  dataHandles: number[];
  /** Refs that failed to resolve — diagnostics + placeholder rendering. */
  danglingAreas: AreaId[];
  danglingDevices: DeviceId[];
}

/**
 * Pure: each node's inherited `{area, device}` binding (§8.1), pre-order, one entry per node.
 */
export function resolveNodeContexts(
  doc: DashboardV4,
): { node: DashboardNode; depth: number; context: NodeContext }[] {
  const out: { node: DashboardNode; depth: number; context: NodeContext }[] =
    [];
  const recur = (
    node: DashboardNode,
    depth: number,
    inherited: NodeContext,
  ): void => {
    const context: NodeContext = {
      area: node.area ?? inherited.area,
      device: node.device ?? inherited.device,
    };
    out.push({ node, depth, context });
    if (node.kind === "group") {
      for (const child of node.children) recur(child, depth + 1, context);
    }
  };
  recur(doc.root, 1, {});
  return out;
}

/**
 * Resolve a doc into the render/SSR shell via an injected (viewer-scoped) resolver. Pure orchestration:
 * resolves each node's inherited area/device once (cached), collects the deduped data handles, and
 * records dangling refs. The renderer consumes `nodes`; the SSR path seeds `dataHandles`.
 */
export function resolveDashboardShell(
  doc: DashboardV4,
  resolver: ShellResolver,
): ResolvedShell {
  const nodes: ResolvedNode[] = [];
  const handles: number[] = [];
  const handleSeen = new Set<number>();
  const danglingAreas = new Set<AreaId>();
  const danglingDevices = new Set<DeviceId>();
  const areaCache = new Map<AreaId, ResolvedArea | null>();
  const deviceCache = new Map<DeviceId, ResolvedDevice | null>();

  const addHandle = (h: number | null | undefined): void => {
    if (h != null && !handleSeen.has(h)) {
      handleSeen.add(h);
      handles.push(h);
    }
  };
  const resolveArea = (id: AreaId): ResolvedArea | null => {
    if (!areaCache.has(id)) areaCache.set(id, resolver.area(id));
    return areaCache.get(id)!;
  };
  const resolveDevice = (id: DeviceId): ResolvedDevice | null => {
    if (!deviceCache.has(id)) deviceCache.set(id, resolver.device(id));
    return deviceCache.get(id)!;
  };

  for (const { node, depth, context } of resolveNodeContexts(doc)) {
    let area: ResolvedArea | null | undefined;
    let device: ResolvedDevice | null | undefined;
    if (context.area) {
      area = resolveArea(context.area);
      if (area) addHandle(area.handle);
      else danglingAreas.add(context.area);
    }
    if (context.device) {
      device = resolveDevice(context.device);
      if (device) addHandle(device.systemId);
      else danglingDevices.add(context.device);
    }
    nodes.push({ node, depth, context, area, device });
  }

  return {
    nodes,
    dataHandles: handles,
    danglingAreas: [...danglingAreas],
    danglingDevices: [...danglingDevices],
  };
}

/** Convenience: the distinct area/device refs a doc touches (§8.3), for the route's readability check. */
export function docRefs(doc: DashboardV4): {
  areas: AreaId[];
  devices: DeviceId[];
} {
  return collectRefs(doc);
}
