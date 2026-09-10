/**
 * `liveone dashboard share` (named users) and `liveone dashboard link` (anonymous links).
 *
 * 🛑 Both grant READ access that is scoped LIVE to the dashboard document's refs, never to a
 * snapshot taken when the grant was made — so editing a doc re-aims every grant and every live link
 * on it. Sharing a dashboard is therefore a statement about a document, not about a fixed set of
 * devices, and that is the single most surprising thing about this surface.
 *
 * 🛑 `PUT …/grants` is a declarative full replace: `{members: []}` revokes everyone. `add`/`remove`
 * are read-modify-write for that reason, and print a diff whose *kept* count is the assertion.
 */
export { SHARE_SPEC, LINK_SPEC, DELETE_SPEC } from "./spec";
export { SHARING_HANDLERS } from "./handlers";
