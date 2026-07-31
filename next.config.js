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

module.exports = nextConfig;
