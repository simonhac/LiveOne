import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/health", // Health check endpoint for monitoring
  "/api/cron(.*)", // Cron endpoints have their own authentication via CRON_SECRET
  "/api/push(.*)", // Push endpoints authenticate via API key in request body
  "/api/observations(.*)", // QStash receiver — authenticates via QStash signature, not Clerk
  "/api/enphase-proxy", // Debug endpoint - WARNING: No access controls
  // All other routes including /api/data will require authentication
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

export default clerkMiddleware((auth, request) => {
  if (!isPublicRoute(request) && !hasAccessToken(request)) {
    // Use protect() without await for better Edge performance
    // This still protects the route but doesn't block the middleware
    auth.protect();
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
