/**
 * In-memory inspector state — per-source last-tick health, updated by the run-loop's `onTick` hook.
 * Backed by the process-global registry (state/registry.ts) so the run-loop (instrumentation context)
 * and the routes (request context) share one map.
 */

import type { ScheduledEntry, TickResult } from "../core/run";
import { registry, type SourceTickState } from "./registry";

export type { SourceTickState };

/** Run-loop `onTick` hook: fold a tick result into the per-source state. */
export function recordTick(_entry: ScheduledEntry, r: TickResult): void {
  const prev = registry.tickStates.get(r.siteId);
  registry.tickStates.set(r.siteId, {
    siteId: r.siteId,
    name: r.name,
    lastTickAt: r.at,
    lastCount: r.count,
    running: r.active,
    pushOk: r.pushOk,
    lastError: r.error ?? prev?.lastError,
    lastErrorAt: r.error ? r.at : prev?.lastErrorAt,
  });
}

export function getTickState(siteId: string): SourceTickState | undefined {
  return registry.tickStates.get(siteId);
}
