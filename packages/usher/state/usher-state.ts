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
    // A queued tick says NOTHING about delivery — the courier has not reported yet. Taking
    // `r.pushOk` (undefined) here would wipe the last real delivery outcome on every single tick,
    // including a failure the operator needs to see.
    pushOk: r.queued ? prev?.pushOk : r.pushOk,
    lastError: r.error ?? prev?.lastError,
    lastErrorAt: r.error ? r.at : prev?.lastErrorAt,
    // Delivery state belongs to the courier; a tick must carry it forward untouched rather than
    // rebuild it away.
    lastPushError: prev?.lastPushError,
    lastPushErrorAt: prev?.lastPushErrorAt,
    // A tick with no error clears the run, whatever else it reported.
    consecutiveErrors: r.error ? (prev?.consecutiveErrors ?? 0) + 1 : 0,
  });
}

/**
 * Fold a DELIVERY outcome into the per-source state.
 *
 * Separate from recordTick because delivery is no longer part of the tick: the courier reports the
 * receiver's answer whenever it arrives, which may be many seconds after the tick that collected
 * the batch returned. Collection health and delivery health are genuinely two different questions
 * now, and the inspector should not pretend otherwise.
 */
export function recordDelivery(
  siteId: string,
  outcome: "ok" | "transient" | "rejected",
  spooled?: boolean,
): void {
  const prev = registry.tickStates.get(siteId);
  if (!prev) return;
  const error =
    outcome === "ok"
      ? undefined
      : outcome === "transient"
        ? spooled
          ? "push failed (batch spooled for re-send)"
          : "push failed (spool unavailable — batch dropped)"
        : "push rejected by receiver (4xx) — batch dropped";
  registry.tickStates.set(siteId, {
    ...prev,
    pushOk: outcome === "ok",
    lastPushError: error,
    lastPushErrorAt: error ? new Date().toISOString() : prev.lastPushErrorAt,
  });
}

export function getTickState(siteId: string): SourceTickState | undefined {
  return registry.tickStates.get(siteId);
}
