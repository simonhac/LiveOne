/**
 * The usher runtime — loads usher.yaml, builds the scheduled entries, and runs the collector loop.
 * Started once when the Next.js server boots (see ../instrumentation.ts) or by the CLI (../cli.ts).
 *
 * Holds the built entries in a module singleton so the inspector (SSE route) can read each source's
 * live snapshot() + last-tick state independently of the push cadence.
 *
 * Also owns the on-disk store: the blackbox journal + outage spool live under `dataDir`
 * (usher.yaml `dataDir` → $USHER_DATA_DIR → ./.usher-data), with a 5-min maintenance timer
 * (compress rolled days, GC to the free-space floor, refresh inspector stats). A missing/broken
 * dir degrades the store — never the collector.
 */

import path from "node:path";
import { loadConfig } from "./config";
import { buildEntries, type UsherStore } from "./factory";
import { runLoop, type ScheduledEntry } from "./run";
import { Blackbox } from "./blackbox";
import { Spool } from "./spool";
import { recordTick, recordDelivery, getTickState } from "../state/usher-state";
import { registry } from "../state/registry";
import {
  createHeartbeat,
  resolveHeartbeatUrl,
  type Heartbeat,
} from "./heartbeat";
import { createWatchdog } from "./watchdog";
import { startDrainer } from "./drainer";
import { createCourier } from "./courier";

const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
/**
 * Log loudly once a source has failed this many ticks back-to-back. Four, because that is the size
 * of the smaller of the two self-recovering episodes that preceded the 2026-09-11 wedge — the
 * warning we had and could not see. Not an alert: the heartbeat is the alarm. This is the forensic
 * breadcrumb that says which device to look at, and when it started.
 */
const DEGRADED_TICKS = 4;

/** The scheduled entries the usher is running (empty until startUsher() has built them). */
export function getEntries(): ScheduledEntry[] {
  return registry.entries;
}

export function isStarted(): boolean {
  return registry.started;
}

/** The shared on-disk store (undefined until startUsher() has built it). */
export function getStore(): UsherStore | undefined {
  return registry.store;
}

export interface StartUsherOptions {
  configPath?: string;
  /** run one tick per source then resolve (CLI --once); default runs forever */
  once?: boolean;
  log?: (m: string) => void;
}

/** Resolve the store root: usher.yaml dataDir → $USHER_DATA_DIR → ./.usher-data. */
export function resolveDataDir(configDataDir?: string): string {
  return configDataDir ?? process.env.USHER_DATA_DIR ?? ".usher-data";
}

async function buildStore(
  dataDir: string,
  log: (m: string) => void,
): Promise<UsherStore> {
  const blackbox = await Blackbox.create(path.join(dataDir, "blackbox"), {
    log,
  });
  const spool = await Spool.create(path.join(dataDir, "spool"), { log });
  log(
    `usher: store at ${dataDir} (blackbox ${blackbox ? "on" : "OFF"}, spool ${spool ? "on" : "OFF"})`,
  );
  return { dataDir, blackbox, spool };
}

/**
 * Start the usher: load config → build store + entries → run. Idempotent for the long-running case
 * (a second call while already running is a no-op) so it's safe to invoke from Next.js
 * instrumentation.
 */
export async function startUsher(opts: StartUsherOptions = {}): Promise<void> {
  const log =
    opts.log ??
    ((m: string) => console.log(`${new Date().toISOString()} ${m}`));

  if (registry.started && !opts.once) {
    log("usher: already started");
    return;
  }
  registry.started = true;

  const config = loadConfig(opts.configPath);
  log(`usher: ${config.sources.length} source(s) → ${config.gushEndpoint}`);

  const store = await buildStore(resolveDataDir(config.dataDir), log);
  registry.store = store;
  registry.entries = buildEntries(config, log, store);

  // Register + resume the run supervisors (control-enabled sources). resume() is fire-and-forget:
  // it may need the device (defensive fn 33 / mode check) and the device may be unreachable at
  // boot — that must not delay the collector. Its own logging is loud when something is wrong.
  registry.supervisors.clear();
  for (const entry of registry.entries) {
    if (entry.supervisor) {
      registry.supervisors.set(entry.source.siteId, entry.supervisor);
      void entry.supervisor.resume().catch((e) => {
        log(
          `[control] resume failed for ${entry.source.siteId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
  }

  // Periodic upkeep: roll+compress the blackbox, GC to the free-space floor, refresh stats.
  // unref() so CLI --once / tests can exit without clearing it.
  const maintenance = setInterval(() => {
    void store.blackbox?.maintain();
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref?.();

  // Per-site dead-man's-switch. Built from config (not the entries) because the URL is named by the
  // yaml and resolved from env — sites without one simply have no heartbeat.
  const heartbeats = new Map<string, Heartbeat>();
  for (const sc of config.sources) {
    const url = resolveHeartbeatUrl(sc.heartbeatUrlEnv);
    if (!url) continue;
    heartbeats.set(
      sc.siteId,
      createHeartbeat({ url, log: (m) => log(`[${sc.siteId}] ${m}`) }),
    );
  }
  log(
    `usher: heartbeat ${heartbeats.size ? `on for ${[...heartbeats.keys()].join(", ")}` : "OFF (no *_HEARTBEAT_URL configured)"}`,
  );

  // Long-running background services. Skipped for --once, which must return promptly.
  if (!opts.once) {
    // One courier per site takes the push off the poll loop's critical path: the tick reads,
    // journals and hands off, so a slow or failing receiver can no longer cost us readings (it
    // cost ~45 through the 2026-09-11 outage). Not attached for --once, which wants the push
    // outcome back synchronously.
    for (const entry of registry.entries) {
      const siteId = entry.source.siteId;
      entry.courier = createCourier({
        siteId,
        store: (readings, meta) => entry.pusher.store(readings, meta),
        spool: entry.spool,
        log: (m) => log(`[${siteId}] ${m}`),
        onResult: ({ job, outcome, spooled }) => {
          recordDelivery(siteId, outcome, spooled);
          heartbeats.get(siteId)?.onDelivery({
            outcome,
            hasDeviceReadings: job.hasDeviceReadings,
          });
        },
      });
    }

    // Recovers the on-disk backlog independently of the poll loops AND of the couriers — so a
    // wedged or crashed loop can no longer strand batches that are already safely spooled.
    startDrainer(registry.entries, { log });
  }

  const watchdog = createWatchdog({ log: (m) => log(m) });
  for (const e of registry.entries) {
    watchdog.register(e.source.siteId, e.activeIntervalMs ?? e.intervalMs);
  }
  if (!opts.once) watchdog.start();

  // recordTick feeds the inspector's per-source state; snapshots come from each source directly.
  await runLoop(registry.entries, {
    once: opts.once,
    log,
    onTickStart: (entry) => watchdog.noteTickStart(entry.source.siteId),
    onTick: (entry, result) => {
      recordTick(entry, result);
      // The heartbeat is driven by the COURIER's result, not by the tick — with delivery off the
      // critical path the tick genuinely does not know yet whether the receiver took the batch.
      const st = getTickState(entry.source.siteId);
      // Every DEGRADED_TICKS in a row, not just the first — a run that keeps growing keeps saying so.
      if (
        st &&
        st.consecutiveErrors > 0 &&
        st.consecutiveErrors % DEGRADED_TICKS === 0
      ) {
        log(
          `[${entry.source.name}] ⚠ ${st.consecutiveErrors} consecutive failed ticks — last error: ${st.lastError}`,
        );
      }
    },
  });
}
