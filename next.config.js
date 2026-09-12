/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.BUILD_DIR || ".next",
  // 🛑 `@touch4it/ical-timezones` reads its zone data with
  // `fs.readFileSync(path.join(__dirname, "zones", …))` and swallows the failure in an EMPTY
  // CATCH, returning null. A dynamic read like that is invisible to Next's static tracing, so the
  // .ics files were left out of the serverless bundle and the calendar feed shipped with no
  // VTIMEZONE component at all — silently, because the package cannot report what it discarded.
  // Without it a strict client cannot resolve the `TZID=` on every DTSTART in that feed.
  outputFileTracingIncludes: {
    "/api/v4/areas/[id]/calendar.ics": [
      "./node_modules/@touch4it/ical-timezones/zones/**",
    ],
  },
  async rewrites() {
    return [
      // Tesla Fleet API fetches the partner public key from this well-known path.
      // Served by app/api/tesla/public-key (app-router support for a literal
      // dot-prefixed `.well-known` folder is unreliable, so rewrite instead).
      {
        source: "/.well-known/appspecific/com.tesla.3p.public-key.pem",
        destination: "/api/tesla/public-key",
      },
    ];
  },
};

// Opt-in only: `ANALYZE=true npm run analyze` opens the treemap. Inert (and the plugin is never
// loaded) for every normal build, including Vercel's.
const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
  openAnalyzer: false, // write the HTML; don't hijack a browser (and don't hang CI/agents)
});

module.exports = withBundleAnalyzer(nextConfig);
