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

// When a request carries an `?access=<token>` query param, we let it through
// without Clerk-enforced auth. The destination route (page or API) is then
// responsible for validating the token against the share_tokens table and
// granting view-only access. An invalid token results in the same redirect
// as an unauthenticated request, just one layer deeper. NOTE: this is a
// presence-only check — the token is NOT validated here.
export function hasAccessToken(request: Request): boolean {
  const url = new URL(request.url);
  return url.searchParams.has("access");
}
