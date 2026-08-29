/**
 * Remove card nodes from a stored dashboard document — the data half of "take that card off my
 * dashboard". See `docs/migrations.md` § "Data & config-document migrations".
 *
 * A layout is DATA. Deleting a card from a dashboard is not a code change; it is an edit to the
 * `dashboards.doc` jsonb, and it has to be applied to prod (the 2-hourly sync refreshes dev).
 *
 * 🛑 SCOPE: removes whole `card` nodes matched by `type`, and nothing else. Groups are left in
 * place even when they empty out — a group carries layout intent (`direction`, `wrap`, a heading,
 * an `area` binding) that is not the removed card's to discard, and an empty group renders as
 * nothing anyway. Pruning empty groups is a separate decision; make it deliberately, not as a side
 * effect of deleting a card.
 */
import type { DashboardNode, DashboardV4, GroupNode } from "./v4";

export interface CardRemoval {
  /** The rewritten document. A fresh object graph — the input is never mutated. */
  doc: DashboardV4;
  /** Path of each removed node, e.g. `root.children[0].children[0].children[3] (n_6)`. */
  removed: string[];
}

/**
 * Remove every `card` node whose `type` is in `types`.
 *
 * Pure and idempotent: the input doc is not mutated, unchanged subtrees are structurally shared,
 * and a second run over the result reports zero removals.
 */
export function removeCardsByType(
  doc: DashboardV4,
  types: readonly string[],
): CardRemoval {
  const wanted = new Set(types);
  const removed: string[] = [];

  function label(node: DashboardNode, path: string): string {
    const id = (node as { id?: unknown }).id;
    return typeof id === "string" ? `${path} (${id})` : path;
  }

  function visitGroup(group: GroupNode, path: string): GroupNode {
    const kept: DashboardNode[] = [];
    let changed = false;

    group.children.forEach((child, i) => {
      const childPath = `${path}.children[${i}]`;
      if (child.kind === "card" && wanted.has(child.type)) {
        removed.push(label(child, childPath));
        changed = true;
        return; // dropped
      }
      if (child.kind === "group") {
        const next = visitGroup(child, childPath);
        if (next !== child) changed = true;
        kept.push(next);
        return;
      }
      kept.push(child);
    });

    return changed ? { ...group, children: kept } : group;
  }

  const root = visitGroup(doc.root, "root");
  return {
    doc: root === doc.root ? doc : { ...doc, root },
    removed,
  };
}
