/**
 * Process-global usher registry.
 *
 * Next.js may instantiate a module more than once (the instrumentation bundle vs the request-handling
 * server bundle), so a plain module-level `let` set by instrumentation is NOT visible to route
 * handlers. We stash the shared state on `globalThis` — one instance per Node process — so the
 * run-loop (started in instrumentation) and the SSE/JSON routes see the same entries + tick states.
 */

import type { ScheduledEntry } from "../core/run";
import type { UsherStore } from "../core/factory";

export interface SourceTickState {
  siteId: string;
  name: string;
  /** ISO time of the most recent tick */
  lastTickAt?: string;
  /** readings pushed last tick (0 = all n/a, null = error) */
  lastCount?: number | null;
  /** whether the source reported itself running/active last tick */
  running: boolean;
  /** whether the last push succeeded (undefined = nothing pushed) */
  pushOk?: boolean;
  /** most recent error message (sticky until the next error) + when it happened */
  lastError?: string;
  lastErrorAt?: string;
}

interface UsherRegistry {
  entries: ScheduledEntry[];
  started: boolean;
  tickStates: Map<string, SourceTickState>;
  /** the shared on-disk store (blackbox + spool), set by startUsher */
  store?: UsherStore;
}

const g = globalThis as unknown as { __usherRegistry?: UsherRegistry };
g.__usherRegistry ??= { entries: [], started: false, tickStates: new Map() };

export const registry: UsherRegistry = g.__usherRegistry;
