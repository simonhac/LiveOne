/**
 * Rendering a referential-integrity refusal for a human.
 *
 * Client-safe by construction: the `Dependent` type is imported with `import type`, which is erased
 * at compile time, so nothing here drags the finders (and their database imports) into a bundle.
 *
 * ## Why this is shared rather than inlined at each call site
 *
 * The refusal's entire value is the LIST — `via`, `effect` and `fix` per dependent. Both delete
 * dialogs originally rendered `body.error` alone, which is the sentence "still relied upon by 3
 * thing(s)": exactly the anonymous count this whole mechanism was built to replace, delivered at
 * the one place a person actually meets it. A shared renderer is what stops the next call site
 * repeating that.
 */
import type { Dependent } from "./relied-upon";

interface ReliedUponBody {
  error?: unknown;
  detail?: { code?: unknown; dependents?: unknown };
}

/** The dependents in a 409 body, or null if this is some other refusal. */
export function reliedUponDependents(body: unknown): Dependent[] | null {
  const b = body as ReliedUponBody | null;
  if (!b || typeof b !== "object") return null;
  if (b.detail?.code !== "relied-upon") return null;
  const deps = b.detail?.dependents;
  return Array.isArray(deps) && deps.length > 0 ? (deps as Dependent[]) : null;
}

/**
 * A multi-line message naming what would break, or `null` when the body is not a relied-upon
 * refusal (so a caller can fall back to `body.error` for a slug collision, a 403, anything else).
 *
 * Render it with `whitespace-pre-line`, or the newlines collapse and the list becomes a run-on
 * sentence — which is most of the way back to the count it replaced.
 */
export function reliedUponMessage(body: unknown): string | null {
  const deps = reliedUponDependents(body);
  if (!deps) return null;
  const lines = deps.map((d) => {
    const name = d.name ? ` “${d.name}”` : "";
    return `• ${d.kind}${name} — ${describeEffect(d.effect)}`;
  });
  return [`This would affect ${deps.length} thing(s):`, ...lines].join("\n");
}

/** The `effect` vocabulary in words a person can act on rather than a schema term. */
function describeEffect(effect: Dependent["effect"]): string {
  switch (effect) {
    case "silently-dropped":
      return "it references this, and would render nothing";
    case "cleared":
      return "their setting would be emptied";
    case "dangles":
      return "it would point at nothing";
    case "cascade-deleted":
      return "it would be deleted too";
    case "loses-access":
      return "they would lose access";
  }
}
