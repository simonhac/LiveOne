import { createRouteMatcher } from "@clerk/nextjs/server";

// The Clerk middleware allow-list + the share-link bypass, factored out of
// middleware.ts so they can be unit-tested directly (middleware.ts itself can't
// be imported in a test without the Edge runtime). See
// lib/__tests__/route-matchers.test.ts.
//
// Routes here bypass Clerk's `auth.protect()` because they either need no auth or
// authenticate by other means (CRON_SECRET, push API key, QStash signature, the
// vendor OAuth redirect). Everything NOT listed is gated by the middleware.
const publicRoutes = [
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/.well-known(.*)", // Tesla partner public key (.pem) — Tesla fetches it unauthenticated
  "/api/collectors/me/config", // dedicated collector bearer authentication in-handler
  "/api/collectors/me/credentials",
  "/api/collectors/me/status",
  "/api/collectors/me/baseline",
  "/api/collectors/me/production",
  "/api/health", // Health check endpoint for monitoring
  "/api/health/devices", // per-device poll health for an external monitor — gated by X-Health-Key, not Clerk
  "/api/cron(.*)", // Cron endpoints have their own authentication via CRON_SECRET
  "/api/push(.*)", // Push endpoints authenticate via API key in request body
  "/api/gush(.*)", // gusher generic push receiver — authenticates via API key in request body
  "/api/observations(.*)", // QStash receiver — authenticates via QStash signature, not Clerk
  "/api/auth(.*)", // Vendor OAuth (Tesla/Enphase) connect/callback/disconnect — the vendor redirect carries no Clerk session; handlers enforce userId themselves
  "/api/enphase-proxy", // Debug endpoint - WARNING: No access controls
  // Battery-provenance ops endpoints: authorize owner/admin OR a CRON_SECRET bearer IN-HANDLER
  // (getAuthContext → early 401 for anon). Public-listed so a headless CRON_SECRET call reaches the
  // handler instead of being 404'd at the edge by auth.protect() (same rationale as /api/cron). These
  // are SURGICAL (specific suffixes) so the sibling v4 area mutation/CRUD routes — POST /api/v4/areas,
  // PATCH/DELETE /api/v4/areas/{id}, PUT …/members, PUT …/bindings — stay Clerk-gated.
  //
  // The three legacy `/api/areas/...` twins that used to sit here went with the legacy tree (Phase 14
  // stage 13). They were never redundant with these: the middleware runs BEFORE next.config's rewrites
  // and matches the ORIGINAL path, so `/api/v4/...` is simply a different path and inherited nothing
  // from them — which is also why removing them cannot affect these.
  // The CLI hand-off exchange: self-authenticating on a code this server signed plus the PKCE
  // verifier, with no session by design (the CLI has no cookie — that is the problem being solved).
  // Same rationale as /api/cron: public-listed so a headless call reaches the handler that can
  // actually check its credential, instead of being 404'd at the edge.
  //
  // 🛑 ONLY `exchange`. `/api/cli-auth/authorize` is deliberately NOT here: it is what BINDS a code
  // to a user, so it must require a real browser session.
  "/api/cli-auth/exchange",
  "/api/v4/areas/(.*)/recompute-provenance",
  "/api/v4/areas/(.*)/provenance-summary",
  "/api/v4/areas/by-handle/(.*)",
  // All other routes (pages + APIs) require Clerk auth, except share links (?access=, below)
];

// Internal galleries (app/labs/card-gallery, app/labs/chart-gallery): no-login visual harnesses —
// dashboard cards at many sizes, and the time-series charts rendered from deterministic fixtures for
// the Playwright screenshot baselines. Public on dev + Vercel preview only — NEVER in production
// (VERCEL_ENV is "production" there; unset locally, "preview" on preview deploys). Both pages also
// notFound() in prod as defense-in-depth.
if (process.env.VERCEL_ENV !== "production") {
  publicRoutes.push("/labs/card-gallery(.*)");
  publicRoutes.push("/labs/chart-gallery(.*)");
}

export const isPublicRoute = createRouteMatcher(publicRoutes);

// Routes a valid `?access=` share token may reach WITHOUT a Clerk session: the read-only shared
// dashboard PAGE plus the read-only data endpoints its cards fetch (see lib/queries/*). This list
// BOUNDS where the presence-only `?access=` bypass may apply — so a stray/garbage token can never skip
// auth on admin, test, or mutation routes (those stay Clerk-gated). The token is still validated
// downstream by `requireDashboardAccess`; this is only the edge fail-closed boundary, paired with a
// GET/HEAD-only check in middleware.ts (a share token never authorizes a write). Add a route here only
// after confirming its handler validates the token and exposes nothing beyond the dashboard's scope.
//
// Note the trailing slash: `/api/device/(.*)` matches `/api/device/1/...` but NOT the plural
// `/api/devices` (admin). The composition dashboard doc is resolved server-side in page.tsx (never
// client-fetched in the shared view), so no `/api/dashboard(.*)` entry is needed — and keeping it out
// also stops it over-matching the `/api/v4/dashboards` CRUD (which stays Clerk-gated; a share token
// that could mint or relabel tokens would be a self-extending credential).
const shareableRoutes = [
  "/dashboard(.*)", // the shared dashboard page (validates the token server-side)
  "/api/data", // live values + readings — requireDashboardAccess
  "/api/history", // time series + sankey (?include=sankey) — requireDashboardAccess
  "/api/device/(.*)", // per-device read endpoints the cards use (latest, run-periods)
  // The battery-provenance history panel — `requireDashboardAccess`. It belongs HERE rather than in
  // publicRoutes because its caller is an anonymous `?access=` viewer, not a CRON_SECRET bearer: a
  // publicRoutes entry would hand every unauthenticated request past the edge, where the handler's own
  // share-token check is the only thing left. Deliberately the ONLY shareable route on the /api/v4
  // tree; everything else there is owner-facing management.
  "/api/v4/areas/(.*)/provenance-daily",
];

export const isShareableRoute = createRouteMatcher(shareableRoutes);

// Presence-only check for the `?access=<token>` share-link query param. The token is NOT validated
// here — middleware.ts only honours it on a share-eligible route (isShareableRoute) for a GET/HEAD
// request, and the destination handler validates it via `requireDashboardAccess`.
export function hasAccessToken(request: Request): boolean {
  const url = new URL(request.url);
  return url.searchParams.has("access");
}

// ---------------------------------------------------------------------------
// Calendar feed tokens
// ---------------------------------------------------------------------------

// The subscribable `.ics` feed, and ONLY it. A calendar client fetches this unattended for years
// with no way to sign in, so the URL is the whole credential — the same deliberate security
// decision as a share link, and bounded the same way: this list is the edge boundary, middleware
// honours it for GET/HEAD only, and the handler validates the token AND checks it belongs to the
// area in the path.
//
// 🛑 Deliberately NOT added to `shareableRoutes`. That list is documented as
// "the handler authorizes with requireDashboardAccess", and this handler does not — it has its own
// token table with its own predicate. Sharing the matcher would mean a dashboard share token could
// try this route and a calendar token could try `/api/data`; each is refused downstream, but the
// boundary would no longer say which credential belongs where.
// 🛑 `:id`, a NAMED SINGLE segment — never `(.*)`, which matches slashes. This is the convention
// this file states for the `/api/v4/areas/…` tree, and it is the difference between bypassing
// `auth.protect()` for ONE route and pre-authorizing every route anyone nests under `areas/` later.
// `/api/v4/areas/a/b/c/calendar.ics` matched the wildcard form; it 404s at Next today, which is
// exactly the kind of "harmless" that stops being harmless the day the path exists.
const calendarFeedRoutes = ["/api/v4/areas/:id/calendar.ics"];

export const isCalendarFeedRoute = createRouteMatcher(calendarFeedRoutes);

// Presence-only, like `hasAccessToken`. The token is validated by the handler.
export function hasFeedToken(request: Request): boolean {
  return new URL(request.url).searchParams.has("token");
}

// ---------------------------------------------------------------------------
// CLI tokens
// ---------------------------------------------------------------------------

// Routes an operator CLI may reach with an `Authorization: Bearer lo_cli_…` token instead of a
// Clerk session cookie. This list BOUNDS the edge bypass below, exactly as `shareableRoutes` bounds
// the `?access=` one — a stray `lo_cli_` bearer can never skip the edge on admin, control or
// vendor routes.
//
// 🛑 THESE ARE NOT PUBLIC ROUTES, and must never be moved into `publicRoutes`. The bypass is
// PRESENCE-ONLY: it declines to 404 a request that *claims* to be a CLI request, and the handler's
// own `requireAuth`/`loadOwnedDashboard` is the single enforcement point — `getAuthContext`
// resolves the token there and yields `userId: null` for anything invalid, which is a clean 401.
// Every handler under this matcher MUST authorize; adding a route here without checking that is
// how a bypass becomes a hole.
//
// Why bypass at the edge at all: `auth.protect()` REWRITES an unauthenticated /api request to a
// 404 before the handler runs, so a credential the handler understands never gets the chance to be
// understood. This is the same reason `/api/cron` and `/api/gush` are listed elsewhere.
const cliTokenRoutes = [
  // Enrollment and assignment management still requireAdmin in both helpers.
  "/api/admin/collectors",
  "/api/admin/pollers",
  "/api/admin/pollers/:pollerId",
  "/api/v4/dashboards(.*)", // the dashboard CLI
  "/api/v4/devices(.*)", // device list + per-device aggregate — every handler requireAuth's
  // One session and its manifest, for `liveone session show`. A NAMED segment, never `(.*)`: there
  // is no session collection at this address and nothing under it, so there is nothing to inherit
  // the bypass by being a sibling.
  //
  // Read-only, and it is the answer to "this reading has session_id X — where did X come from?".
  // Addressed by session id alone because that is the only thing the asker holds; requiring them to
  // already know the device would make the answer reachable only by those who did not need it.
  //
  // 🛑 The authorization is on the session's DEVICE, not on the session — a session is a fact about
  // that device's data, not a separately grantable object — and `requireDeviceAccess` failing
  // collapses into the same 404 as "no such session", so the URL is not an existence oracle over
  // other owners' session ids. Minting one stays under `/api/v4/devices/:id/sessions`, which is
  // already inside the `devices(.*)` bypass above and is where the write belongs.
  "/api/v4/sessions/:sessionId",
  "/api/v4/areas", // the readable-areas list — requireAuth (POST create authorizes the same way)
  // The area aggregate — a NAMED single segment, deliberately NOT `(.*)`: the sub-resources
  // (members, bindings, derivations, eligibility, by-handle, …) stay OUTSIDE the bypass until each
  // is judged on its own, rather than inheriting it by being a sibling.
  "/api/v4/areas/:id",
  // Judged on its own (the first sub-resource to be): both GET and POST authorize in-handler via
  // `loadAreaForOwner`. Again named segments, never `(.*)` — `members` and `bindings` stay outside.
  "/api/v4/areas/:id/derivations",
  // The per-derivation surface, admitted when `liveone derivation` was written (it is the whole
  // point of that domain: enable/disable, recompute, read back). All three authorize through
  // `loadDerivationForOwner` → `loadAreaForOwner`, and each puts the AREA in its WHERE clause, so
  // the area's owner-or-admin check genuinely covers the derivation rather than merely preceding it.
  //
  // `recompute` is the one worth pausing on: it is a delete-and-reinsert, and admitting a route that
  // rewrites history is a real widening. It is safe here because the derivation is a PATH SEGMENT —
  // there is no unscoped form to reach, unlike `/api/cron/derivations`, whose filter is optional and
  // which stays outside this bypass.
  "/api/v4/areas/:id/derivations/:dxid",
  "/api/v4/areas/:id/derivations/:dxid/recompute",
  "/api/v4/areas/:id/derivations/:dxid/intervals",
  // The same resource at its own address, which is where it now lives: a derivation's site is
  // DERIVED from its source points, so there is no area to address it by and the four routes above
  // are shims onto these. Named segments, never `(.*)`, exactly as the area tree is.
  //
  // 🛑 The authorization argument CHANGED with the address, and it got stronger. The old one was
  // "each puts the AREA in its WHERE clause, so the area's owner check covers the derivation" — a
  // property of a clause someone could forget to write. These routes authorize against the
  // derivation's OWN device set (`lib/derivations/scope.ts`): write access is required on EVERY
  // device it touches, and an unreadable one is a 404 rather than a 403 so the URL is not an
  // existence oracle over `dx_` ids. There is no scope for the caller to name, so there is nothing
  // to forget.
  //
  // `recompute` is still the one worth pausing on — it is a delete-and-reinsert, and admitting a
  // route that rewrites history is a real widening. It is safe here for the same reason as before:
  // the derivation is a PATH SEGMENT, so there is no unscoped form to reach, unlike
  // `/api/cron/derivations`, whose filter is optional and which stays outside this bypass.
  //
  // 🛑 DELETE is admitted, and it is the first destructive verb on this domain. It is admissible
  // because it cannot be reached casually: the derivation must ALREADY be disabled (409
  // `derivation-enabled`, and `?force=true` does not waive it), and `refuseIfReliedUpon` then
  // names the intervals, the output point and any automation that would break. Two deliberate acts,
  // the first of which is reversible and observable.
  "/api/v4/derivations",
  "/api/v4/derivations/:dxid",
  "/api/v4/derivations/:dxid/recompute",
  "/api/v4/derivations/:dxid/intervals",
  // The two area sub-resources §2 of the ops-CLI plan named, admitted when `liveone area devices`
  // and `liveone area role` were written. Named segments, never `(.*)` — `eligibility`,
  // `by-handle`, `default-group`, `recompute-provenance` and the two `provenance-*` reads stay
  // outside until each is judged on its own, exactly as `members`/`bindings` did until now.
  //
  // Both writers authorize in-handler through `loadAreaForOwner`, the same owner-or-admin check
  // `derivations` uses, and the area is a PATH SEGMENT so there is no unscoped form to reach.
  //
  // 🛑 `members` is the widening to actually weigh, because its blast radius is larger than its
  // name: PUT is a full replace, and dropping a member also DELETES that member's bindings
  // (`replaceMembers`). So a careless membership write can blank an area's wiring, not merely its
  // device list. That is a property of the route, not of the credential — the browser has had it
  // all along — and it is why `liveone area devices` refuses to shrink membership without naming
  // the bindings that would go with it.
  "/api/v4/areas/:id/members",
  "/api/v4/areas/:id/bindings",
  // Read-only (`loadReadableArea`, GET only): the deterministic "what filled each slot, and how"
  // report. Admitted with the two writers because it is how an operator CHECKS a write landed —
  // separating them would leave the CLI able to change resolution and unable to see the result.
  "/api/v4/areas/:id/resolution",
  // The two RETIRE addresses — `liveone area purge`. Both authorize through `loadAreaForOwner`
  // (owner-or-admin, `requireAuth` underneath), and the area is a PATH SEGMENT, so there is no
  // unscoped form to reach — the property that made `derivations/:dxid/recompute` admissible.
  //
  // 🛑 Admitted HERE and deliberately NOT added to `publicRoutes`, which is where their materialising
  // sibling `recompute-provenance` lives so a headless `CRON_SECRET` can drive it. A verb that
  // DESTROYS does not need that door: `publicRoutes` admits anything holding the cron secret, while
  // this bypass is presence-only and still resolves to a real user the area must be owned by.
  //
  // 🛑 `flows` is the one to weigh, and it is worse than its neighbour. `point_readings_flow_attr_1d`
  // is the Sankey for EVERY complete area (`flow_1d` was retired into it), and deleting from it is
  // not cron-recoverable: `rehealStaleAttrDays` finds work by selecting FROM that table, so a deleted
  // day is not stale, it is absent, and only an explicit `recompute-provenance` over the range brings
  // it back. The route therefore REQUIRES `start`+`end` and returns the restore command it owes you.
  // `provenance` is the safe one by comparison — the learn rebuilds from a fixed anchor whenever its
  // table is empty, so deletion there is a supported operation rather than damage.
  "/api/v4/areas/:id/flows",
  "/api/v4/areas/:id/provenance",
  // The observations queue — `liveone queue`. A SEPARATE address from
  // `/api/admin/observations/info` precisely so this bypass does not have to widen to
  // `/api/admin`; the handler is `requireAdmin`, so a non-admin token 403s here.
  "/api/v4/queue",
  // Enumerated, NOT `/api/v4/queue(.*)` — the same posture as `cli-auth` below. `timing` is a
  // read-only forensic view (`requireAdmin`, GET only); a wildcard would pre-admit whatever verb
  // this domain grows next, including a mutating one.
  "/api/v4/queue/timing",
  "/api/v4/queue/outbox",
  // The vendor re-fetch — `liveone sync`. A JSON sibling of `/api/admin/amber-sync` (an SSE stream
  // shaped for a browser, and behind the admin edge), added rather than widening this bypass to
  // `/api/admin`. It authorizes in-handler through `requireDeviceAccess(..., { requireWrite: true })`,
  // so a token whose user does not own the device 403s — and the device is a PATH SEGMENT, so there
  // is no unscoped form to reach, the same property that made `derivations/:dxid/recompute` safe.
  "/api/v4/devices/:id/sync",
  "/api/v4/users(.*)", // the user directory — requireAdmin in-handler, so a non-admin token 403s there
  // The automations resource — `liveone automation`. Both handlers authorize: the collection
  // through `loadAreaForOwner` (owner-or-admin) plus `checkReferences`, which additionally requires
  // the caller to OWN the action point's device; the item through `loadOwnedAutomation`, which
  // collapses an unauthorized id to 404 so the route is not an oracle for which `au_` ids exist.
  //
  // 🛑 Second only to `ownership/transfer` in consequence, and for a different reason: an
  // automation is a DEFERRED command, so what is written here is dispatched LATER by the cron with
  // the device owner's vendor credentials and no session at all — and an `exercise` rule dispatches
  // `set_value` at a generator's run-request point, i.e. it starts an engine, unattended. That is
  // exactly why the create path's ownership check is `requireOwner` rather than `requireWrite`.
  //
  // Enumerated, NOT `/api/v4/automations(.*)` — the `areas/:id` precedent. Any sub-resource this
  // grows later is judged on its own rather than inheriting the bypass by being a sibling.
  "/api/v4/automations",
  "/api/v4/automations/:id",
  // Ownership transfer — `liveone owner transfer`. `requireAdmin` in-handler, so a non-admin token
  // gets past the edge and 403s there.
  //
  // 🛑 The most consequential entry in this list: it is the one route that can move an object OUT
  // of a user's control, and it writes devices, areas, dashboards and grants in one transaction.
  // It is admitted anyway because the alternative is worse — ownership was previously reachable
  // only through `/api/admin/devices/{id}/admin-settings`, one device at a time, from a browser,
  // with no share-back, which is how a site comes to be half-transferred. Enumerated, never
  // `/api/v4/ownership(.*)`: whatever this domain grows next is judged on its own.
  "/api/v4/ownership/transfer",
  // The card-data reads. Both are ALSO in `shareableRoutes`; the two presence-only bypasses compose
  // independently (each only declines to 404 its own credential shape) and the handler's
  // `requireDashboardAccess` is the enforcement point either way — a CLI token here reaches nothing
  // a browser session couldn't.
  "/api/data",
  "/api/history",
  "/api/cli-auth/tokens(.*)", // `auth list` / `auth revoke`, so a CLI can manage its own credential
  "/api/cli-auth/whoami", // the `target:` line — which deployment, as whom, against which database
  // Minting and revoking an area's calendar feed tokens, for `liveone calendar`. Owner-or-admin in
  // the handler (`loadAreaForOwner`); the FEED itself is not here, it has its own matcher above.
  "/api/v4/areas/:id/calendar-tokens",
  // 🛑 Enumerated, NOT `/api/cli-auth(.*)`. A wildcard would sweep in `authorize`, and a CLI token
  // must not be able to mint its own successor without a fresh human approval in a browser.
];

export const isCliTokenRoute = createRouteMatcher(cliTokenRoutes);

// Presence-only detection lives in lib/cli-auth/bearer.ts — CRYPTO-FREE on purpose, because this
// module is imported by middleware.ts on the EDGE runtime and the verification path
// (lib/cli-auth/verify.ts) uses node:crypto. Re-exported here so middleware has one import.
export { cliBearerToken, hasCliBearer } from "./cli-auth/bearer";
