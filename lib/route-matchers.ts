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
  "/api/health", // Health check endpoint for monitoring
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
  // tree; everything else there is owner-facing management. (The legacy `/api/areas/(.*)`
  // twin of this line went with its route in Phase 14 stage 13 — the panel's client moved in the same
  // commit, so nothing anonymous is left addressing the old path.)
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
