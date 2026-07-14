/**
 * Source factory — turns a validated `usher.yaml` source entry into a live `Source` + its
 * `ScheduledEntry` (source + pusher + cadence). This is the only place that maps a config `type` to a
 * concrete source implementation.
 */

import type { Source } from "./source";
import type { ScheduledEntry } from "./run";
import { Pusher } from "./pusher";
import type { Blackbox } from "./blackbox";
import type { Spool } from "./spool";
import { createMusher } from "../sources/musher";
import { createFusher } from "../sources/fusher";
import type { SourceConfig, UsherConfig } from "./config";

/** The shared on-disk store (built once in startUsher; null members = degraded/disabled). */
export interface UsherStore {
  dataDir: string;
  blackbox: Blackbox | null;
  spool: Spool | null;
}

/** Build the live Source for one config entry (no pusher — used by --dry and by buildEntries). */
export function createSource(
  sc: SourceConfig,
  log: (m: string) => void,
): Source {
  switch (sc.type) {
    case "deepsea":
      return createMusher({
        siteId: sc.siteId,
        host: sc.host,
        port: sc.port,
        unitId: sc.unitId,
        log: (m) => log(`[${sc.siteId}/musher] ${m}`),
      });
    case "fronius":
      return createFusher({
        siteId: sc.siteId,
        inverters: sc.inverters,
        invPollMs: sc.invPollSec * 1000,
        log: (m) => log(`[${sc.siteId}/fusher] ${m}`),
      });
  }
}

/** Push cadence for a source. deepsea: idle/active poll==push; fronius: fixed push (2 s poll is internal). */
function cadenceFor(sc: SourceConfig): {
  intervalMs: number;
  activeIntervalMs?: number;
} {
  if (sc.type === "deepsea") {
    return {
      intervalMs: sc.pollSec * 1000,
      activeIntervalMs: (sc.activeSec ?? sc.pollSec) * 1000,
    };
  }
  return { intervalMs: sc.pushSec * 1000 };
}

/** Resolve a source's gusher apiKey from the named env var (secrets stay out of usher.yaml). */
export function resolveApiKey(apiKeyEnv: string): string {
  const key = process.env[apiKeyEnv];
  if (!key) {
    throw new Error(`usher: missing API key — env var ${apiKeyEnv} is not set`);
  }
  return key;
}

/** Build the full set of scheduled entries (source + pusher + cadence + shared store) for the run-loop. */
export function buildEntries(
  config: UsherConfig,
  log: (m: string) => void,
  store?: UsherStore,
): ScheduledEntry[] {
  return config.sources.map((sc) => {
    const source = createSource(sc, log);
    const pusher = new Pusher({
      endpoint: config.gushEndpoint,
      siteId: sc.siteId,
      apiKey: resolveApiKey(sc.apiKeyEnv),
      log: (m) => log(`[${sc.siteId}] ${m}`),
    });
    const { intervalMs, activeIntervalMs } = cadenceFor(sc);
    return {
      source,
      pusher,
      blackbox: store?.blackbox ?? null,
      spool: store?.spool ?? null,
      intervalMs,
      activeIntervalMs,
      alignToBoundary: true,
    };
  });
}
