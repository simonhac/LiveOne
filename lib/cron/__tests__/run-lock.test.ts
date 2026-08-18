/**
 * The minutely cron's overlap lease.
 *
 * The subtle case, and the reason this file exists: `SET … NX` returns null when the key already
 * exists — the same value `lib/kv.ts`'s no-op proxy returns when KV isn't configured at all. Reading
 * null as "no KV, proceed unlocked" silently disables the lock in exactly the situation it is meant
 * to catch, and nothing downstream would ever notice.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";

const set = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const get = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const del = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.mock("@/lib/kv", () => ({
  kv: { set, get, del },
  kvKey: (p: string) => `test:${p}`,
}));

import { acquireCronLease } from "../run-lock";

const withKv = () => {
  process.env.KV_REST_API_URL = "https://kv.test";
  process.env.KV_REST_API_TOKEN = "tok";
};

afterEach(() => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  set.mockReset();
  get.mockReset();
  del.mockReset();
});

describe("acquireCronLease", () => {
  it("grants the lease when the key was free", async () => {
    withKv();
    set.mockResolvedValue("OK");
    const lease = await acquireCronLease("minutely", "run-1");
    expect(lease).not.toBeNull();
    expect(set).toHaveBeenCalledWith("test:cron:lease:minutely", "run-1", {
      nx: true,
      ex: 90,
    });
  });

  it("REFUSES when another run holds it — null means held, not unavailable", async () => {
    withKv();
    set.mockResolvedValue(null);
    expect(await acquireCronLease("minutely", "run-2")).toBeNull();
  });

  it("proceeds unlocked when KV is not configured", async () => {
    // No credentials set. Must not even attempt the call, or the no-op proxy's null would be
    // indistinguishable from "held".
    const lease = await acquireCronLease("minutely", "run-3");
    expect(lease).not.toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it("fails OPEN when KV errors — a polling outage is worse than a double poll", async () => {
    withKv();
    set.mockRejectedValue(new Error("kv down"));
    expect(await acquireCronLease("minutely", "run-4")).not.toBeNull();
  });

  it("releases only its OWN lease", async () => {
    withKv();
    set.mockResolvedValue("OK");
    get.mockResolvedValue("someone-else");
    const lease = await acquireCronLease("minutely", "run-5");
    await lease!.release();
    // A run that overran its TTL must not delete the lease its successor now holds.
    expect(del).not.toHaveBeenCalled();

    get.mockResolvedValue("run-5");
    await lease!.release();
    expect(del).toHaveBeenCalledWith("test:cron:lease:minutely");
  });

  it("survives a failed release — the TTL is the backstop", async () => {
    withKv();
    set.mockResolvedValue("OK");
    get.mockRejectedValue(new Error("kv down"));
    const lease = await acquireCronLease("minutely", "run-6");
    await expect(lease!.release()).resolves.toBeUndefined();
  });
});
