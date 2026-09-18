import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

/**
 * The `lib/kv` command counter.
 *
 * It exists because Upstash bills per COMMAND while `@vercel/kv` enables auto-pipelining by default:
 * commands issued in the same microtask become ONE HTTP request but N billed commands. So a network
 * trace, an HTTP request count and the Upstash latency graph all understate what a code path costs,
 * and the Proxy in `lib/kv.ts` is the only place every command provably passes through.
 *
 * This is the instrument for answering "what does this path actually cost?" — the question behind
 * `updateLatestPointValues`, where the per-point form billed 3 commands per point while looking like
 * a single round trip.
 *
 * `@vercel/kv` is mocked here so the counted calls never reach the network: the subject is the
 * counting wrapper, not the client. (`kv-lazy-credentials.test.ts` covers the real client's lazy
 * credential resolution.)
 */
const hset = jest
  .fn<(key: string, fields: Record<string, unknown>) => Promise<number>>()
  .mockResolvedValue(1);
const get = jest
  .fn<(key: string) => Promise<unknown>>()
  .mockResolvedValue(null);

jest.mock("@vercel/kv", () => ({
  createClient: () => ({ hset, get }),
}));

describe("lib/kv command counting", () => {
  const saved = {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.KV_REST_API_URL = "https://example-kv.upstash.io";
    process.env.KV_REST_API_TOKEN = "test-token";
  });

  afterEach(() => {
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.token === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.token;
  });

  it("tallies commands by name while armed", async () => {
    const { kv, startKvCommandCount, stopKvCommandCount } = await import(
      "../kv"
    );

    startKvCommandCount();
    await kv.hset("k", { a: 1 });
    await kv.hset("k", { b: 2 });
    await kv.get("j");

    expect(stopKvCommandCount()).toEqual({
      total: 3,
      byCommand: { hset: 2, get: 1 },
    });
  });

  it("counts nothing before arming or after stopping", async () => {
    const { kv, startKvCommandCount, stopKvCommandCount } = await import(
      "../kv"
    );

    await kv.get("before");

    startKvCommandCount();
    await kv.get("during");
    const armed = stopKvCommandCount();

    // A method reference captured while armed must not keep writing into a tally already taken.
    await kv.get("after");

    expect(armed).toEqual({ total: 1, byCommand: { get: 1 } });
    expect(stopKvCommandCount()).toEqual({ total: 0, byCommand: {} });
  });

  it("still forwards arguments and the result while counting", async () => {
    const { kv, startKvCommandCount, stopKvCommandCount } = await import(
      "../kv"
    );
    get.mockResolvedValueOnce({ hello: "world" });

    startKvCommandCount();
    await expect(kv.get("some-key")).resolves.toEqual({ hello: "world" });
    stopKvCommandCount();

    expect(get).toHaveBeenCalledWith("some-key");
  });
});
