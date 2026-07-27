import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

/**
 * Regression: `lib/kv.ts` must resolve KV credentials LAZILY (first property access), never at
 * import time.
 *
 * `import`s are hoisted and evaluated before a module body runs, so any script that calls
 * `dotenv.config()` in its body — `scripts/config-v4/*`, `rebuild-dev-kv-from-db.ts` — imports
 * `lib/kv` BEFORE .env.local is loaded. When the credentials were read at import time, `kvClient`
 * latched to `null` for the lifetime of the process and every kv.* call became the silent no-op
 * Proxy, even though the caller's own `process.env.KV_REST_API_URL` guard (running after dotenv)
 * saw the vars and passed.
 *
 * Why that is dangerous rather than merely annoying: the failure is SILENT and self-confirming. A
 * writer no-ops, then reads its own value back as `null` through the same Proxy and agrees with
 * itself, so the script reports success having done nothing. `db:rebuild-dev-kv` would report a
 * rebuilt cache while leaving KV empty. (Found the hard way during the config-v4 cutover
 * rehearsal, where the same latch made a "pause cleared ✅" report while the flag was still set.)
 */
describe("lib/kv credential resolution", () => {
  const saved = {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.token === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.token;
  });

  it("picks up credentials set AFTER import (the dotenv-in-module-body ordering)", async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;

    // Import with the env deliberately unset — this is what dotenv-using scripts really do.
    const { kv } = await import("../kv");

    // ...then the script body runs dotenv.config() and the credentials appear.
    process.env.KV_REST_API_URL = "https://example-kv.upstash.io";
    process.env.KV_REST_API_TOKEN = "test-token";

    // A live client exposes real methods. The degraded Proxy hands back a no-op thunk for EVERY
    // property, so `kv.set` and `kv.someMethodThatDoesNotExist` would be indistinguishable.
    const live = kv as unknown as Record<string, unknown>;
    expect(typeof live.set).toBe("function");
    expect(live.__definitelyNotAKvMethod__).toBeUndefined();
  });

  it("still degrades to a no-op client when credentials are genuinely absent", async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;

    const { kv } = await import("../kv");

    // No credentials ever appear -> every property is the no-op thunk, resolving to null.
    await expect(
      (kv as unknown as { get: (k: string) => Promise<unknown> }).get("k"),
    ).resolves.toBeNull();
  });
});
