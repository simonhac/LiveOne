/**
 * "Is it the VPN, or is it the controller?" — answered from the hub's own WireGuard state.
 *
 * A failed Modbus connect used to end in a guess: "— is the Teleport VPN up?". That guess was wrong
 * for three days in October 2026, when both WireGuard peers handshook every couple of minutes and
 * the sheephouse router answered EHOSTUNREACH for the controller 19,000 times: the tunnel was fine,
 * the DSE had no power. The hub could have said so all along — it holds the one fact that separates
 * the two cases, the time of each peer's latest handshake.
 *
 * What a fresh handshake proves, and no more: the site router is up and talking to the hub. It says
 * nothing about the LAN behind the router, which is exactly why it splits the cases cleanly — a
 * stale handshake means the link is down; a fresh one moves the fault past the router.
 *
 * Peers are mapped to sites by key, from the env the entrypoint already builds wg0.conf from
 * (`SHEEPHOUSE_PEER_PUBKEY`, `KINKORA_PEER_PUBKEY` — i.e. `<SITEID>_PEER_PUBKEY`). Off Fly (dev,
 * tests, a Pi without `wg`) every lookup is `null`, and the caller says what it saw without a guess.
 */

import { execFile } from "node:child_process";
import { DeviceConnectError } from "../lib/connect-error";

/** UDM keepalive is 25 s and WireGuard re-handshakes every ~2 min under traffic; 3 min is stale. */
const STALE_AFTER_SEC = 180;
const CACHE_MS = 10_000;
const EXEC_TIMEOUT_MS = 2_000;

export interface PeerHandshake {
  /** epoch ms of the latest handshake; null = this peer has never completed one */
  atMs: number | null;
  ageSec: number | null;
  fresh: boolean;
}

export type WgShow = () => Promise<string>;

const realWgShow: WgShow = () =>
  new Promise((resolve, reject) => {
    execFile(
      "wg",
      ["show", "wg0", "latest-handshakes"],
      { timeout: EXEC_TIMEOUT_MS },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/** `wg show wg0 latest-handshakes` → pubkey → epoch seconds (0 = never). */
function parseHandshakes(out: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of out.split("\n")) {
    const [key, at] = line.trim().split(/\s+/);
    if (key && at && /^\d+$/.test(at)) m.set(key, Number(at));
  }
  return m;
}

export interface TunnelProbeOptions {
  wgShow?: WgShow;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * A per-process handshake reader. Cached for 10 s because a tick error and a stop retry can ask
 * within the same second, and `wg` is a process spawn.
 */
export function createTunnelProbe(opts: TunnelProbeOptions = {}) {
  const wgShow = opts.wgShow ?? realWgShow;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  let cache: { atMs: number; map: Map<string, number> | null } | null = null;

  async function table(): Promise<Map<string, number> | null> {
    if (cache && now() - cache.atMs < CACHE_MS) return cache.map;
    let map: Map<string, number> | null;
    try {
      map = parseHandshakes(await wgShow());
    } catch {
      map = null; // no `wg`, no wg0, not root: "unknown", never an error of its own
    }
    cache = { atMs: now(), map };
    return map;
  }

  return {
    /** The site's peer handshake, or null when it cannot be known. */
    async handshake(siteId: string): Promise<PeerHandshake | null> {
      const key = env[`${siteId.toUpperCase()}_PEER_PUBKEY`];
      if (!key) return null;
      const map = await table();
      if (!map || !map.has(key)) return null;
      const sec = map.get(key)!;
      if (sec === 0) return { atMs: null, ageSec: null, fresh: false };
      const ageSec = Math.max(0, Math.round((now() - sec * 1000) / 1000));
      return { atMs: sec * 1000, ageSec, fresh: ageSec < STALE_AFTER_SEC };
    },
  };
}

export type TunnelProbe = ReturnType<typeof createTunnelProbe>;

/**
 * One sentence that says which side of the router the fault is on. The connect error itself is
 * kept in brackets at the end — it is the evidence, and the diagnosis is only as good as it.
 */
export function describeConnectFailure(
  err: DeviceConnectError,
  siteId: string,
  hs: PeerHandshake | null,
): string {
  const evidence = `(${err.message})`;
  if (!hs) return err.message;
  if (!hs.fresh) {
    return hs.atMs == null
      ? `VPN to ${siteId} is down — its router has not completed a WireGuard handshake since the hub started ${evidence}`
      : `VPN to ${siteId} is down — last WireGuard handshake ${new Date(hs.atMs).toISOString()} ${evidence}`;
  }
  const up = `VPN to ${siteId} is up (handshake ${hs.ageSec}s ago)`;
  switch (err.code) {
    case "EHOSTUNREACH":
    case "EHOSTDOWN":
      return `${up}, but the site router cannot reach the controller at ${err.host} — is it powered and on the network? ${evidence}`;
    case "ECONNREFUSED":
      return `${up} and ${err.host} answered, but refused Modbus on port ${err.port} ${evidence}`;
    default:
      return `${up}, but the controller at ${err.host} did not answer ${evidence}`;
  }
}

/** If `e` is a connect failure, the diagnosed sentence as a new Error; otherwise `e` untouched. */
export async function diagnoseConnectError(
  e: unknown,
  siteId: string,
  probe: TunnelProbe,
): Promise<unknown> {
  if (!(e instanceof DeviceConnectError)) return e;
  const hs = await probe.handshake(siteId).catch(() => null);
  return new DeviceConnectError(
    describeConnectFailure(e, siteId, hs),
    e.host,
    e.port,
    e.code,
  );
}
