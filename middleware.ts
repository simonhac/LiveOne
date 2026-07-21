import { clerkMiddleware } from "@clerk/nextjs/server";
import {
  NextResponse,
  type NextFetchEvent,
  type NextRequest,
} from "next/server";
import {
  isPublicRoute,
  isShareableRoute,
  hasAccessToken,
} from "@/lib/route-matchers";
import {
  MIDDLEWARE_DUR_HEADER,
  forwardRequestHeader,
} from "@/lib/server-timing";

const clerk = clerkMiddleware(async (auth, request) => {
  // A `?access=<token>` share link skips Clerk ONLY for a read-only (GET/HEAD) request to a
  // share-eligible route (isShareableRoute). The token is validated downstream by
  // requireDashboardAccess; this edge check is fail-closed — a stray/garbage token on any other route
  // (admin, test, mutations) still hits auth.protect(). A share token never authorizes a write.
  const method = request.method;
  const sharedRead =
    (method === "GET" || method === "HEAD") &&
    isShareableRoute(request) &&
    hasAccessToken(request);

  if (!isPublicRoute(request) && !sharedRead) {
    // AWAIT is load-bearing: an un-awaited protect() is a no-op — it throws a
    // floating NEXT_HTTP_ERROR_FALLBACK;404 (logged, never blocks) and the request
    // proceeds, leaving enforcement entirely to the route handlers. Awaiting makes
    // the middleware actually block unauthenticated requests at the edge.
    //
    // Everything not allow-listed (see lib/route-matchers.ts) is gated: all pages
    // and all non-public APIs. The public list covers the self-authenticating
    // inbound endpoints (QStash signature, CRON_SECRET, push API key, vendor OAuth
    // redirect); share links are exempted via the share-eligible ?access= bypass above.
    await auth.protect();
  }
});

// Server-Timing instrumentation (lib/server-timing.ts): time the WHOLE clerkMiddleware invocation
// and self-report it to the route handler, which reproduces it as the `mw` entry of its
// Server-Timing response header. The wrapper is load-bearing: Clerk runs `authenticateRequest`
// (session/JWT verification, JWKS fetch on cold instances) BEFORE invoking the callback above, and
// `auth.protect()` is only an in-memory check on that already-resolved state — timing inside the
// callback would read ~0 and misattribute the Clerk cost to invocation/network. Runs for EVERY
// matched route (public ones too — only protect() is conditional), so `mw` is comparable across
// routes. Forwarded as a REQUEST header (not a response Server-Timing header) so the route emits
// ONE merged header with no edge/origin same-name merge ambiguity.
export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  const mwStart = performance.now();
  const res = (await clerk(request, event)) ?? NextResponse.next();
  forwardRequestHeader(
    res,
    request,
    MIDDLEWARE_DUR_HEADER,
    (performance.now() - mwStart).toFixed(1),
  );
  return res;
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
