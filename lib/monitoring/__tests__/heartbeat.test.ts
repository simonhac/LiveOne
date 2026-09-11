/**
 * The serverless heartbeat. Its contract is narrow but load-bearing: it must never be able to fail
 * a cron run, and it must be awaited (a Vercel function is frozen on return, so an un-awaited ping
 * is dropped — which would read as a dead collector while the collector was fine).
 */

import { describe, it, expect, jest } from "@jest/globals";
import { pingHeartbeat, collectorHeartbeatUrl } from "../heartbeat";

const okFetch = (calls: string[]) =>
  (async (url: string) => {
    calls.push(String(url));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

describe("pingHeartbeat", () => {
  it("posts to the url and reports success", async () => {
    const calls: string[] = [];
    const ok = await pingHeartbeat("https://uptime.example/hb/abc", {
      fetchImpl: okFetch(calls),
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(["https://uptime.example/hb/abc"]);
  });

  // Unset = this deployment has no heartbeat. Dev and preview must not ping production's.
  it("is a silent no-op when unconfigured", async () => {
    const calls: string[] = [];
    const ok = await pingHeartbeat(undefined, { fetchImpl: okFetch(calls) });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports a non-2xx as a failed ping without throwing", async () => {
    const logs: string[] = [];
    const ok = await pingHeartbeat("https://uptime.example/hb/abc", {
      fetchImpl: (async () =>
        new Response(null, { status: 404 })) as unknown as typeof fetch,
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    expect(logs.join()).toMatch(/rejected with 404/);
  });

  // The one absolute requirement: monitoring must not be able to break collection.
  it("never throws when the network fails", async () => {
    const logs: string[] = [];
    await expect(
      pingHeartbeat("https://uptime.example/hb/abc", {
        fetchImpl: (() =>
          Promise.reject(new Error("ENOTFOUND"))) as unknown as typeof fetch,
        log: (m) => logs.push(m),
      }),
    ).resolves.toBe(false);
    expect(logs.join()).toMatch(/ping failed: ENOTFOUND/);
  });

  // A hung receiver must not hold the cron open. We can only assert our half of that contract —
  // that a timeout-bearing AbortSignal is handed to fetch — since honouring it is fetch's job.
  it("bounds the request with an abort signal", async () => {
    let signal: AbortSignal | undefined;
    await pingHeartbeat("https://uptime.example/hb/abc", {
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it("resolves false when the request is aborted", async () => {
    const ok = await pingHeartbeat("https://uptime.example/hb/abc", {
      // Stand in for what fetch does on abort: reject with an AbortError.
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        await new Promise((_r, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          ),
        );
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
      log: () => {},
    });
    expect(ok).toBe(false);
  }, 10_000);
});

describe("collectorHeartbeatUrl", () => {
  it("is undefined when the env var is unset or empty", () => {
    const prev = process.env.COLLECTOR_HEARTBEAT_URL;
    try {
      delete process.env.COLLECTOR_HEARTBEAT_URL;
      expect(collectorHeartbeatUrl()).toBeUndefined();
      process.env.COLLECTOR_HEARTBEAT_URL = "";
      expect(collectorHeartbeatUrl()).toBeUndefined();
      process.env.COLLECTOR_HEARTBEAT_URL = "https://uptime.example/hb/xyz";
      expect(collectorHeartbeatUrl()).toBe("https://uptime.example/hb/xyz");
    } finally {
      if (prev === undefined) delete process.env.COLLECTOR_HEARTBEAT_URL;
      else process.env.COLLECTOR_HEARTBEAT_URL = prev;
    }
  });
});
