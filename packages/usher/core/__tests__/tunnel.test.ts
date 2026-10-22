/**
 * The connect-failure diagnosis: which side of the site router the fault is on, from the hub's own
 * WireGuard handshake times — and no guess at all when those cannot be read.
 */

import { describe, it, expect } from "@jest/globals";
import {
  createTunnelProbe,
  describeConnectFailure,
  diagnoseConnectError,
} from "../tunnel";
import { DeviceConnectError } from "../../lib/connect-error";

const NOW = 1_792_634_000_000;
const KEY = "T2FTArfDyoC18cMa8lug02t9E8wX2xh6+EiUddSAaE4=";
const env = { SHEEPHOUSE_PEER_PUBKEY: KEY };

function probe(out: string | Error, calls = { n: 0 }) {
  return createTunnelProbe({
    env,
    now: () => NOW,
    wgShow: async () => {
      calls.n++;
      if (out instanceof Error) throw out;
      return out;
    },
  });
}

const unreach = new DeviceConnectError(
  "connect EHOSTUNREACH 10.0.1.244:502",
  "10.0.1.244",
  502,
  "EHOSTUNREACH",
);

describe("createTunnelProbe", () => {
  it("reads the site's peer handshake by <SITE>_PEER_PUBKEY", async () => {
    const hs = await probe(`${KEY}\t${NOW / 1000 - 40}\nother=\t0\n`).handshake(
      "sheephouse",
    );
    expect(hs).toEqual({ atMs: NOW - 40_000, ageSec: 40, fresh: true });
  });

  it("calls a handshake older than 3 min stale, and 0 never", async () => {
    expect(
      (await probe(`${KEY}\t${NOW / 1000 - 600}`).handshake("sheephouse"))
        ?.fresh,
    ).toBe(false);
    expect(await probe(`${KEY}\t0`).handshake("sheephouse")).toEqual({
      atMs: null,
      ageSec: null,
      fresh: false,
    });
  });

  it("is unknown (null) without wg, without the env key, or without the peer", async () => {
    expect(
      await probe(new Error("spawn wg ENOENT")).handshake("sheephouse"),
    ).toBeNull();
    expect(await probe(`${KEY}\t1`).handshake("kinkora")).toBeNull();
    expect(await probe(`someone-else\t1`).handshake("sheephouse")).toBeNull();
  });

  it("caches the wg read", async () => {
    const calls = { n: 0 };
    const p = probe(`${KEY}\t${NOW / 1000}`, calls);
    await p.handshake("sheephouse");
    await p.handshake("sheephouse");
    expect(calls.n).toBe(1);
  });
});

describe("describeConnectFailure", () => {
  const fresh = { atMs: NOW - 30_000, ageSec: 30, fresh: true };

  it("fresh + EHOSTUNREACH: VPN up, controller off the LAN", () => {
    expect(describeConnectFailure(unreach, "sheephouse", fresh)).toBe(
      "VPN to sheephouse is up (handshake 30s ago), but the site router cannot reach the controller at 10.0.1.244 — is it powered and on the network? (connect EHOSTUNREACH 10.0.1.244:502)",
    );
  });

  it("fresh + ECONNREFUSED: host answered, Modbus refused", () => {
    const e = new DeviceConnectError(
      "connect ECONNREFUSED",
      "10.0.1.244",
      502,
      "ECONNREFUSED",
    );
    expect(describeConnectFailure(e, "sheephouse", fresh)).toMatch(
      /answered, but refused Modbus on port 502/,
    );
  });

  it("fresh + timeout: VPN up, controller silent", () => {
    const e = new DeviceConnectError(
      "TCP connect to 10.0.1.244:502 timed out after 5000ms",
      "10.0.1.244",
      502,
      "ETIMEDOUT",
    );
    expect(describeConnectFailure(e, "sheephouse", fresh)).toMatch(
      /is up .* but the controller at 10.0.1.244 did not answer/,
    );
  });

  it("stale or never: VPN down, whatever the errno", () => {
    expect(
      describeConnectFailure(unreach, "sheephouse", {
        atMs: NOW - 3_600_000,
        ageSec: 3600,
        fresh: false,
      }),
    ).toMatch(/^VPN to sheephouse is down — last WireGuard handshake 20\d\d-/);
    expect(
      describeConnectFailure(unreach, "sheephouse", {
        atMs: null,
        ageSec: null,
        fresh: false,
      }),
    ).toMatch(/has not completed a WireGuard handshake/);
  });

  it("unknown: the bare error, no guess", () => {
    expect(describeConnectFailure(unreach, "sheephouse", null)).toBe(
      unreach.message,
    );
  });
});

describe("diagnoseConnectError", () => {
  it("leaves anything but a connect failure untouched", async () => {
    const other = new Error("read exceeded 28000ms");
    expect(await diagnoseConnectError(other, "sheephouse", probe(""))).toBe(
      other,
    );
  });

  it("keeps the errno on the diagnosed error", async () => {
    const out = (await diagnoseConnectError(
      unreach,
      "sheephouse",
      probe(`${KEY}\t${NOW / 1000 - 10}`),
    )) as DeviceConnectError;
    expect(out.code).toBe("EHOSTUNREACH");
    expect(out.message).toMatch(/^VPN to sheephouse is up/);
  });
});
