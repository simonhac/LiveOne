/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.BUILD_DIR || ".next",
  async rewrites() {
    return [
      // Tesla Fleet API fetches the partner public key from this well-known path.
      // Served by app/api/tesla/public-key (app-router support for a literal
      // dot-prefixed `.well-known` folder is unreliable, so rewrite instead).
      {
        source: "/.well-known/appspecific/com.tesla.3p.public-key.pem",
        destination: "/api/tesla/public-key",
      },
      // ── COMPATIBILITY SHIM WITH AN EXPIRY — delete in a later cleanup ──────────────
      // config-v4 Phase 13 PR 4 moved `/api/system/*` -> `/api/device/*` and
      // `/api/systems/*` -> `/api/devices/*`. A deploy does NOT reload already-open
      // browser tabs, so the previous JS bundle stays live in them and keeps calling the
      // OLD paths until someone refreshes. Without these, that window 404s — and the case
      // that actually matters is an open SHARED DASHBOARD on a share token, whose viewer
      // is anonymous and cannot be told to hit reload. (Same hazard class as the reason
      // `QueueMessage.systemId` was NOT renamed: a rolling deploy runs two builds at once.)
      //
      // REWRITES, not redirects: a rewrite preserves method and body, so an in-flight
      // PATCH/POST from a stale bundle still lands. These are `afterFiles` (the default),
      // so they can never shadow a real route — they only catch paths that no longer exist.
      //
      // 🛑 Paired with the legacy `"/api/system/(.*)"` entry in `lib/route-matchers.ts`:
      // middleware runs BEFORE rewrites and sees the ORIGINAL path, so without that entry
      // an anonymous share-token viewer on a legacy URL gets Clerk's edge 404 instead of
      // data. Delete both halves together.
      //
      // All three moved API trees are covered. The moved PAGE (`/admin/systems` ->
      // `/admin/devices`) deliberately is NOT: a page URL is navigated freshly rather than
      // called by a stale bundle, and it is admin-only, so the one person who can reach it
      // can reload. The admin API tree IS covered, because an already-open `/admin/systems`
      // tab's bundle keeps fetching it.
      { source: "/api/system/:path*", destination: "/api/device/:path*" },
      { source: "/api/systems/:path*", destination: "/api/devices/:path*" },
      {
        source: "/api/admin/systems/:path*",
        destination: "/api/admin/devices/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
