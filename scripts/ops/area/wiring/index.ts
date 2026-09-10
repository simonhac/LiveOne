/**
 * `liveone area devices` and `liveone area role` — §2 of `docs/plans/ops-cli-queue-and-vendor-sync.md`.
 *
 * The verbs that were missing on 2026-09-09, when wiring a new area could only be done by
 * hand-driving a logged-in browser. They deliberately drop the table names from the operator's
 * vocabulary: `area_members` becomes **devices** (which devices are in the area) and `area_bindings`
 * becomes **role** (which point fills an area's `(role, metric)` slot, and in what order).
 *
 * 🛑 **A binding is not point metadata.** It is AREA-SCOPED ROLE RESOLUTION: "in *this* area, the
 * `grid/rate` slot is filled by *these* points, in this order". The same point can be bound in one
 * area and unbound in another, and the point itself is untouched either way. Units, display
 * precision and labels are the display registry — a different system, deliberately not reachable
 * from here.
 *
 * 🛑 **The routes are FULL REPLACE; these verbs are INCREMENTAL.** `PUT …/members` and
 * `PUT …/bindings` each take the whole collection and diff it server-side. An operator does not
 * think that way — they think "bind grid/rate to these three points" — so every writer reads the
 * current collection, changes the one thing it was asked to change, and PUTs the whole thing back.
 * Getting that wrong does not error; it SILENTLY DELETES everything the caller did not mention,
 * which is how a wiring session destroys an area's provenance card.
 *
 * Split by role rather than kept as one file:
 *   `model.ts`    wire shapes, loading, reference resolution, the pure slot rewrite
 *   `render.ts`   how a change is stated to an operator
 *   `client.ts`   the two PUTs, and what their failures mean
 *   `spec.ts`     the two command trees
 *   `handlers.ts` the verbs themselves
 */
export { DEVICES_SPEC, ROLE_SPEC } from "./spec";
export { WIRING_HANDLERS } from "./handlers";
export {
  resolvePoint,
  rewriteSlot,
  type PointCandidate,
  type WireBinding,
  type WireMember,
} from "./model";
