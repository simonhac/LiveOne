/**
 * config-v4 "add an area to a dashboard" — the pure half of `components/AddAreaDialog`.
 *
 * The dialog is the LAST authoring surface in the app, and as of Phase 14 stage 14 it writes the v4
 * document (`PUT /api/v4/dashboards/{db_…}` with `If-Match`) instead of the v3 `descriptor`. The
 * splice, the already-on-the-dashboard filter, the has-any-cards test and the error wording live here
 * rather than in the component because `components/` is NOT a jest root (config-v4 Phase 14 finding:
 * a test placed there is silently not collected).
 */
import { collectRefs } from "./v4-validate";
// stripNodeIds moved to node-ops.ts (the structural-op module) when the dashboard CLI landed; its
// 🛑-NOT-optional rationale (duplicate-node-id 422 on the SECOND add) travels with it.
import { stripNodeIds } from "./node-ops";
import { walkNodes, type DashboardV4, type GroupNode } from "./v4";

/**
 * Append a seed group to the document's root children — the whole of "add an area" in the v4 model
 * (the v3 analogue was `descriptor.sections.push(section)`). Pure: the input doc is not mutated, so a
 * failed `PUT` leaves the caller's rendered tree untouched.
 */
export function appendGroupToDoc(
  doc: DashboardV4,
  group: GroupNode,
): DashboardV4 {
  return {
    ...doc,
    root: {
      ...doc.root,
      children: [...doc.root.children, stripNodeIds(group) as GroupNode],
    },
  };
}

/**
 * The `ar_…` refs a document already carries — the v4 replacement for `sectionAreaIdsV3`. Uses the
 * §8.3 envelope walk (`collectRefs`), so it sees an area bound at ANY depth, not just at a top-level
 * "section"; both the add-area picker's exclusion filter and the settings dialog's recompute list want
 * that superset.
 */
export function docAreaRefs(doc: DashboardV4): string[] {
  return collectRefs(doc).areas;
}

/**
 * Does the document contain at least one `card` node? Drives the empty-dashboard state. Deliberately
 * NOT `root.children.length > 0`: a doc can hold groups that contain nothing renderable, and such a
 * dashboard still needs the "add an area" way forward.
 */
export function docHasCards(doc: DashboardV4): boolean {
  let found = false;
  walkNodes(doc, (n) => {
    if (n.kind === "card") found = true;
  });
  return found;
}

/**
 * Human wording for a failed `PUT /api/v4/dashboards/{id}`. The v4 surface answers 422 with
 * `{errors: [{path, code, message}]}` (NOT `{error}`), so a naive `body.error ?? "…"` would swallow a
 * validation failure into a generic message; 403/409/500 carry `{error}`.
 */
export function describeDocWriteError(status: number, body: unknown): string {
  const b = (body ?? {}) as {
    error?: unknown;
    errors?: { path?: string; message?: string }[];
  };
  if (status === 422 && Array.isArray(b.errors) && b.errors.length > 0) {
    const first = b.errors[0];
    return `The dashboard document was rejected: ${first?.message ?? "invalid"}${
      first?.path ? ` (at ${first.path})` : ""
    }`;
  }
  if (typeof b.error === "string" && b.error) return b.error;
  return "Could not add the area";
}
