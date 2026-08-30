/**
 * Plain-text rendering of a v4 dashboard document tree — the human half of
 * `scripts/ops/dashboard/cli.ts` (`show`, and every mutation's dry-run preview).
 *
 * Pure and dependency-free so it is unit-testable and safe anywhere. One line per node:
 *
 *     n_0  group
 *       n_1  group row  area=ar_…  heading
 *         n_2  card solar
 *         n_3  card battery  cols=3  hidden
 *       n_4  card chart  config={"variant":"lines"}
 *
 * `markers` prefixes chosen nodes with a two-char column (`+ `, `- `, `* `) for mutation previews;
 * unmarked lines get two spaces so the indentation stays aligned.
 */
import { findNode } from "./node-ops";
import { type DashboardNode, type DashboardV4, type NodeId } from "./v4";

const CONFIG_PREVIEW_MAX = 60;

export interface RenderTreeOptions {
  /** Render only this node's subtree (default: the whole doc from root). */
  nodeId?: NodeId;
  /** Per-node one-char markers, e.g. `new Map([["n_3", "+"]])`. */
  markers?: ReadonlyMap<NodeId, string>;
}

function describeNode(node: DashboardNode): string {
  // Head (what the node IS) joined by single spaces; annotations by double, so scanning columns
  // of `area=` / `cols=` stays easy.
  const head: string[] = [];
  if (node.kind === "group") {
    head.push("group");
    if (node.direction) head.push(node.direction);
    if (node.wrap) head.push("wrap");
    if (node.heading) head.push("heading");
  } else {
    head.push("card", node.type);
  }
  const annotations: string[] = [];
  if (node.area) annotations.push(`area=${node.area}`);
  if (node.device) annotations.push(`device=${node.device}`);
  if (node.size?.columns !== undefined) {
    annotations.push(`cols=${node.size.columns}`);
  }
  if (node.hidden) annotations.push("hidden");
  if (node.kind === "card" && node.config !== undefined) {
    let json = JSON.stringify(node.config);
    if (json.length > CONFIG_PREVIEW_MAX) {
      json = `${json.slice(0, CONFIG_PREVIEW_MAX)}…`;
    }
    annotations.push(`config=${json}`);
  }
  return [head.join(" "), ...annotations].join("  ");
}

/** Render a doc (or one subtree of it) as indented text, one node per line. */
export function renderDocTree(
  doc: DashboardV4,
  opts: RenderTreeOptions = {},
): string {
  let start: DashboardNode = doc.root;
  if (opts.nodeId !== undefined) {
    const found = findNode(doc, opts.nodeId);
    if (!found) return `(no node "${opts.nodeId}")`;
    start = found.node;
  }
  const lines: string[] = [];
  const recur = (node: DashboardNode, indent: number): void => {
    const marker = (node.id && opts.markers?.get(node.id)) || " ";
    lines.push(
      `${marker} ${"  ".repeat(indent)}${node.id ?? "(no id)"}  ${describeNode(node)}`,
    );
    if (node.kind === "group") {
      for (const child of node.children) recur(child, indent + 1);
    }
  };
  recur(start, 0);
  return lines.join("\n");
}
