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
import { RunSupervisor } from "./control";
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
  dataDir?: string,
): Source {
  switch (sc.type) {
    case "deepsea":
      return createMusher({
        siteId: sc.siteId,
        host: sc.host,
        port: sc.port,
        unitId: sc.unitId,
        log: (m) => log(`[${sc.siteId}/musher] ${m}`),
        dataDir,
        enableControl: sc.control != null,
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

/**
 * Cadences for a source.
 *
 * deepsea: POLL (= read + diagnostic journal) and PUSH (= deliver to gusher) are independent. Both
 * default to `pollSec`, which reproduces the old poll==push behaviour, so a config that sets
 * neither `pushSec` nor `activePushSec` is unaffected by the split.
 *
 * fronius: `pushSec` is the only cadence the run-loop sees — the 2 s inverter poll is internal to
 * the Site, so its poll interval is its push interval as far as this layer is concerned.
 */
function cadenceFor(sc: SourceConfig): {
  intervalMs: number;
  activeIntervalMs?: number;
  pushIntervalMs?: number;
  activePushIntervalMs?: number;
  transitionIntervalMs?: number;
} {
  if (sc.type === "deepsea") {
    const pushSec = sc.pushSec ?? sc.pollSec;
    return {
      intervalMs: sc.pollSec * 1000,
      activeIntervalMs: (sc.activeSec ?? sc.pollSec) * 1000,
      pushIntervalMs: pushSec * 1000,
      activePushIntervalMs: (sc.activePushSec ?? pushSec) * 1000,
      // The transition bracket raises poll AND push together — the one cadence that does. 0 leaves
      // it undefined, which the run loop reads as "no bracket".
      transitionIntervalMs: sc.transitionSec * 1000 || undefined,
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
    const source = createSource(sc, log, store?.dataDir);
    const pusher = new Pusher({
      endpoint: config.gushEndpoint,
      siteId: sc.siteId,
      apiKey: resolveApiKey(sc.apiKeyEnv),
      log: (m) => log(`[${sc.siteId}] ${m}`),
    });
    // Control-enabled deepsea sources get a RunSupervisor — the hub-side deadline owner. Note the
    // passkey env is NOT resolved here: a missing control secret must degrade the control route,
    // never brick the collector (unlike resolveApiKey above, which throws by design).
    const supervisor =
      sc.type === "deepsea" && sc.control && source.control
        ? new RunSupervisor({
            siteId: sc.siteId,
            target: source.control,
            config: sc.control,
            dataDir: store?.dataDir ?? null,
            log,
          })
        : null;
    // Spread, don't destructure: naming the fields here means every cadence added to `cadenceFor`
    // has to be repeated in a second place, and forgetting drops it SILENTLY — the loop just falls
    // back to its default and nothing errors. That is exactly how the push cadences were lost on
    // their first deploy.
    return {
      source,
      pusher,
      blackbox: store?.blackbox ?? null,
      spool: store?.spool ?? null,
      supervisor,
      ...cadenceFor(sc),
      alignToBoundary: true,
    };
  });
}
