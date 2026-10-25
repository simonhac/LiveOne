/**
 * Device staleness alerts: six messages as an outage begins, then one a day — never one every
 * 15 min for the days a device takes to reach. A new outage starts again from the top.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { DeviceHealth } from "@/lib/monitoring/device-staleness";

const store = new Map<string, number | string>();
let kvDown = false;
jest.mock("@/lib/kv", () => ({
  kv: {
    incr: async (k: string) => {
      if (kvDown) throw new Error("kv down");
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    },
    expire: async () => 1,
    set: async (k: string, v: string, o: { nx?: boolean }) => {
      if (o.nx && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
  },
  kvKey: (p: string) => `test:${p}`,
}));

import { claimDeviceAlert } from "../device-alerts";

const LAST_SUCCESS = 1_792_000_000_000;
const stale = (lastSuccessMs: number | null = LAST_SUCCESS): DeviceHealth => ({
  rid: 14,
  name: "Daylesford Generator",
  vendor: "deepsea",
  code: "device_poll_stale",
  staleMin: 4542,
  lastSuccessMs,
  budgetMin: 20,
  consecutiveErrors: 0,
  message: "",
});

/** The outcome of `n` consecutive monitor ticks. */
const ticks = async (n: number, d = stale()) => {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(await claimDeviceAlert(d));
  return out;
};

/** What the 24 h TTL does in production: the repeat key lapses. */
const aDayPasses = () => {
  for (const k of [...store.keys()]) if (k.endsWith(":repeat")) store.delete(k);
};

beforeEach(() => {
  store.clear();
  kvDown = false;
});

describe("claimDeviceAlert", () => {
  it("alerts on the first six ticks of an outage, then goes quiet", async () => {
    expect(await ticks(10)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("alerts once a day after the onset burst", async () => {
    await ticks(10);
    aDayPasses();
    expect(await ticks(3)).toEqual([true, false, false]);
  });

  it("keys the outage on its last success, so a new outage alerts at once", async () => {
    await ticks(10);
    expect(await ticks(1, stale(LAST_SUCCESS + 3_600_000))).toEqual([true]);
  });

  it("fails open when KV is unavailable", async () => {
    kvDown = true;
    expect(await ticks(8)).toEqual(Array(8).fill(true));
  });
});
