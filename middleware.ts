import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/health", // Health check endpoint for monitoring
  "/api/cron(.*)", // Cron endpoints have their own authentication via CRON_SECRET
  "/api/push(.*)", // Push endpoints authenticate via API key in request body
  "/api/observations(.*)", // QStash receiver — authenticates via QStash signature, not Clerk
  "/api/auth(.*)", // Vendor OAuth (Tesla/Enphase) connect/callback/disconnect — the vendor redirect carries no Clerk session; handlers enforce userId themselves
  "/api/enphase-proxy", // Debug endpoint - WARNING: No access controls
  // All other routes (pages + APIs) require Clerk auth, except share links (?access=, below)
]);

// When a request carries an `?access=<token>` query param, we let it through
// without Clerk-enforced auth. The destination route (page or API) is then
// responsible for validating the token against the share_tokens table and
// granting view-only access. An invalid token results in the same redirect
// as an unauthenticated request, just one layer deeper.
function hasAccessToken(request: Request): boolean {
  const url = new URL(request.url);
  return url.searchParams.has("access");
}

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request) && !hasAccessToken(request)) {
    // AWAIT is load-bearing: an un-awaited protect() is a no-op — it throws a
    // floating NEXT_HTTP_ERROR_FALLBACK;404 (logged, never blocks) and the request
    // proceeds, leaving enforcement entirely to the route handlers. Awaiting makes
    // the middleware actually block unauthenticated requests at the edge.
    //
    // Everything not allow-listed above is gated: all pages and all non-public
    // APIs. The public list covers the self-authenticating inbound endpoints
    // (QStash signature, CRON_SECRET, push API key, vendor OAuth redirect); share
    // links are exempted via the ?access= bypass above.
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
