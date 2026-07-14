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
import { recordTick } from "../state/usher-state";
import { registry } from "../state/registry";

const MAINTENANCE_INTERVAL_MS = 5 * 60_000;

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

  // Periodic upkeep: roll+compress the blackbox, GC to the free-space floor, refresh stats.
  // unref() so CLI --once / tests can exit without clearing it.
  const maintenance = setInterval(() => {
    void store.blackbox?.maintain();
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref?.();

  // recordTick feeds the inspector's per-source state; snapshots come from each source directly.
  await runLoop(registry.entries, { once: opts.once, log, onTick: recordTick });
}
