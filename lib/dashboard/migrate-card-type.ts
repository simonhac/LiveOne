/**
 * Rename a card `type` across a stored dashboard document — the pure half of
 * `scripts/utils/migrate-card-type.ts`.
 *
 * WHY THIS EXISTS. A card `type` is **persisted** in `dashboards.doc`, so renaming one in code is a
 * data change, not just a code change. `type` is an open string, warn-not-reject (§8.4), so a document
 * left holding the old name still parses and still keeps its `config` — it just renders a labelled
 * placeholder (`Unknown card type …`). That is deliberate: the failure is visible and non-destructive.
 * But it IS a failure, and until this module there was no way to repair it — the `generator-runs` →
 * `runs` rename (PR #338) shipped code, catalog, seed and fixtures while the one prod document that
 * held the old name sat broken. See `docs/migrations.md` § "Data & config-document migrations".
 *
 * Lives in `lib/` rather than beside the script for the same reason as `add-area.ts`: `scripts/` is
 * not a jest root, so a test placed there is silently not collected.
 *
 * 🛑 SCOPE: this renames the `type` string and NOTHING else. `config` passes through verbatim, so it
 * is the right tool only when the new type accepts the old type's config — either because both are
 * bare, or because every added key has a schema default (`runsConfigSchema`'s `role` defaults to
 * `"generator"`, which is exactly what a pre-rename `generator-runs` doc meant). A rename that also
 * reshapes `config` needs a bespoke transform, not this.
 */
import type { DashboardNode, DashboardV4, GroupNode } from "./v4";

export interface CardTypeRewrite {
  /** The rewritten document. A fresh object graph — the input is never mutated. */
  doc: DashboardV4;
  /** Path of each rewritten node, e.g. `root.children[2].children[0]` (+ its `n_…` id when present). */
  changed: string[];
}

/**
 * Rewrite every `card` node whose `type` is `from` to `to`.
 *
 * Pure: the input doc is not mutated and unchanged subtrees are structurally shared, so a failed write
 * leaves the caller's rendered tree untouched (the `appendGroupToDoc` contract). Idempotent — a second
 * run over the result reports zero changes.
 *
 * The traversal mirrors `walkNodes`, but rebuilds rather than visits, because a rewrite has to
 * reconstruct the spine down to each changed leaf.
 */
export function rewriteCardType(
  doc: DashboardV4,
  from: string,
  to: string,
): CardTypeRewrite {
  const changed: string[] = [];

  const recur = (node: DashboardNode, path: string): DashboardNode => {
    if (node.kind === "card") {
      if (node.type !== from) return node;
      changed.push(node.id ? `${path} (${node.id})` : path);
      return { ...node, type: to };
    }
    const children = node.children.map((child, i) =>
      recur(child, `${path}.children[${i}]`),
    );
    // Structural sharing: an untouched subtree keeps its identity, which makes "did anything change?"
    // answerable by reference and keeps the rewrite allocation-light on a large doc.
    return children.every((c, i) => c === node.children[i])
      ? node
      : { ...node, children };
  };

  const root = recur(doc.root, "root") as GroupNode;
  return { doc: root === doc.root ? doc : { ...doc, root }, changed };
}
