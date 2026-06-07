import { clerkMiddleware } from "@clerk/nextjs/server";
import { isPublicRoute, hasAccessToken } from "@/lib/route-matchers";

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request) && !hasAccessToken(request)) {
    // AWAIT is load-bearing: an un-awaited protect() is a no-op — it throws a
    // floating NEXT_HTTP_ERROR_FALLBACK;404 (logged, never blocks) and the request
    // proceeds, leaving enforcement entirely to the route handlers. Awaiting makes
    // the middleware actually block unauthenticated requests at the edge.
    //
    // Everything not allow-listed (see lib/route-matchers.ts) is gated: all pages
    // and all non-public APIs. The public list covers the self-authenticating
    // inbound endpoints (QStash signature, CRON_SECRET, push API key, vendor OAuth
    // redirect); share links are exempted via the ?access= bypass above.
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
