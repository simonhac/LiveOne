/**
 * The RAW-JSON reference walker over a dashboard doc — the third of three, and deliberately so.
 *
 * ## Why there are three, and why none may replace another
 *
 * - `walkNodes` (`lib/dashboard/v4.ts`) is the structural DFS every typed reader shares.
 * - `collectRefs` (`lib/dashboard/v4-validate.ts`) walks the TYPED §8.3 envelope, and every one of
 *   its callers fails **closed**: `dashboardAreaUuids`, `resolveScope`/`allowedSystemIds` and
 *   `checkDocRefsReadable` all treat a doc that fails `isDashboardV4` as referencing NOTHING,
 *   because for authorization that is the safe direction — an unresolvable dashboard authorizes
 *   nothing and an undecodable ref narrows the scope rather than widening it.
 * - `scanDocRefs` (here) walks RAW JSON and fails **open**. It is used to answer "what would break
 *   if this went away", and for that question the closed reading is exactly wrong: a doc that fails
 *   the shape guard still renders refs a human sees, and dropping them makes a delete look safe
 *   when it is not. It also sees refs in positions the typed walker does not model — which is the
 *   point, because a stored doc can be older than the type.
 *
 * So: authorization uses the typed walker, impact analysis uses this one. Collapsing them would
 * either make authorization fail open (a hole) or make impact analysis fail closed (a lie).
 *
 * 🛑 It walks KEYS (`"area"` / `"device"`), never a substring scan of the serialised JSON — a
 * substring scan would also hit an id that happens to appear inside a label or a saved query.
 */

/** Every `ar_…` / `dv_…` a doc references, however deeply nested and whatever shape the doc is. */
export function scanDocRefs(doc: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (
        (k === "area" || k === "device") &&
        typeof v === "string" &&
        /^(ar|dv)_[0-9a-z]{26}$/.test(v)
      )
        found.add(v);
      else walk(v);
    }
  };
  walk(doc);
  return found;
}
