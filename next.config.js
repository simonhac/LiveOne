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
