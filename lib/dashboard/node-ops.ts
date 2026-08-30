/**
 * config-v4 structural node operations — the pure transforms behind `scripts/ops/dashboard/cli.ts`
 * (and any future editor surface): insert / remove / move a node, patch a node's envelope props.
 *
 * All transforms are PURE (the input doc is never mutated, mirroring `appendGroupToDoc`) and are
 * meant to run over a NORMALIZED doc (every node carries an `n_…` id — `validateDocV4(...).normalized`),
 * because nodes are addressed by id. Depth cap, per-type config, and duplicate-id checks are NOT
 * enforced here: `validateDocV4` is the single enforcement point, run by the caller on the result
 * before persisting.
 *
 * Failures throw {@link NodeOpError} with a stable `code` so callers can present them without
 * string-matching messages.
 */
import { type AreaId, type DeviceId } from "@/lib/ids";
import {
  type DashboardNode,
  type DashboardV4,
  type GroupNode,
  type NodeId,
  walkNodes,
} from "./v4";
import { normalizeDocV4 } from "./v4-validate";

export type NodeOpErrorCode =
  | "node-not-found"
  | "not-a-group"
  | "root-immutable"
  | "cycle"
  | "index-out-of-range"
  | "wrong-kind";

export class NodeOpError extends Error {
  constructor(
    readonly code: NodeOpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NodeOpError";
  }
}

/** Where to put a node: inside a group (append when `index` omitted), or beside a sibling. */
export type NodePosition =
  | { parentId: NodeId; index?: number }
  | { beforeId: NodeId }
  | { afterId: NodeId };

export interface FoundNode {
  node: DashboardNode;
  /** `null` only for the root. */
  parent: GroupNode | null;
  /** Position in `parent.children`; `-1` for the root. */
  index: number;
  /** Dotted path, e.g. `root.children[0].children[2]` — the same shape `validateDocV4` issues use. */
  path: string;
  /** Root is depth 1 (matches `walkNodes` / `DEPTH_CAP`). */
  depth: number;
}

/** Locate a node by id anywhere in the tree. */
export function findNode(doc: DashboardV4, id: NodeId): FoundNode | null {
  let found: FoundNode | null = null;
  const recur = (
    node: DashboardNode,
    parent: GroupNode | null,
    index: number,
    path: string,
    depth: number,
  ): void => {
    if (found) return;
    if (node.id === id) {
      found = { node, parent, index, path, depth };
      return;
    }
    if (node.kind === "group") {
      node.children.forEach((child, i) =>
        recur(child, node, i, `${path}.children[${i}]`, depth + 1),
      );
    }
  };
  recur(doc.root, null, -1, "root", 1);
  return found;
}

/**
 * Drop every `id` from a subtree, so `normalizeDocV4` mints fresh ones on the destination document.
 *
 * 🛑 NOT optional when inserting a subtree built elsewhere. `GET /api/v4/areas/{ar_}/default-group`
 * builds its group inside a throwaway single-group document and normalizes THAT, so the group arrives
 * carrying ids that are only meaningful in the document it was never part of. Appending it verbatim
 * can collide with the destination's own ids, and `validateDocV4` then rejects the whole write with
 * `duplicate-node-id` (422).
 *
 * Under the old sequential minter that collision was CERTAIN (every document minted `n_1, n_2, …`,
 * so a first add succeeded and a second 422'd — a single-add test could not see it). Ids are random
 * now, so the collision is rare rather than certain: less likely to be caught by a test, and no less
 * wrong. An id belongs to the document that minted it, so an appended subtree is always re-minted;
 * existing nodes keep their ids, which keeps React keys stable across a save.
 */
export function stripNodeIds(node: DashboardNode): DashboardNode {
  const { id: _dropped, ...rest } = node;
  return rest.kind === "group"
    ? { ...rest, children: rest.children.map(stripNodeIds) }
    : rest;
}

/**
 * Re-mint EVERY node id in a document — a one-time migration off the retired sequential ids
 * (`n_0`, `n_1`, …) onto the random form. Structure, refs and config are untouched; only ids change.
 *
 * 🛑 This is the one operation that deliberately breaks the stable-key contract every other path
 * upholds, so it is a migration and not an edit: every `n_…` a person or an agent noted from a
 * previous `show` stops resolving. That is the point — a stale sequential id could silently address
 * a DIFFERENT node, because the old minter recycled a deleted node's id on the next insert.
 */
export function remintNodeIds(doc: DashboardV4): DashboardV4 {
  return normalizeDocV4({
    ...doc,
    root: stripNodeIds(doc.root) as GroupNode,
  });
}

export interface NodeOpResult {
  doc: DashboardV4;
  /** Dotted path of the affected node in the RESULT doc (for remove: its path in the input doc). */
  path: string;
}

export interface InsertResult extends NodeOpResult {
  /** The group the node landed in and its child index — resolve the minted id post-normalize via
   *  `findNode(normalized, parentId)!.node.children[index]`. */
  parentId: NodeId;
  index: number;
}

/** Resolve a position to a concrete (parent group, index) slot. */
function resolveSlot(
  doc: DashboardV4,
  pos: NodePosition,
): { parent: FoundNode; parentId: NodeId; index: number } {
  if ("parentId" in pos) {
    const parent = findNode(doc, pos.parentId);
    if (!parent) {
      throw new NodeOpError("node-not-found", `no node "${pos.parentId}"`);
    }
    if (parent.node.kind !== "group") {
      throw new NodeOpError(
        "not-a-group",
        `node "${pos.parentId}" is a card, not a group — it cannot hold children`,
      );
    }
    const len = parent.node.children.length;
    const index = pos.index ?? len;
    if (index < 0 || index > len) {
      throw new NodeOpError(
        "index-out-of-range",
        `index ${index} out of range 0..${len} for group "${pos.parentId}"`,
      );
    }
    return { parent, parentId: pos.parentId, index };
  }
  const anchorId = "beforeId" in pos ? pos.beforeId : pos.afterId;
  const anchor = findNode(doc, anchorId);
  if (!anchor) {
    throw new NodeOpError("node-not-found", `no node "${anchorId}"`);
  }
  if (!anchor.parent) {
    throw new NodeOpError(
      "root-immutable",
      "cannot position a node beside the root",
    );
  }
  const parent = findNode(doc, anchor.parent.id as NodeId)!;
  return {
    parent,
    parentId: anchor.parent.id as NodeId,
    index: "beforeId" in pos ? anchor.index : anchor.index + 1,
  };
}

/** Pure splice of `node` into `parentId.children[index]`. Callers have already validated the slot. */
function spliceIn(
  doc: DashboardV4,
  parentId: NodeId,
  index: number,
  node: DashboardNode,
): DashboardV4 {
  const recur = (n: DashboardNode): DashboardNode => {
    if (n.kind !== "group") return n;
    if (n.id === parentId) {
      const children = [...n.children];
      children.splice(index, 0, node);
      return { ...n, children };
    }
    return { ...n, children: n.children.map(recur) };
  };
  return { ...doc, root: recur(doc.root) as GroupNode };
}

/** Pure removal of the node with `id`. Callers have already checked it exists and is not the root. */
function spliceOut(doc: DashboardV4, id: NodeId): DashboardV4 {
  const recur = (n: DashboardNode): DashboardNode => {
    if (n.kind !== "group") return n;
    return {
      ...n,
      children: n.children.filter((c) => c.id !== id).map(recur),
    };
  };
  return { ...doc, root: recur(doc.root) as GroupNode };
}

/**
 * Insert a (possibly foreign-built) subtree. Ids on the inserted subtree are STRIPPED (see
 * {@link stripNodeIds}); run the result through `validateDocV4` and persist `normalized` so the new
 * nodes get their `n_…` ids.
 */
export function insertNode(
  doc: DashboardV4,
  node: DashboardNode,
  pos: NodePosition,
): InsertResult {
  const { parent, parentId, index } = resolveSlot(doc, pos);
  return {
    doc: spliceIn(doc, parentId, index, stripNodeIds(node)),
    path: `${parent.path}.children[${index}]`,
    parentId,
    index,
  };
}

export interface RemoveResult extends NodeOpResult {
  removed: DashboardNode;
}

/** Remove a node (and its whole subtree). The root cannot be removed. */
export function removeNode(doc: DashboardV4, id: NodeId): RemoveResult {
  const target = findNode(doc, id);
  if (!target) throw new NodeOpError("node-not-found", `no node "${id}"`);
  if (!target.parent) {
    throw new NodeOpError("root-immutable", "cannot remove the root node");
  }
  return { doc: spliceOut(doc, id), path: target.path, removed: target.node };
}

/**
 * Move a node (subtree intact, ids PRESERVED — that is what keeps editor keys stable) to a new
 * position. Refuses to move the root or to move a node into its own subtree.
 */
export function moveNode(
  doc: DashboardV4,
  id: NodeId,
  pos: NodePosition,
): InsertResult {
  const target = findNode(doc, id);
  if (!target) throw new NodeOpError("node-not-found", `no node "${id}"`);
  if (!target.parent) {
    throw new NodeOpError("root-immutable", "cannot move the root node");
  }
  const refId =
    "parentId" in pos
      ? pos.parentId
      : "beforeId" in pos
        ? pos.beforeId
        : pos.afterId;
  if (refId === id) {
    throw new NodeOpError(
      "cycle",
      `cannot position "${id}" relative to itself`,
    );
  }
  // Validate the destination exists at all before removal, so a typo'd target reads as
  // node-not-found rather than cycle.
  if (!findNode(doc, refId)) {
    throw new NodeOpError("node-not-found", `no node "${refId}"`);
  }
  const without = spliceOut(doc, id);
  // If the destination vanished with the subtree, it was inside the node being moved.
  let slot: ReturnType<typeof resolveSlot>;
  try {
    slot = resolveSlot(without, pos);
  } catch (err) {
    if (err instanceof NodeOpError && err.code === "node-not-found") {
      throw new NodeOpError(
        "cycle",
        `cannot move "${id}" into its own subtree`,
      );
    }
    throw err;
  }
  return {
    doc: spliceIn(without, slot.parentId, slot.index, target.node),
    path: `${slot.parent.path}.children[${slot.index}]`,
    parentId: slot.parentId,
    index: slot.index,
  };
}

/**
 * An envelope/leaf patch. A key set to `null` DELETES that key from the node; a key left `undefined`
 * (absent) is untouched. `direction`/`wrap`/`heading` are group-only; `type`/`config` are card-only —
 * a kind mismatch throws `wrong-kind`.
 */
export interface NodePatch {
  area?: AreaId | null;
  device?: DeviceId | null;
  hidden?: boolean | null;
  /** `size.columns`; `null` drops the sizing hint entirely. */
  columns?: number | null;
  direction?: "row" | "column" | null;
  wrap?: boolean | null;
  heading?: boolean | null;
  type?: string;
  config?: unknown;
}

const GROUP_ONLY_KEYS = ["direction", "wrap", "heading"] as const;
const CARD_ONLY_KEYS = ["type", "config"] as const;

function has(patch: NodePatch, key: keyof NodePatch): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

/** Patch a node's props in place (structurally — the doc is not mutated). */
export function setNodeProps(
  doc: DashboardV4,
  id: NodeId,
  patch: NodePatch,
): NodeOpResult {
  const target = findNode(doc, id);
  if (!target) throw new NodeOpError("node-not-found", `no node "${id}"`);
  const kind = target.node.kind;
  for (const key of GROUP_ONLY_KEYS) {
    if (has(patch, key) && kind !== "group") {
      throw new NodeOpError(
        "wrong-kind",
        `"${key}" applies to groups; "${id}" is a card`,
      );
    }
  }
  for (const key of CARD_ONLY_KEYS) {
    if (has(patch, key) && kind !== "card") {
      throw new NodeOpError(
        "wrong-kind",
        `"${key}" applies to cards; "${id}" is a group`,
      );
    }
  }

  const patched = (node: DashboardNode): DashboardNode => {
    // Work on a mutable shallow copy; deletions below are why this is not a spread-merge.
    const next: Record<string, unknown> = { ...node };
    const setOrDelete = (key: string, value: unknown): void => {
      if (value === null) delete next[key];
      else next[key] = value;
    };
    if (has(patch, "area")) setOrDelete("area", patch.area);
    if (has(patch, "device")) setOrDelete("device", patch.device);
    if (has(patch, "hidden")) setOrDelete("hidden", patch.hidden);
    if (has(patch, "columns")) {
      if (patch.columns === null) delete next.size;
      else next.size = { ...(node.size ?? {}), columns: patch.columns };
    }
    if (has(patch, "direction")) setOrDelete("direction", patch.direction);
    if (has(patch, "wrap")) setOrDelete("wrap", patch.wrap);
    if (has(patch, "heading")) setOrDelete("heading", patch.heading);
    if (has(patch, "type")) next.type = patch.type;
    if (has(patch, "config")) setOrDelete("config", patch.config);
    return next as unknown as DashboardNode;
  };

  const recur = (n: DashboardNode): DashboardNode => {
    if (n.id === id) return patched(n);
    if (n.kind !== "group") return n;
    return { ...n, children: n.children.map(recur) };
  };
  return {
    doc: { ...doc, root: recur(doc.root) as GroupNode },
    path: target.path,
  };
}

/** Every node id in a subtree (the node itself included) — used to mark a subtree in a render. */
export function subtreeIds(node: DashboardNode): NodeId[] {
  const ids: NodeId[] = [];
  const recur = (n: DashboardNode): void => {
    if (n.id) ids.push(n.id);
    if (n.kind === "group") n.children.forEach(recur);
  };
  recur(node);
  return ids;
}

/** How many nodes in a doc are missing an id (i.e. would be assigned one by `normalizeDocV4`). */
export function countMissingIds(doc: DashboardV4): number {
  let n = 0;
  walkNodes(doc, (node) => {
    if (!node.id) n++;
  });
  return n;
}
