"use client";

/**
 * The app's only React error boundary, at the ROOT segment.
 *
 * Deliberately not scoped to `app/dashboard/` — `/device/[...slug]` mounts the same temporal
 * navigator, and `/admin`, `/areas` and `/labs` are equally capable of throwing during render.
 * Sitting here it renders INSIDE `app/layout.tsx`, so the fonts, ClerkProvider, Providers and the
 * <Toaster> all survive; only the page's own subtree is replaced.
 *
 * Before this existed, one unparseable query param blanked the entire document with Next's generic
 * "Application error: a client-side exception has occurred".
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle } from "lucide-react";

const BUTTON_CLASS =
  "px-3 py-1.5 text-sm font-medium border rounded-lg bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white transition-none";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const isDev = process.env.NODE_ENV === "development";

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg">
        {/* Same amber vocabulary as the "Area/Device unavailable" panels in the dashboard, so an
            error reads as part of the app rather than as a browser failure. */}
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
          <div className="min-w-0">
            <p className="font-medium text-amber-200">Something went wrong</p>
            <p className="mt-0.5 text-amber-200/70">
              This page hit an unexpected error. Trying again usually clears it
              — if the link came from somewhere else, it may be pointing at
              something that no longer exists.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={reset} className={BUTTON_CLASS}>
            Try again
          </button>
          {/* `reset()` re-renders the same tree from the same URL, so for anything caused BY the URL
              it throws again immediately. This is the affordance that breaks that loop. `?access` is
              kept: it is the share-link credential, not a filter — dropping it would turn a broken
              page into an inaccessible one for exactly the anonymous viewer who needs this button. */}
          <button
            onClick={() => {
              const access = new URLSearchParams(window.location.search).get(
                "access",
              );
              // A hard load, not `router.replace`: a soft navigation leaves this boundary's error
              // state in place, so the panel just sits there over the fixed URL. This is the
              // last-resort button — a clean document is exactly what it should give you.
              window.location.replace(
                access
                  ? `${pathname}?access=${encodeURIComponent(access)}`
                  : pathname,
              );
            }}
            className={BUTTON_CLASS}
          >
            Reload without filters
          </button>
          <Link href="/dashboard" className={BUTTON_CLASS}>
            Back to dashboard
          </Link>
        </div>

        {isDev ? (
          <pre className="mt-4 max-h-64 overflow-auto rounded-lg border border-gray-700/50 bg-gray-900/50 p-3 text-xs text-gray-400 whitespace-pre-wrap">
            {error.stack ?? error.message}
          </pre>
        ) : (
          // Next strips the message in production and gives only a digest — surfacing it is the
          // difference between an actionable bug report and "it broke".
          error.digest && (
            <p className="mt-4 text-xs text-gray-500">
              Reference: {error.digest}
            </p>
          )
        )}
      </div>
    </div>
  );
}
