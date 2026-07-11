/**
 * The usher runtime — loads usher.yaml, builds the scheduled entries, and runs the collector loop.
 * Started once when the Next.js server boots (see ../instrumentation.ts) or by the CLI (../cli.ts).
 *
 * Holds the built entries in a module singleton so the inspector (SSE route) can read each source's
 * live snapshot() + last-tick state independently of the push cadence.
 */

import { loadConfig } from "./config";
import { buildEntries } from "./factory";
import { runLoop, type ScheduledEntry } from "./run";
import { recordTick } from "../state/usher-state";
import { registry } from "../state/registry";

/** The scheduled entries the usher is running (empty until startUsher() has built them). */
export function getEntries(): ScheduledEntry[] {
  return registry.entries;
}

export function isStarted(): boolean {
  return registry.started;
}

export interface StartUsherOptions {
  configPath?: string;
  /** run one tick per source then resolve (CLI --once); default runs forever */
  once?: boolean;
  log?: (m: string) => void;
}

/**
 * Start the usher: load config → build entries → run. Idempotent for the long-running case (a second
 * call while already running is a no-op) so it's safe to invoke from Next.js instrumentation.
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
  registry.entries = buildEntries(config, log);
  // recordTick feeds the inspector's per-source state; snapshots come from each source directly.
  await runLoop(registry.entries, { once: opts.once, log, onTick: recordTick });
}
