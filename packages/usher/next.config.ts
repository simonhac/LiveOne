import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output → a self-contained `node server.js` bundle for the Fly image / Pi.
  output: "standalone",
  // The usher lives in a monorepo; trace files from the workspace root so standalone bundling works.
  outputFileTracingRoot: __dirname + "/../..",
  // Shared wire types are consumed type-only, but transpile the package to be safe if a value import
  // is ever added.
  transpilePackages: ["@liveone/protocol"],
  // modbus-serial is a native/optional-dep-laden library — keep it external to the server bundle so
  // it's require()d from node_modules at runtime rather than traced/bundled.
  serverExternalPackages: ["modbus-serial"],
};

export default nextConfig;
