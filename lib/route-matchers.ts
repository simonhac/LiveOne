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
  "/api/observations(.*)", // QStash receiver — authenticates via QStash signature, not Clerk
  "/api/auth(.*)", // Vendor OAuth (Tesla/Enphase) connect/callback/disconnect — the vendor redirect carries no Clerk session; handlers enforce userId themselves
  "/api/enphase-proxy", // Debug endpoint - WARNING: No access controls
  // All other routes (pages + APIs) require Clerk auth, except share links (?access=, below)
];

// Internal card gallery (app/labs/card-gallery): a no-login visual harness for inspecting
// dashboard cards at many sizes. Public on dev + Vercel preview only — NEVER in production
// (VERCEL_ENV is "production" there; unset locally, "preview" on preview deploys). The page
// itself also notFound()s in prod as defense-in-depth.
if (process.env.VERCEL_ENV !== "production") {
  publicRoutes.push("/labs/card-gallery(.*)");
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
// Note the trailing slashes: `/api/system/(.*)` matches `/api/system/1/...` but NOT the plural
// `/api/systems` (admin), and `/api/dashboard(.*)` covers both `/api/dashboard/...` and
// `/api/dashboard-share/...`.
const shareableRoutes = [
  "/dashboard(.*)", // the shared dashboard page (validates the token server-side)
  "/api/data", // live values + readings — requireDashboardAccess
  "/api/history", // time series — requireDashboardAccess
  "/api/energy-flow-matrix", // sankey — requireDashboardAccess
  "/api/dashboard(.*)", // saved descriptor (GET) + /api/dashboard-share/[token] consume
  "/api/system/(.*)", // per-system read endpoints the cards use (latest, run-periods)
];

export const isShareableRoute = createRouteMatcher(shareableRoutes);

// Presence-only check for the `?access=<token>` share-link query param. The token is NOT validated
// here — middleware.ts only honours it on a share-eligible route (isShareableRoute) for a GET/HEAD
// request, and the destination handler validates it via `requireDashboardAccess`.
export function hasAccessToken(request: Request): boolean {
  const url = new URL(request.url);
  return url.searchParams.has("access");
}
