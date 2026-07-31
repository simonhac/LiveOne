/**
 * config-v4 dashboard document — the recursive node tree (clean-sheet §8).
 *
 * Card and tile unify into one primitive. A document is `{version:4, root}` where the tree is built
 * from two node kinds:
 *   - `group`: a first-class flex layout node (`{direction, wrap, heading, size, children}`). A group
 *     bound to an `area` with `heading:true` IS a v3 "section"; a `direction:"row"` group IS a v3
 *     "tiles" card. "Sections" and "tiles containers" stop being special cases.
 *   - `card`: the leaf. A "tile" is just a small card (`size.columns` low); the registries merge.
 *
 * INVARIANTS baked into the shape:
 *   - §8.3 security: scope-bearing refs live ONLY in the envelope fields `node.area` / `node.device`,
 *     NEVER inside `config`. Share-scope + no-escalation are one type-agnostic walk over these fixed
 *     positions (see `collectRefs` in v4-validate.ts).
 *   - §8.2 stored-vs-derived: store choices + structure only. Names, headers, default layout,
 *     capability sets, availability, timezone are all DERIVED at render, never stored.
 *   - Layout = child order + optional `size:{columns:1–12}` on a 12-col grid + group flex. No (x,y).
 *
 * This module is PURE TYPES (no zod, client-safe). Runtime validation/normalization lives in
 * v4-validate.ts; the v3→v4 rewriter in v3-to-v4.ts. Refs are the branded `AreaId`/`DeviceId` from
 * lib/ids — the security invariant is expressed in the type, not just prose.
 *
 * DARK: the v3 app does not read `dashboards.doc`; this ships behind the unchanged renderer.
 */
import type { AreaId, DeviceId } from "@/lib/ids";
import type { CardType } from "./card-types";

export const DASHBOARD_DOC_VERSION = 4 as const;

/** A node's local id — an opaque `n_…` string, NOT a scope-bearing TypeID (§8.3). Assigned by
 *  `normalizeDocV4` when absent, so it is optional on input and PRESENT on any normalized/stored doc. */
export type NodeId = string;

/** Optional 12-column grid sizing hint. */
export interface NodeSize {
  columns?: number; // 1–12
}

interface NodeBase {
  /** Present after normalizeDocV4 (server-assigned when absent). Stable across saves (drag-drop key). */
  id?: NodeId;
  /** Envelope-only scope binding, inherited downward (§8.3). */
  area?: AreaId;
  /** Envelope-only scope binding, inherited downward (§8.3). */
  device?: DeviceId;
  hidden?: boolean;
  size?: NodeSize;
}

/** A first-class flex layout node. A group with `area`+`heading` is a v3 "section"; a `row` group is
 *  a v3 "tiles" card. */
export interface GroupNode extends NodeBase {
  kind: "group";
  direction?: "row" | "column"; // default "column" (clean-sheet §15 decision)
  wrap?: boolean;
  heading?: boolean; // render the bound area's header (default for an area-bound section group)
  children: DashboardNode[];
}

/** The leaf. `type` is an open string; `config` is validated per known type (§8.4). */
export interface CardNode extends NodeBase {
  kind: "card";
  type: CardType;
  config?: unknown; // per-type; validated by v4-validate. Never holds scope refs (§8.3).
}

export type DashboardNode = GroupNode | CardNode;

/** The whole document, as stored in `dashboards.doc`. `root` is always a group. */
export interface DashboardV4 {
  version: 4;
  root: GroupNode;
}

/** An empty document — a bare root group with no children (mirrors `emptyDashboardV3`). */
export function emptyDashboardV4(): DashboardV4 {
  return {
    version: DASHBOARD_DOC_VERSION,
    root: { kind: "group", direction: "column", children: [] },
  };
}

/** Narrowing helpers. */
export function isGroupNode(n: DashboardNode): n is GroupNode {
  return n.kind === "group";
}
export function isCardNode(n: DashboardNode): n is CardNode {
  return n.kind === "card";
}

/**
 * Cheap runtime guard for a v4 document (mirrors `isDashboardV3`) — used to branch the dual-shape
 * render window. Full structural validation is `validateDocV4` (v4-validate.ts).
 */
export function isDashboardV4(x: unknown): x is DashboardV4 {
  if (typeof x !== "object" || x === null) return false;
  const doc = x as { version?: unknown; root?: unknown };
  if (doc.version !== 4) return false;
  const root = doc.root as { kind?: unknown } | null;
  return typeof root === "object" && root !== null && root.kind === "group";
}

/**
 * Depth-first pre-order walk over every node in a doc (root first). Pure; used by validation,
 * normalization, ref-collection, and the rewriter's structural checks.
 */
export function walkNodes(
  doc: DashboardV4,
  visit: (node: DashboardNode, depth: number) => void,
): void {
  const recur = (node: DashboardNode, depth: number): void => {
    visit(node, depth);
    if (node.kind === "group") {
      for (const child of node.children) recur(child, depth + 1);
    }
  };
  recur(doc.root, 1);
}

/**
 * How many LEAF CARD nodes a document holds — "how much is on this dashboard", for the dashboard
 * list and the admin table. Groups are structure, not content, so they are not counted; the walk is
 * over the whole tree, so a card nested inside a `row` inside a section group still counts once.
 *
 * config-v4 Phase 14 stage 15: this replaces `allCardsV3(descriptor).length`. The v3 count went to
 * zero for every dashboard created after the v4 cutover, because the seed is written to `doc` while
 * `descriptor` stayed empty (measured at stage 13 on `/admin/dashboards`).
 */
export function countCardNodes(doc: DashboardV4): number {
  let n = 0;
  walkNodes(doc, (node) => {
    if (node.kind === "card") n++;
  });
  return n;
}
