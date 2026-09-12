// This suite must never inherit shared dev/prod service configuration.
const url = new URL(process.env.GOUSHER_TEST_DATABASE_URL || "http://missing");
if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/gousher_test")) {
  throw new Error(
    "Run tools/integration.sh with its private disposable PostgreSQL cluster",
  );
}
process.env.PLANETSCALE_DATABASE_URL = url.toString();
process.env.DB_SSL = "disable";
process.env.NODE_ENV = "test";
for (const key of Object.keys(process.env)) {
  if (
    /^(KV_|UPSTASH_|QSTASH_|CLERK_|NEXT_PUBLIC_CLERK_|OBSERVATIONS_|COLLECTOR_HEARTBEAT)/.test(
      key,
    )
  )
    delete process.env[key];
}
